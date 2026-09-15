import { z } from "zod";
import { artKeyOf, artUrlAt, artUrlResizable } from "@shared/artUrl";
import { artThumb, fetchOrigin, TIERS } from "../../lookups/artThumbs";
import {
  type MediaNode,
  trackArtists,
  formatLabel,
  albumTracksOf,
  albumSummary,
  trackPosition,
  artistSummary,
  HIRES_BITS_ABOVE,
  HIRES_RATE_ABOVE,
  describeProfileNote,
  nameSortKey,
} from "@shared/model";
import {
  audioAnalysisKey,
  albumDrKey,
  playKey,
  LOSSLESS_CODECS,
  isHiRes,
  LARGE_QUEUE_TRACKS,
} from "@shared/model";
import { audioAnalysisGet, albumDrMap } from "../../lookups/audioAnalysis";
import { playStatsFromRecord } from "../../data/playStats";
import { LargeQueueError, queueAdd, refreshServers } from "../../media/upnpBrowser";
import {
  searchServer as librarySearch,
  status as indexStatus,
  pools as indexPools,
  ensureFresh as indexEnsureFresh,
  rebuild as indexRebuild,
} from "../../media/mediaIndex";
import {
  type ToolContext,
  type ToolImpl,
  ok,
  err,
  kindOf,
  QUEUE_MODES,
  largeQueueAsk,
  freshObjectId,
} from "./toolkit";

// The MCP bridge's library tools (the library: servers, browsing, the lenses' lists, search and
// the index), one of six tool modules split out of mcpServer.ts 2026-09-13; the shapes and helpers
// they share live in ./toolkit.

export function libraryTools(ctx: ToolContext): Record<string, ToolImpl> {
  const { dm } = ctx;
  return {
    // ---- library
    rebuild_library_index: {
      inputSchema: {
        server_udn: z
          .string()
          .describe("Which server to index (see list_media_servers for udn + index state)."),
      },
      handler: async (a) => {
        const s = ctx.connected();
        const servers = await refreshServers(s.connection.host);
        const server = servers.find((x) => x.udn === (a.server_udn as string));
        if (!server) return err(`No media server with udn ${a.server_udn as string}.`);
        // Browse-only servers (a streamer's USB drive) never index
        // themselves — this is the ONLY way to make them searchable, which
        // is why an agent needs it: list_media_servers can already SEE that
        // an index is missing, and could do nothing about it.
        await indexRebuild(s.connection.host, server);
        // build() is a NO-OP while a build is already in flight — listing
        // servers nudges Tier A builds, so awaiting rebuild can return
        // mid-crawl. Wait for it to settle, and if it is still going, SAY so
        // instead of reporting zeros as though they were the answer.
        const statusOf = ():
          { state: string; albums: number; artists: number; tracks: number } | undefined => {
          const x = indexStatus().find((y) => y.udn === (a.server_udn as string));
          return x
            ? {
                state: x.state,
                albums: x.albums ?? 0,
                artists: x.artists ?? 0,
                tracks: x.tracks ?? 0,
              }
            : undefined;
        };
        const deadline = Date.now() + 45_000;
        let st = statusOf();
        while (st?.state === "building" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 400));
          st = statusOf();
        }
        if (st?.state === "building")
          return ok({
            server: server.name,
            state: "building",
            note: "Still indexing — call list_media_servers in a little while for the counts.",
          });
        return ok({
          server: server.name,
          state: st?.state ?? "unknown",
          albums: st?.albums ?? 0,
          artists: st?.artists ?? 0,
          tracks: st?.tracks ?? 0,
        });
      },
    },
    list_media_servers: {
      handler: async () => {
        const s = ctx.connected();
        const servers = await refreshServers(s.connection.host);
        // same freshness semantics as the app's Library screen: listing
        // servers nudges Tier A index builds in the background (gated on
        // the user's auto-index setting inside ensureFresh)
        indexEnsureFresh(s.connection.host, servers);
        const stats = new Map(indexStatus().map((x) => [x.udn, x]));
        return ok(
          servers.map((x) => {
            const st = stats.get(x.udn);
            const ready = st?.state === "ready";
            return {
              udn: x.udn,
              name: x.name,
              model: x.model,
              is_streamer_usb: x.isStreamer,
              searchable: x.searchable,
              index_ready: ready,
              ...(st?.state === "failed" ? { index_failed: st.failure ?? "no index" } : {}),
              // library counts, so "how many albums do I have" is one call
              ...(ready && st
                ? {
                    index: {
                      albums: st.albums,
                      artists: st.artists,
                      tracks: st.tracks,
                      built_at: st.builtAt != null ? new Date(st.builtAt).toISOString() : null,
                      // how the index was built and every reconciliation that changed something —
                      // the SHAPE of the server's answers, so an agent can explain what it sees
                      ...(st.profile
                        ? {
                            built_by: st.profile.strategy,
                            albums_from: st.profile.albumsFrom,
                            class_search: st.profile.classSearch,
                            notes: st.profile.notes.map(describeProfileNote),
                          }
                        : {}),
                    },
                  }
                : {}),
            };
          }),
        );
      },
    },
    search_library: {
      inputSchema: {
        query: z.string().min(1).describe("Album, artist, or track name (partial matches ok)."),
        server_udn: z
          .string()
          .optional()
          .describe(
            "Limit to one server (see list_media_servers); omit to search every eligible server.",
          ),
        kind: z.enum(["album", "artist", "track"]).optional().describe("Only return this kind."),
        match: z
          .enum(["any", "title"])
          .optional()
          .describe(
            "'title' = only items whose OWN title contains the query (e.g. songs with 'love' in the track title). Default 'any' — title, artist, or album.",
          ),
        limit: z.number().int().min(1).max(200).optional().describe("Default 40."),
        offset: z.number().int().min(0).optional().describe("For paging; default 0."),
      },
      handler: async (a) => {
        const s = ctx.connected();
        const ready = new Set(
          indexStatus()
            .filter((x) => x.state === "ready")
            .map((x) => x.udn),
        );
        // Eligible = answers live Search OR has a ready local index (the
        // app's own rule) — a Browse-only USB stick with a built index
        // is searchable here too.
        let servers = (await refreshServers(s.connection.host)).filter(
          (x) => x.searchable || ready.has(x.udn),
        );
        if (typeof a.server_udn === "string") {
          servers = servers.filter((x) => x.udn === a.server_udn);
          if (servers.length === 0) {
            return err(
              `No searchable or indexed media server with udn '${a.server_udn}'. Use list_media_servers.`,
            );
          }
        }
        if (servers.length === 0) return err("No searchable media servers are visible right now.");
        // Ready indexes answer from memory (every match retrieved, true
        // totals) — the only real cost is tokens, which limit/offset
        // govern. The LAN-protection cap that matters is on live SOAP:
        // at most 3 un-indexed servers per query, each already bounded
        // by the ContentDirectory search's own 500-result ceiling.
        const fleet = [
          ...servers.filter((x) => ready.has(x.udn)),
          ...servers.filter((x) => !ready.has(x.udn)).slice(0, 3),
        ];
        const tokens = (a.query as string).toLowerCase().split(/\s+/).filter(Boolean);
        const collected: unknown[] = [];
        let sourceCapped = false;
        for (const server of fleet) {
          const { items, total } = await librarySearch(
            s.connection.host,
            server.udn,
            a.query as string,
          );
          if (total > items.length) sourceCapped = true;
          for (const n of items) {
            const kind = kindOf(n);
            if (kind === "folder") continue;
            if (a.kind != null && kind !== a.kind) continue;
            if (a.match === "title") {
              const title = n.title.toLowerCase();
              if (!tokens.every((t) => title.includes(t))) continue;
            }
            collected.push({
              server_udn: server.udn,
              server: server.name,
              object_id: n.id,
              kind,
              title: n.title,
              // a folder server's path to it, from the root (2026-09-14; the index records it)
              ...(n.titlePath?.length ? { folder: n.titlePath } : {}),
              artist: n.artist,
              album: n.album,
              year: n.year,
              duration_seconds: n.durationSecs,
              // what the DIDL knows beyond the packed artist string (2026-08-16)
              ...(n.albumArtist ? { album_artist: n.albumArtist } : {}),
              ...(n.artists ? { performers: n.artists } : {}),
              ...(n.composers ? { composers: n.composers } : {}),
              ...(n.format ? { format: formatLabel(n.format) } : {}),
            });
          }
        }
        const offset = (a.offset as number | undefined) ?? 0;
        const limit = (a.limit as number | undefined) ?? 40;
        const page = collected.slice(offset, offset + limit);
        return ok({
          total: collected.length,
          offset,
          returned: page.length,
          ...(sourceCapped
            ? {
                note: "A source hit its internal retrieval cap — total covers only what it returned.",
              }
            : {}),
          results: page,
        });
      },
    },
    list_albums: {
      inputSchema: {
        artist: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on the album artist."),
        genre: z
          .string()
          .optional()
          .describe("Case-insensitive genre, e.g. 'Rock' (results list each album's genres)."),
        decade: z.string().optional().describe("e.g. '1990s' (or just '1990')."),
        kind: z
          .enum(["all", "albums", "compilations"])
          .optional()
          .describe(
            "Default 'all'. 'compilations' = various-artists albums (album artist 'Various Artists' or credited to no performer on it); 'albums' excludes them.",
          ),
        hires: z
          .boolean()
          .optional()
          .describe(
            `true = only albums with any track above ${HIRES_BITS_ABOVE}-bit or ${HIRES_RATE_ABOVE / 1000} kHz.`,
          ),
        format: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring of the album's format headline or any track's, e.g. 'FLAC', '24/96', 'MP3'.",
          ),
        composer: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on any track's composers."),
        server_udn: z.string().optional().describe("Limit to one server (see list_media_servers)."),
        lossless: z
          .boolean()
          .optional()
          .describe("true = only albums whose every track is lossless (FLAC, ALAC, WAV, …)."),
        min_dr: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe(
            "Only albums whose recorded dynamic range (DR, whole album analyzed) is at least this; albums without one are excluded.",
          ),
        sort: z
          .enum(["title", "artist", "year", "dr", "loudness"])
          .optional()
          .describe(
            "Default 'title'; 'year' sorts newest first; 'dr' most dynamic first, unanalyzed last; 'loudness' loudest first (integrated LUFS), unmeasured last.",
          ),
        limit: z.number().int().min(1).max(100).optional().describe("Default 40."),
        offset: z.number().int().min(0).optional().describe("For paging; default 0."),
      },
      // Purely index-backed (the lenses' feedstock) — works even while the
      // streamer itself is off, so no connected() gate.
      handler: (a) => {
        const groups = indexPools().filter((p) => a.server_udn == null || p.udn === a.server_udn);
        if (groups.length === 0) {
          return err(
            a.server_udn != null
              ? `No ready index for server '${String(a.server_udn)}'. Use list_media_servers.`
              : ctx.kickIndex(),
          );
        }
        const artistNeedle = (a.artist as string | undefined)?.toLowerCase();
        const genreNeedle = (a.genre as string | undefined)?.toLowerCase();
        const decade = a.decade != null ? String(a.decade).replace(/s$/i, "") : null;
        let albums = groups.flatMap((p) => p.albums);
        if (artistNeedle != null)
          albums = albums.filter((n) => n.artist?.toLowerCase().includes(artistNeedle));
        if (genreNeedle != null)
          albums = albums.filter((n) =>
            (n.genre ?? []).some((g) => g.toLowerCase() === genreNeedle),
          );
        if (decade != null)
          albums = albums.filter(
            (n) => n.year != null && String(Math.floor(Number(n.year) / 10) * 10) === decade,
          );
        // Each album's tracks, summed once (the same derivations the album
        // leaf, the lens and the Info modal use — albumTracksOf/albumSummary):
        // the filters below and the per-album fields both read this map.
        const poolOf = new Map(groups.map((p) => [p.udn, p]));
        const summaries = new Map<
          string,
          { tracks: MediaNode[]; sum: ReturnType<typeof albumSummary> }
        >();
        const summaryFor = (
          n: MediaNode,
        ): { tracks: MediaNode[]; sum: ReturnType<typeof albumSummary> } => {
          const key = `${n.serverUdn}|${n.id}`;
          let hit = summaries.get(key);
          if (!hit) {
            const pool = n.serverUdn ? poolOf.get(n.serverUdn) : undefined;
            const tracks = pool ? albumTracksOf(n, pool) : [];
            hit = { tracks, sum: albumSummary(n, tracks) };
            summaries.set(key, hit);
          }
          return hit;
        };
        const kind = (a.kind as string | undefined) ?? "all";
        if (kind === "compilations") albums = albums.filter((n) => summaryFor(n).sum.isCompilation);
        else if (kind === "albums") albums = albums.filter((n) => !summaryFor(n).sum.isCompilation);
        if (a.hires === true) albums = albums.filter((n) => summaryFor(n).sum.hires);
        // the analysis round's facets (0.7.0): the album's recorded DR, all-lossless
        const drMap = albumDrMap();
        const albumDr = (n: MediaNode): number | null => drMap[albumDrKey(n)]?.dr ?? null;
        const albumLufs = (n: MediaNode): number | null => drMap[albumDrKey(n)]?.lufs ?? null;
        if (a.lossless === true)
          albums = albums.filter((n) => {
            const { tracks } = summaryFor(n);
            return (
              tracks.length > 0 &&
              tracks.every((t) => LOSSLESS_CODECS.has((t.format?.codec ?? "").toUpperCase()))
            );
          });
        if (a.min_dr != null) {
          const min = a.min_dr as number;
          albums = albums.filter((n) => (albumDr(n) ?? -1) >= min);
        }
        const formatNeedle = (a.format as string | undefined)?.toLowerCase();
        if (formatNeedle != null)
          albums = albums.filter((n) => {
            const { tracks, sum } = summaryFor(n);
            return (
              (sum.format ?? "").toLowerCase().includes(formatNeedle) ||
              tracks.some((t) => (formatLabel(t.format) ?? "").toLowerCase().includes(formatNeedle))
            );
          });
        const composerNeedle = (a.composer as string | undefined)?.toLowerCase();
        if (composerNeedle != null)
          albums = albums.filter((n) =>
            summaryFor(n).tracks.some((t) =>
              (t.composers ?? []).some((c) => c.toLowerCase().includes(composerNeedle)),
            ),
          );
        const sort = (a.sort as string | undefined) ?? "title";
        albums.sort((x, y) => {
          if (sort === "artist")
            return (
              nameSortKey(x.artist ?? "￿").localeCompare(nameSortKey(y.artist ?? "￿")) ||
              x.title.localeCompare(y.title)
            );
          if (sort === "year")
            return (y.year ?? "").localeCompare(x.year ?? "") || x.title.localeCompare(y.title);
          if (sort === "dr")
            return (albumDr(y) ?? -1) - (albumDr(x) ?? -1) || x.title.localeCompare(y.title);
          if (sort === "loudness")
            return (
              (albumLufs(y) ?? -1000) - (albumLufs(x) ?? -1000) || x.title.localeCompare(y.title)
            );
          return x.title.localeCompare(y.title);
        });
        const offset = (a.offset as number | undefined) ?? 0;
        const limit = (a.limit as number | undefined) ?? 40;
        const page = albums.slice(offset, offset + limit);
        return ok({
          total: albums.length,
          offset,
          returned: page.length,
          albums: page.map((n) => {
            const { sum } = summaryFor(n);
            return {
              server_udn: n.serverUdn,
              server: n.serverName,
              object_id: n.id,
              title: n.title,
              ...(n.titlePath?.length ? { folder: n.titlePath } : {}),
              artist: n.artist,
              year: n.year,
              genres: n.genre ?? [],
              // summed from the album's tracks (2026-08-16): what the app's
              // album header shows
              tracks: sum.tracks,
              ...(sum.discs > 1 ? { discs: sum.discs } : {}),
              runtime_seconds: sum.runtimeSecs,
              ...(sum.sizeBytes > 0 ? { size_bytes: sum.sizeBytes } : {}),
              ...(sum.format ? { format: sum.format } : {}),
              ...(sum.formatOdd > 0 ? { format_tracks_differ: sum.formatOdd } : {}),
              hires: sum.hires,
              ...(albumDr(n) != null ? { dr: albumDr(n) } : {}),
              ...(sum.composers.length > 0 ? { composers: sum.composers } : {}),
              is_compilation: sum.isCompilation,
            };
          }),
        });
      },
    },
    list_artists: {
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on the artist name."),
        role: z
          .enum(["performers", "composers"])
          .optional()
          .describe(
            "Default 'performers' (album artists and every performer, featured guests included). 'composers' lists who WROTE the tracks (upnp:artist role=Composer), with track and album counts.",
          ),
        server_udn: z.string().optional().describe("Limit to one server (see list_media_servers)."),
        sort: z
          .enum(["name", "albums"])
          .optional()
          .describe("Default 'name' (A–Z); 'albums' sorts by album count, most first."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 100."),
        offset: z.number().int().min(0).optional().describe("For paging; default 0."),
      },
      // index-backed like list_albums — no connected() gate
      handler: (a) => {
        const groups = indexPools().filter((p) => a.server_udn == null || p.udn === a.server_udn);
        if (groups.length === 0) {
          return err(
            a.server_udn != null
              ? `No ready index for server '${String(a.server_udn)}'. Use list_media_servers.`
              : ctx.kickIndex(),
          );
        }
        // Derive from the album/track pools (like the Artists lens): albums
        // and tracks grouped by normalized artist name, first-seen casing.
        const byName = new Map<string, { name: string; albums: number; tracks: number }>();
        const bump = (artist: string | null, field: "albums" | "tracks"): void => {
          if (!artist?.trim()) return;
          const k = artist.trim().toLowerCase();
          const cur = byName.get(k) ?? { name: artist.trim(), albums: 0, tracks: 0 };
          cur[field]++;
          byName.set(k, cur);
        };
        const role = (a.role as string | undefined) ?? "performers";
        if (role === "composers") {
          // composers: tracks they wrote, and the distinct albums those sit on
          const albumsOf = new Map<string, Set<string>>();
          for (const p of groups)
            for (const t of p.tracks)
              for (const cname of t.composers ?? []) {
                bump(cname, "tracks");
                const k = cname.trim().toLowerCase();
                const set = albumsOf.get(k) ?? new Set<string>();
                if (t.album) set.add(`${p.udn}|${t.album.toLowerCase()}`);
                albumsOf.set(k, set);
              }
          for (const [k, cur] of byName) cur.albums = albumsOf.get(k)?.size ?? 0;
        } else {
          for (const p of groups) {
            for (const alb of p.albums) bump(alb.artist, "albums");
            // every PERFORMER, not the packed "A; B" string (featured tracks)
            for (const t of p.tracks) for (const name of trackArtists(t)) bump(name, "tracks");
          }
        }
        const needle = (a.query as string | undefined)?.toLowerCase();
        let artists = [...byName.values()];
        if (needle != null) artists = artists.filter((x) => x.name.toLowerCase().includes(needle));
        const sort = (a.sort as string | undefined) ?? "name";
        artists.sort((x, y) =>
          sort === "albums"
            ? y.albums - x.albums || nameSortKey(x.name).localeCompare(nameSortKey(y.name))
            : nameSortKey(x.name).localeCompare(nameSortKey(y.name)),
        );
        const offset = (a.offset as number | undefined) ?? 0;
        const limit = (a.limit as number | undefined) ?? 100;
        const page = artists.slice(offset, offset + limit);
        return ok({ total: artists.length, offset, returned: page.length, artists: page });
      },
    },
    list_tracks: {
      inputSchema: {
        artist: z
          .string()
          .optional()
          .describe("Case-insensitive substring on the track's performers."),
        album: z.string().optional().describe("Case-insensitive substring on the album title."),
        genre: z.string().optional().describe("Case-insensitive genre."),
        decade: z.string().optional().describe("e.g. '1990s'."),
        format: z
          .string()
          .optional()
          .describe("Case-insensitive substring of the format label, e.g. 'FLAC', '24/96', 'MP3'."),
        lossless: z.boolean().optional().describe("true = lossless codecs only."),
        hires: z
          .boolean()
          .optional()
          .describe(`true = above ${HIRES_BITS_ABOVE}-bit or ${HIRES_RATE_ABOVE / 1000} kHz.`),
        min_dr: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe(
            "Only tracks with a recorded DR at least this; unanalyzed tracks are excluded.",
          ),
        sort: z
          .enum([
            "title",
            "artist",
            "album",
            "year",
            "duration",
            "dr",
            "loudness",
            "plays",
            "last_played",
          ])
          .optional()
          .describe(
            "Default 'title'. 'plays' most played first; 'last_played' most recent first; 'dr' most dynamic first; 'duration' longest first.",
          ),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
        offset: z.number().int().min(0).optional().describe("For paging; default 0."),
        server_udn: z.string().optional().describe("Limit to one server (see list_media_servers)."),
      },
      handler: async (a) => {
        const groups = indexPools().filter((p) => a.server_udn == null || p.udn === a.server_udn);
        if (groups.length === 0)
          return err(
            a.server_udn != null
              ? `No ready index for server '${String(a.server_udn)}'. Use list_media_servers.`
              : ctx.kickIndex(),
          );
        const lc = (v: string | null | undefined): string => (v ?? "").toLowerCase();
        const artistNeedle = (a.artist as string | undefined)?.toLowerCase();
        const albumNeedle = (a.album as string | undefined)?.toLowerCase();
        const genreNeedle = (a.genre as string | undefined)?.toLowerCase();
        const decade = a.decade != null ? String(a.decade).replace(/s$/i, "") : null;
        const formatNeedle = (a.format as string | undefined)?.toLowerCase();
        const drOf = (t: MediaNode): number | null => {
          const an = audioAnalysisGet(audioAnalysisKey(t));
          return an && an.dr > 0 ? an.dr : null;
        };
        const lufsOf = (t: MediaNode): number | null =>
          audioAnalysisGet(audioAnalysisKey(t))?.lufs ?? null;
        let tracks = groups.flatMap((p) => p.tracks);
        if (artistNeedle != null)
          tracks = tracks.filter(
            (t) =>
              trackArtists(t).some((n) => n.toLowerCase().includes(artistNeedle)) ||
              lc(t.artist).includes(artistNeedle),
          );
        if (albumNeedle != null) tracks = tracks.filter((t) => lc(t.album).includes(albumNeedle));
        if (genreNeedle != null)
          tracks = tracks.filter((t) =>
            (t.genre ?? []).some((g) => g.toLowerCase() === genreNeedle),
          );
        if (decade != null)
          tracks = tracks.filter(
            (t) => t.year != null && String(Math.floor(Number(t.year) / 10) * 10) === decade,
          );
        if (formatNeedle != null)
          tracks = tracks.filter(
            (t) =>
              (formatLabel(t.format) ?? "").toLowerCase().includes(formatNeedle) ||
              lc(t.format?.codec).includes(formatNeedle),
          );
        if (a.lossless === true)
          tracks = tracks.filter((t) => LOSSLESS_CODECS.has((t.format?.codec ?? "").toUpperCase()));
        if (a.hires === true) tracks = tracks.filter((t) => (t.format ? isHiRes(t.format) : false));
        if (a.min_dr != null) {
          const min = a.min_dr as number;
          tracks = tracks.filter((t) => (drOf(t) ?? -1) >= min);
        }
        const stats = await playStatsFromRecord();
        const statOf = (t: MediaNode) => stats.tracks[playKey(t.title, t.artist, t.album)] ?? null;
        const sort = (a.sort as string | undefined) ?? "title";
        const byTitle = (x: MediaNode, y: MediaNode): number =>
          x.title.localeCompare(y.title) || lc(x.artist).localeCompare(lc(y.artist));
        const byAlbum = (x: MediaNode, y: MediaNode): number =>
          lc(x.album).localeCompare(lc(y.album)) ||
          (trackPosition(x) ?? 0) - (trackPosition(y) ?? 0) ||
          byTitle(x, y);
        tracks = [...tracks].sort((x, y) => {
          if (sort === "artist")
            return (
              nameSortKey(x.artist ?? "￿").localeCompare(nameSortKey(y.artist ?? "￿")) ||
              byAlbum(x, y)
            );
          if (sort === "album") return byAlbum(x, y);
          if (sort === "year") return (y.year ?? "").localeCompare(x.year ?? "") || byAlbum(x, y);
          if (sort === "duration")
            return (y.durationSecs ?? 0) - (x.durationSecs ?? 0) || byTitle(x, y);
          if (sort === "dr") return (drOf(y) ?? -1) - (drOf(x) ?? -1) || byTitle(x, y);
          if (sort === "loudness")
            return (lufsOf(y) ?? -1000) - (lufsOf(x) ?? -1000) || byTitle(x, y);
          if (sort === "plays")
            return (statOf(y)?.plays ?? 0) - (statOf(x)?.plays ?? 0) || byTitle(x, y);
          if (sort === "last_played")
            return (statOf(y)?.lastAt ?? 0) - (statOf(x)?.lastAt ?? 0) || byTitle(x, y);
          return byTitle(x, y);
        });
        const offset = (a.offset as number | undefined) ?? 0;
        const limit = (a.limit as number | undefined) ?? 50;
        const page = tracks.slice(offset, offset + limit);
        return ok({
          total: tracks.length,
          offset,
          returned: page.length,
          tracks: page.map((t) => {
            const st = statOf(t);
            const dr = drOf(t);
            return {
              server_udn: t.serverUdn,
              object_id: t.id,
              title: t.title,
              artist: t.artist,
              album: t.album,
              year: t.year,
              ...(t.trackNumber != null ? { track_number: t.trackNumber } : {}),
              duration_seconds: t.durationSecs,
              ...(formatLabel(t.format) ? { format: formatLabel(t.format) } : {}),
              ...(dr != null ? { dr } : {}),
              plays: st?.plays ?? 0,
              last_played: st ? new Date(st.lastAt).toISOString() : null,
            };
          }),
        });
      },
    },
    get_track_analysis: {
      inputSchema: {
        title: z
          .string()
          .optional()
          .describe("A track title in the library; omit for the playing track."),
        artist: z.string().optional(),
        album: z.string().optional(),
      },
      handler: (a) => {
        const lc = (v: string | null | undefined): string => (v ?? "").toLowerCase();
        let t:
          | (Pick<MediaNode, "title" | "artist" | "album" | "durationSecs"> & {
              albumArtist?: string | null;
            })
          | null = null;
        if (a.title) {
          const title = lc(a.title as string);
          t =
            indexPools()
              .flatMap((p) => p.tracks)
              .find(
                (n) =>
                  lc(n.title) === title &&
                  (!a.artist || lc(n.artist).includes(lc(a.artist as string))) &&
                  (!a.album || lc(n.album).includes(lc(a.album as string))),
              ) ?? null;
          if (!t)
            return err(
              `No indexed track titled "${String(a.title)}". Use list_tracks or search_library.`,
            );
        } else {
          const md = dm.snapshot().playState?.metadata;
          if (!md?.title) return err("Nothing is playing and no track was named.");
          t = { title: md.title, artist: md.artist, album: md.album, durationSecs: md.duration };
        }
        const an = audioAnalysisGet(audioAnalysisKey(t));
        const albumEntry = t.album
          ? (albumDrMap()[albumDrKey({ title: t.album, artist: t.albumArtist ?? t.artist })] ??
            null)
          : null;
        const albumDr = albumEntry?.dr ?? null;
        return ok({
          track: { title: t.title, artist: t.artist, album: t.album },
          analyzed: an != null,
          ...(an
            ? {
                dr: an.dr > 0 ? an.dr : null,
                peak_db: an.peakDb,
                rms_db: an.rmsDb,
                crest_db: an.crestDb,
                lufs: an.lufs ?? null,
                loudness_range_lu: an.lra ?? null,
                true_peak_dbtp: an.truePeakDb ?? null,
              }
            : {
                note: "Not analyzed yet. It is analyzed the first time it plays in TastyTunes, or with Analyze audio on its album.",
              }),
          album_dr: albumDr,
          album_lufs: albumEntry?.lufs ?? null,
          dr_definition:
            "TT-DR, the DR database's procedure; the album value needs every track analyzed.",
          loudness_definition:
            "EBU R128 integrated loudness (LUFS) with true peak (dBTP); the album value integrates across every track, gated as one programme.",
        });
      },
    },
    get_album_art: {
      inputSchema: {
        server_udn: z.string().describe("From search_library / list_albums / list_media_servers."),
        object_id: z
          .string()
          .describe("The album or track object id (a track answers with its album's picture)."),
        size: z
          .enum(["card", "thumb"])
          .optional()
          .describe("'card' (480 px, the default) or 'thumb' (320 px)."),
      },
      // The picture as an MCP image block (2026-09-14), through the app's own
      // thumbnail cache (main/lookups/artThumbs): the streamer's USB server
      // hands out the whole file (827 KB, under a rotating id) and Asset resizes
      // on request, and an agent should see neither — one call, one small JPEG,
      // the same file the Library's card drew.
      handler: async (a) => {
        const pool = indexPools().find((p) => p.udn === a.server_udn);
        if (!pool)
          return err(
            indexPools().length === 0
              ? ctx.kickIndex()
              : `No ready index for server '${String(a.server_udn)}'. Use list_media_servers.`,
          );
        const id = a.object_id as string;
        const node = pool.albums.find((n) => n.id === id) ?? pool.tracks.find((n) => n.id === id);
        if (!node)
          return err(
            `Object '${id}' is not an album or a track in the index for '${pool.serverName}' — list_albums and search_library give indexed ids.`,
          );
        if (!node.artUrl) return err(`The server has no art for '${node.title}'.`);
        const tier = (a.size as "card" | "thumb" | undefined) ?? "card";
        const got = artUrlResizable(node.artUrl)
          ? await fetchOrigin(artUrlAt(node.artUrl, TIERS[tier]) ?? node.artUrl).then((r) =>
              r ? { bytes: r.raw, type: r.type } : null,
            )
          : await artThumb(artKeyOf(node), tier, node.artUrl);
        if (!got) return err(`The server did not answer for the art of '${node.title}'.`);
        return {
          content: [
            { type: "image", data: got.bytes.toString("base64"), mimeType: got.type },
            {
              type: "text",
              text: JSON.stringify({
                object_id: node.id,
                album: node.isContainer ? node.title : (node.album ?? node.title),
                artist: node.albumArtist ?? node.artist ?? null,
                size: tier,
                max_px: TIERS[tier],
                bytes: got.bytes.length,
                type: got.type,
              }),
            },
          ],
        };
      },
    },
    get_media_info: {
      inputSchema: {
        server_udn: z.string().describe("From search_library / list_albums / list_media_servers."),
        object_id: z.string().describe("The album, track or artist object id."),
      },
      // Everything the local index knows about one thing — the app's Info
      // modal as a tool. Index-backed (no connected() gate); an object the
      // index doesn't hold (a Browse-only server before its build, a plain
      // folder) says so rather than guessing.
      handler: (a) => {
        const pool = indexPools().find((p) => p.udn === a.server_udn);
        if (!pool)
          return err(
            indexPools().length === 0
              ? ctx.kickIndex()
              : `No ready index for server '${String(a.server_udn)}'. Use list_media_servers.`,
          );
        const id = a.object_id as string;
        const node =
          pool.tracks.find((n) => n.id === id) ??
          pool.albums.find((n) => n.id === id) ??
          pool.artists.find((n) => n.id === id);
        if (!node)
          return err(
            `Object '${id}' is not in the index for '${pool.serverName}' — search_library or list_albums give indexed ids.`,
          );
        const kind = pool.tracks.includes(node)
          ? "track"
          : pool.albums.includes(node)
            ? "album"
            : "artist";
        const base = {
          kind,
          server_udn: pool.udn,
          server: pool.serverName,
          object_id: node.id,
          parent_id: node.parentId,
          upnp_class: node.upnpClass,
          title: node.title,
          // where it sits on a folder server (a USB drive): the folder titles from the root
          ...(node.titlePath?.length ? { folder: node.titlePath } : {}),
          ...(node.artist ? { artist: node.artist } : {}),
          ...(node.year ? { year: node.year } : {}),
          genres: node.genre ?? [],
          art_url: node.artUrl,
        };
        if (kind === "track") {
          const f = node.format;
          return ok({
            ...base,
            performers: trackArtists(node),
            ...(node.albumArtist ? { album_artist: node.albumArtist } : {}),
            ...(node.album ? { album: node.album } : {}),
            ...(node.composers ? { composers: node.composers } : {}),
            ...(node.trackNumber != null ? { track_number: trackPosition(node) } : {}),
            ...(node.discNumber != null ? { disc_number: node.discNumber } : {}),
            ...(node.discCount != null ? { disc_count: node.discCount } : {}),
            duration_seconds: node.durationSecs,
            ...(f
              ? {
                  format: formatLabel(f),
                  codec: f.codec,
                  ...(f.bits ? { bits_per_sample: f.bits } : {}),
                  ...(f.rate ? { sample_rate_hz: f.rate } : {}),
                  ...(f.kbps ? { bitrate_kbps: f.kbps } : {}),
                  ...(f.channels ? { channels: f.channels } : {}),
                  ...(f.sizeBytes ? { size_bytes: f.sizeBytes } : {}),
                }
              : {}),
          });
        }
        if (kind === "album") {
          const tracks = albumTracksOf(node, pool);
          const sum = albumSummary(node, tracks);
          return ok({
            ...base,
            tracks: sum.tracks,
            discs: sum.discs,
            runtime_seconds: sum.runtimeSecs,
            ...(sum.sizeBytes > 0 ? { size_bytes: sum.sizeBytes } : {}),
            ...(sum.format ? { format: sum.format } : {}),
            ...(sum.formatOdd > 0 ? { format_tracks_differ: sum.formatOdd } : {}),
            hires: sum.hires,
            ...(sum.composers.length > 0 ? { composers: sum.composers } : {}),
            is_compilation: sum.isCompilation,
            track_list: tracks.map((t) => ({
              object_id: t.id,
              title: t.title,
              ...(t.discNumber != null ? { disc: t.discNumber } : {}),
              ...(t.trackNumber != null ? { track: trackPosition(t) } : {}),
              artist: t.artist,
              ...(t.artists ? { performers: t.artists } : {}),
              ...(t.composers ? { composers: t.composers } : {}),
              duration_seconds: t.durationSecs,
              ...(t.format ? { format: formatLabel(t.format) } : {}),
            })),
          });
        }
        // artist: their library page (albums, credits) — artistSummary, the modal's source
        const summary = artistSummary(node.title, pool);
        return ok({
          ...base,
          albums: summary.albums.map((x) => ({
            object_id: x.objectId,
            title: x.title,
            year: x.year,
            tracks: x.tracks,
            ...(x.format ? { format: x.format } : {}),
          })),
          track_count: summary.trackCount,
          guest_on: summary.guestOn.map((g) => ({
            object_id: g.objectId,
            title: g.title,
            album: g.album,
            album_artist: g.albumArtist,
          })),
          composed: summary.composed.map((x) => ({
            object_id: x.objectId,
            title: x.title,
            album: x.album,
          })),
          genres_across_albums: summary.genres,
          ...(summary.years ? { active_years: summary.years } : {}),
        });
      },
    },
    play_media: {
      inputSchema: {
        server_udn: z.string().describe("From search_library / list_media_servers."),
        object_id: z.string().describe("From search_library."),
        mode: z
          .enum(["play_now", "play_next", "append", "replace"])
          .optional()
          .describe(
            "Default play_now (keeps the queue). 'replace' clears the queue — only when asked to.",
          ),
        confirm_large: z
          .boolean()
          .optional()
          .describe(
            `Only after the user agreed: queue a container over ${LARGE_QUEUE_TRACKS} tracks anyway.`,
          ),
      },
      handler: async (a) => {
        const s = ctx.connected();
        const mode = (a.mode as string | undefined) ?? "play_now";
        // a Browse-built (USB) index is revalidated first: the id in hand may have rotted
        const fresh = await freshObjectId(
          s.connection.host,
          a.server_udn as string,
          a.object_id as string,
        );
        if ("error" in fresh) return err(fresh.error);
        try {
          await ctx.dm.ensureAwake(); // agents get wake-on-intent too
          await queueAdd(
            s.connection.host,
            a.server_udn as string,
            fresh.id,
            QUEUE_MODES[mode],
            undefined,
            { confirmLarge: a.confirm_large === true },
          );
        } catch (e) {
          if (e instanceof LargeQueueError) return err(largeQueueAsk(e.tracks, "play_media"));
          return err(
            `Couldn't queue that item — its object id may be stale; run search_library again. (${(e as Error).message})`,
          );
        }
        return ok(
          mode === "replace"
            ? "Playing — the previous queue was replaced."
            : mode === "play_now"
              ? "Playing now (the queue is kept)."
              : mode === "play_next"
                ? "Queued to play next."
                : "Added to the end of the queue.",
        );
      },
    },
  };
}
