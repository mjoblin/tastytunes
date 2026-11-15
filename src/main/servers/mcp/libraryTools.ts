import { z } from "zod";
import { artKeyOf, artUrlAt, artUrlResizable, isDeviceArt } from "@shared/artUrl";
import { nativeImage } from "electron";
import { artHostTrust } from "../../lookups/artFetch";
import { artThumb, fetchOrigin, JPEG_QUALITY, TIERS } from "../../lookups/artThumbs";
import { embeddedArtFor } from "../../lookups/embeddedArt";
import {
  type MediaNode,
  albumTally,
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
  orderTracks,
  usbServer,
} from "@shared/model";
import {
  audioAnalysisKey,
  albumDrKey,
  currentFeatures,
  keyFromStored,
  keyMatches,
  keyName,
  parseKeyName,
  tempoBpm,
  KEY_CONFIDENCE_FLOOR,
  TEMPO_CONFIDENCE_FLOOR,
  playKey,
  LOSSLESS_CODECS,
  isHiRes,
  LARGE_QUEUE_TRACKS,
  copyStat,
  peersByPlayKey,
} from "@shared/model";
import { audioAnalysisGet, albumDrMap, audioStatsMany } from "../../lookups/audioAnalysis";
import { playStatsFromRecord } from "../../data/playStats";
import { getSettings } from "../../data/persist";
import { browseChildrenOf, LargeQueueError, refreshServers } from "../../media/upnpBrowser";
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
  defineTool,
  localTime,
  DECADE_ARG,
  DETAIL_ARG,
  type TrackRef,
  tracksArg,
  genreKey,
  nearestNames,
  localDayStart,
  localToday,
  settle,
  trackMoved,
  queueGrew,
  DEVICE_ARG,
  readTrackRefs,
  refsNote,
  noTrackFound,
  decadeStart,
  decadeError,
  inDecade,
} from "./toolkit";
import { matchesQuery, nameKey, searchFold } from "@shared/keys";
import { compareRecentlyAdded } from "@shared/recentlyAdded";

// The MCP bridge's library tools (the library: servers, browsing, the lenses' lists, search and
// the index), one of six tool modules split out of mcpServer.ts 2026-09-13; the shapes and helpers
// they share live in ./toolkit.

export function libraryTools(ctx: ToolContext): Record<string, ToolImpl> {
  const { dm } = ctx;
  return {
    // ---- library
    rebuild_library_index: defineTool({
      inputSchema: {
        server_udn: z
          .string()
          .describe("Which server to index (see list_media_servers for udn + index state)."),
      },
      handler: async (a) => {
        const s = ctx.connected();
        const servers = await refreshServers(s.connection.host);
        const server = servers.find((x) => x.udn === a.server_udn);
        if (!server) return err(`No media server with udn ${a.server_udn}.`);
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
          const x = indexStatus().find((y) => y.udn === a.server_udn);
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
    }),
    list_media_servers: defineTool({
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
                      built_at: st.builtAt != null ? localTime(st.builtAt) : null,
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
    }),
    search_library: defineTool({
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
        const collected: unknown[] = [];
        let sourceCapped = false;
        for (const server of fleet) {
          const { items, total } = await librarySearch(s.connection.host, server.udn, a.query);
          if (total > items.length) sourceCapped = true;
          for (const n of items) {
            const kind = kindOf(n);
            if (kind === "folder") continue;
            if (a.kind != null && kind !== a.kind) continue;
            if (a.match === "title" && !matchesQuery(a.query, [n.title])) continue;
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
        const offset = a.offset ?? 0;
        const limit = a.limit ?? 40;
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
          // nothing found: the closest artist and album names the index holds (0.16.0)
          ...(collected.length === 0
            ? {
                nearest: nearestNames(
                  a.query,
                  indexPools()
                    .filter((p) => a.server_udn == null || p.udn === a.server_udn)
                    .flatMap((p) => [
                      ...p.artists.map((n) => n.title),
                      ...p.albums.map((n) => n.title),
                    ]),
                ),
              }
            : {}),
          results: page,
        });
      },
    }),
    // THE LIBRARY'S SHAPE IN ONE ANSWER (0.16.0): an agent maps a style, a mood or an era onto this
    // library, and learning its genres had taken four calls and 180,000 characters
    library_facets: defineTool({
      inputSchema: {
        server_udn: z.string().optional().describe("Limit to one server (see list_media_servers)."),
      },
      handler: (a) => {
        const groups = indexPools().filter((p) => a.server_udn == null || p.udn === a.server_udn);
        if (groups.length === 0)
          return err(
            a.server_udn != null
              ? `No ready index for server '${String(a.server_udn)}'. Use list_media_servers.`
              : ctx.kickIndex(),
          );
        const albums = groups.flatMap((p) => p.albums);
        const tracks = groups.flatMap((p) => p.tracks);
        // a genre's spellings are one genre (genreKey), named by the spelling most albums use
        const genres = new Map<
          string,
          { names: Map<string, number>; albums: number; tracks: number }
        >();
        const genreOf = (g: string) => {
          const key = genreKey(g);
          let hit = genres.get(key);
          if (!hit) genres.set(key, (hit = { names: new Map(), albums: 0, tracks: 0 }));
          hit.names.set(g, (hit.names.get(g) ?? 0) + 1);
          return hit;
        };
        const untagged = (gs: string[] | undefined): boolean =>
          (gs ?? []).every((g) => genreKey(g) === "" || genreKey(g) === "unknown");
        // each of an item's genres once, however many spellings of it the tags carry
        const eachGenre = (
          gs: string[] | undefined,
          count: (g: { albums: number; tracks: number }) => void,
        ) => {
          const seen = new Set<string>();
          for (const g of gs ?? []) {
            const key = genreKey(g);
            if (key === "" || seen.has(key)) continue;
            seen.add(key);
            count(genreOf(g));
          }
        };
        for (const n of albums) eachGenre(n.genre, (g) => (g.albums += 1));
        for (const t of tracks) eachGenre(t.genre, (g) => (g.tracks += 1));
        const decades = new Map<number, number>();
        let noYear = 0;
        for (const n of albums) {
          const d = n.year != null ? decadeStart(String(n.year).slice(0, 4)) : null;
          if (d == null) noYear += 1;
          else decades.set(d, (decades.get(d) ?? 0) + 1);
        }
        const formats = new Map<string, number>();
        for (const t of tracks) {
          const f = formatLabel(t.format);
          if (f) formats.set(f, (formats.get(f) ?? 0) + 1);
        }
        const known = audioStatsMany(tracks.map((t) => audioAnalysisKey(t)));
        const stats = Object.values(known);
        return ok({
          albums: albums.length,
          tracks: tracks.length,
          artists: groups.reduce((n, p) => n + p.artists.length, 0),
          genres: [...genres.values()]
            .map((g) => ({
              name: [...g.names].sort((x, y) => y[1] - x[1])[0][0],
              albums: g.albums,
              tracks: g.tracks,
            }))
            .sort((x, y) => y.albums - x.albums || y.tracks - x.tracks),
          albums_without_genre: albums.filter((n) => untagged(n.genre)).length,
          genre_note:
            "Genre tags are often missing or broad: choose by the artists too (list_artists).",
          decades: [...decades]
            .sort((x, y) => x[0] - y[0])
            .map(([d, n]) => ({ decade: `${d}s`, albums: n })),
          albums_without_year: noYear,
          formats: [...formats]
            .sort((x, y) => y[1] - x[1])
            .map(([format, n]) => ({ format, tracks: n })),
          analysis: {
            tracks_measured: stats.length,
            with_dr: stats.filter((x) => x.dr != null).length,
            with_loudness: stats.filter((x) => x.lufs != null).length,
            with_tempo: stats.filter((x) => x.bpm != null).length,
            with_key: stats.filter((x) => x.key != null).length,
            of: tracks.length,
            note: "Tracks are measured when they play in TastyTunes, or with analyze_album.",
          },
          arrivals_known: albums.filter((n) => (n.addedAt ?? 0) > 0).length,
        });
      },
    }),
    // ANALYZE AUDIO FOR AN AGENT (0.16.0): the album's Analyze audio, run where analysis decodes,
    // in the window, so an agent can measure an album the user asks about; it never opens a
    // window, and the streamer's own drive can't be read
    analyze_album: defineTool({
      inputSchema: {
        server_udn: z.string().describe("From list_albums or search_library."),
        object_id: z.string().describe("The album's id."),
      },
      handler: async (a) => {
        if (!getSettings().waveforms)
          return err("Audio analysis is off. The user can turn it on in Settings › Appearance.");
        const pool = indexPools().find((p) => p.udn === a.server_udn);
        const album = pool?.albums.find((n) => n.id === a.object_id);
        if (!pool || !album)
          return err(
            `No album '${a.object_id}' in that server's index. Use list_albums for its id.`,
          );
        const s = ctx.connected();
        const server = (await refreshServers(s.connection.host)).find(
          (x) => x.udn === a.server_udn,
        );
        if (server && usbServer(server))
          return err(
            "Tracks on the streamer's USB drive can't be read, so they can't be analyzed.",
          );
        if (!ctx.windowOpen())
          return err(
            "Audio is analyzed in the TastyTunes window, which is closed. Ask the user to open TastyTunes, then call again.",
          );
        ctx.sendCommand({ id: "analyzeAlbum", serverUdn: a.server_udn, albumId: a.object_id });
        const tracks = albumTracksOf(album, pool).length;
        return ok(
          `Analyzing "${album.title}" (${tracks} ${tracks === 1 ? "track" : "tracks"}) in the background, one track at a time. get_track_analysis and list_tracks show each track's results once it is measured, list_albums the album's when every track is.`,
        );
      },
    }),
    list_albums: defineTool({
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Words in the album's title, accents and punctuation ignored."),
        artist: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on the album artist."),
        genre: z
          .string()
          .optional()
          .describe(
            "A genre, matched ignoring case, spaces and hyphens ('hip hop' is Hip-Hop); library_facets lists them. With none matching, the nearest genre names come back.",
          ),
        year_from: z.number().int().optional().describe("Albums from this year on."),
        year_to: z.number().int().optional().describe("Albums up to this year."),
        added_since: z
          .string()
          .optional()
          .describe(
            "A local date, YYYY-MM-DD: albums that arrived in the library since then (the Library's Recently added).",
          ),
        decade: DECADE_ARG,
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
        played: z
          .boolean()
          .optional()
          .describe(
            "true: only albums the listening record has a play for; false: only albums never played (the Library's Played filter).",
          ),
        sort: z
          .enum([
            "title",
            "artist",
            "year",
            "added",
            "dr",
            "loudness",
            "last_played",
            "most_played",
          ])
          .optional()
          .describe(
            "Default 'title'; 'year' sorts newest first; 'added' the latest arrivals first (the Library's Recently added); 'dr' most dynamic first, unanalyzed last; 'last_played' most recently played first and 'most_played' most plays first, from the listening record, unplayed last; 'loudness' loudest first (integrated LUFS), unmeasured last.",
          ),
        limit: z.number().int().min(1).max(100).optional().describe("Default 40."),
        offset: z.number().int().min(0).optional().describe("For paging; default 0."),
        detail: DETAIL_ARG,
      },
      // Purely index-backed (the lenses' feedstock) — works even while the
      // streamer itself is off, so no connected() gate.
      handler: async (a) => {
        const groups = indexPools().filter((p) => a.server_udn == null || p.udn === a.server_udn);
        if (groups.length === 0) {
          return err(
            a.server_udn != null
              ? `No ready index for server '${String(a.server_udn)}'. Use list_media_servers.`
              : ctx.kickIndex(),
          );
        }
        // the text filters fold accents and punctuation (shared/keys' matchesQuery): "motorhead"
        // finds Motörhead
        const artistQuery = a.artist;
        const titleQuery = a.query;
        const genreWanted = a.genre != null ? genreKey(a.genre) : null;
        const decade = a.decade != null ? decadeStart(a.decade) : null;
        if (a.decade != null && decade == null) return err(decadeError(a.decade));
        const addedSince = a.added_since != null ? localDayStart(a.added_since) : null;
        if (a.added_since != null && addedSince == null)
          return err(
            `"${a.added_since}" isn't a day: added_since takes a local date, YYYY-MM-DD (today is ${localToday()}).`,
          );
        const everyAlbum = groups.flatMap((p) => p.albums);
        let albums = everyAlbum;
        if (titleQuery != null) albums = albums.filter((n) => matchesQuery(titleQuery, [n.title]));
        if (artistQuery != null)
          albums = albums.filter((n) => matchesQuery(artistQuery, [n.artist]));
        // a genre ignoring case, spaces and hyphens (0.16.0), and when the library has none by
        // that name, the nearest ones it has
        const genreUnknown =
          genreWanted != null &&
          !everyAlbum.some((n) => (n.genre ?? []).some((g) => genreKey(g) === genreWanted));
        if (genreWanted != null)
          albums = albums.filter((n) => (n.genre ?? []).some((g) => genreKey(g) === genreWanted));
        if (decade != null) albums = albums.filter((n) => inDecade(n.year, decade));
        const yearOf = (n: MediaNode): number =>
          Number.parseInt(String(n.year ?? "").slice(0, 4), 10);
        if (a.year_from != null) {
          const from = a.year_from;
          albums = albums.filter((n) => yearOf(n) >= from);
        }
        if (a.year_to != null) {
          const to = a.year_to;
          albums = albums.filter((n) => yearOf(n) <= to);
        }
        // the app's arrival dates (shared/recentlyAdded): an album with none is not claimed new
        if (addedSince != null) albums = albums.filter((n) => (n.addedAt ?? 0) >= addedSince);
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
          const min = a.min_dr;
          albums = albums.filter((n) => (albumDr(n) ?? -1) >= min);
        }
        const formatNeedle = a.format?.toLowerCase();
        if (formatNeedle != null)
          albums = albums.filter((n) => {
            const { tracks, sum } = summaryFor(n);
            return (
              (sum.format ?? "").toLowerCase().includes(formatNeedle) ||
              tracks.some((t) => (formatLabel(t.format) ?? "").toLowerCase().includes(formatNeedle))
            );
          });
        const composerQuery = a.composer;
        if (composerQuery != null)
          albums = albums.filter((n) =>
            summaryFor(n).tracks.some((t) =>
              (t.composers ?? []).some((c) => matchesQuery(composerQuery, [c])),
            ),
          );
        const sort = (a.sort as string | undefined) ?? "title";
        // the record's facets (2026-09-14): the Library's Played filter and its last played /
        // most played sorts, from the same album tally the Albums lens reads
        const wantsPlays = a.played != null || sort === "last_played" || sort === "most_played";
        const stats = wantsPlays ? await playStatsFromRecord() : null;
        // each copy its own tally, against every library's tracks (shared/model/copies)
        const peersOf = peersByPlayKey(indexPools());
        const tallies = new Map<MediaNode, { plays: number; lastAt: number }>();
        const tallyOf = (n: MediaNode): { plays: number; lastAt: number } => {
          let hit = tallies.get(n);
          if (!hit) {
            const pool = n.serverUdn ? poolOf.get(n.serverUdn) : undefined;
            hit = pool && stats ? albumTally(n, pool, stats, peersOf) : { plays: 0, lastAt: 0 };
            tallies.set(n, hit);
          }
          return hit;
        };
        if (a.played === true) albums = albums.filter((n) => tallyOf(n).plays > 0);
        if (a.played === false) albums = albums.filter((n) => tallyOf(n).plays === 0);
        albums.sort((x, y) => {
          if (sort === "added") return compareRecentlyAdded(x, y);
          if (sort === "last_played")
            return tallyOf(y).lastAt - tallyOf(x).lastAt || x.title.localeCompare(y.title);
          if (sort === "most_played")
            return tallyOf(y).plays - tallyOf(x).plays || x.title.localeCompare(y.title);
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
        const offset = a.offset ?? 0;
        const limit = a.limit ?? 40;
        const page = albums.slice(offset, offset + limit);
        // how much of the answer rests on measured albums (0.16.0): an analysis filter or sort
        // reads only the albums analyzed whole, and an agent should say so
        const measuring = a.min_dr != null || sort === "dr" || sort === "loudness";
        const datesKnown = sort === "added" || addedSince != null;
        return ok({
          total: albums.length,
          offset,
          returned: page.length,
          ...(measuring
            ? {
                coverage: {
                  albums_measured: everyAlbum.filter((n) => albumDr(n) != null).length,
                  of: everyAlbum.length,
                  note: "Dynamic range and loudness are known only for albums analyzed whole.",
                },
              }
            : {}),
          ...(datesKnown
            ? {
                arrivals_known: everyAlbum.filter((n) => (n.addedAt ?? 0) > 0).length,
                ...(everyAlbum.some((n) => (n.addedAt ?? 0) > 0)
                  ? {}
                  : {
                      note: "No arrival dates yet: the app notes the day each album first appears.",
                    }),
              }
            : {}),
          ...(genreUnknown
            ? {
                genre_note: `The library has no genre "${a.genre}".`,
                nearest_genres: nearestNames(
                  a.genre ?? "",
                  everyAlbum.flatMap((n) => n.genre ?? []),
                ),
              }
            : {}),
          albums: page.map((n) => {
            const { sum } = summaryFor(n);
            // brief by default (0.16.0): the server's name, the folder, the size, the odd formats,
            // the composers and a false flag on every row were most of a page
            const full = a.detail === "full";
            return {
              server_udn: n.serverUdn,
              ...(full ? { server: n.serverName } : {}),
              object_id: n.id,
              title: n.title,
              ...(full && n.titlePath?.length ? { folder: n.titlePath } : {}),
              artist: n.artist,
              year: n.year,
              genres: n.genre ?? [],
              // summed from the album's tracks (2026-08-16): what the app's
              // album header shows
              tracks: sum.tracks,
              ...(sum.discs > 1 ? { discs: sum.discs } : {}),
              runtime_seconds: sum.runtimeSecs,
              ...(full && sum.sizeBytes > 0 ? { size_bytes: sum.sizeBytes } : {}),
              ...(sum.format ? { format: sum.format } : {}),
              ...(full && sum.formatOdd > 0 ? { format_tracks_differ: sum.formatOdd } : {}),
              ...(full || sum.hires ? { hires: sum.hires } : {}),
              ...(albumDr(n) != null ? { dr: albumDr(n) } : {}),
              ...(full && sum.composers.length > 0 ? { composers: sum.composers } : {}),
              ...(full || sum.isCompilation ? { is_compilation: sum.isCompilation } : {}),
              ...((full || datesKnown) && (n.addedAt ?? 0) > 0
                ? { added: localTime(n.addedAt ?? 0) }
                : {}),
              ...(stats
                ? {
                    plays: tallyOf(n).plays,
                    last_played: tallyOf(n).lastAt > 0 ? localTime(tallyOf(n).lastAt) : null,
                  }
                : {}),
            };
          }),
        });
      },
    }),
    list_artists: defineTool({
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Words in the artist's name, accents and punctuation ignored."),
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
        // the whole artist list in one call (0.16.0, with compact answers): an agent reads it to
        // choose by style, since genre tags are thin
        limit: z.number().int().min(1).max(1000).optional().describe("Default 100, up to 1,000."),
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
          const k = nameKey(artist);
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
                const k = nameKey(cname);
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
        const needle = a.query;
        let artists = [...byName.values()];
        // folded as the other name filters fold (0.16.0: "motorhead" found no Motörhead here while
        // list_tracks found its tracks)
        if (needle != null) artists = artists.filter((x) => matchesQuery(needle, [x.name]));
        const sort = (a.sort as string | undefined) ?? "name";
        artists.sort((x, y) =>
          sort === "albums"
            ? y.albums - x.albums || nameSortKey(x.name).localeCompare(nameSortKey(y.name))
            : nameSortKey(x.name).localeCompare(nameSortKey(y.name)),
        );
        const offset = a.offset ?? 0;
        const limit = a.limit ?? 100;
        const page = artists.slice(offset, offset + limit);
        return ok({ total: artists.length, offset, returned: page.length, artists: page });
      },
    }),
    list_tracks: defineTool({
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Words in the track's title, accents and punctuation ignored."),
        artist: z
          .string()
          .optional()
          .describe("Case-insensitive substring on the track's performers."),
        album: z.string().optional().describe("Case-insensitive substring on the album title."),
        genre: z
          .string()
          .optional()
          .describe(
            "A genre, matched ignoring case, spaces and hyphens (library_facets lists them). With none matching, the nearest genre names come back.",
          ),
        played: z
          .boolean()
          .optional()
          .describe("true: only tracks the listening record has a play for; false: never played."),
        decade: DECADE_ARG,
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
        min_bpm: z
          .number()
          .min(20)
          .max(300)
          .optional()
          .describe(
            "Only tracks whose measured tempo is at least this many beats per minute; tracks without a confident tempo are excluded.",
          ),
        max_bpm: z
          .number()
          .min(20)
          .max(300)
          .optional()
          .describe(
            "Only tracks whose measured tempo is at most this many beats per minute; tracks without a confident tempo are excluded.",
          ),
        key: z
          .string()
          .optional()
          .describe(
            "Only tracks in this measured key, e.g. 'A minor', 'F# major', 'Bbm', a tonic alone ('Eb', either mode) or a mode alone ('minor'); tracks without a confident key are excluded.",
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
            "tempo",
            "plays",
            "last_played",
          ])
          .optional()
          .describe(
            "Default 'title'. 'plays' most played first; 'last_played' most recent first; 'dr' most dynamic first; 'duration' longest first; 'tempo' fastest first, tracks without a confident tempo last.",
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
        const artistQuery = a.artist;
        const albumQuery = a.album;
        const titleQuery = a.query;
        const genreWanted = a.genre != null ? genreKey(a.genre) : null;
        const decade = a.decade != null ? decadeStart(a.decade) : null;
        if (a.decade != null && decade == null) return err(decadeError(a.decade));
        const formatNeedle = a.format?.toLowerCase();
        const drOf = (t: MediaNode): number | null => {
          const an = audioAnalysisGet(audioAnalysisKey(t));
          return an && an.dr > 0 ? an.dr : null;
        };
        const lufsOf = (t: MediaNode): number | null =>
          audioAnalysisGet(audioAnalysisKey(t))?.lufs ?? null;
        // tempo and key above their confidence floors, as Info says them (shared/model)
        const featuresOf = (t: MediaNode) =>
          currentFeatures(audioAnalysisGet(audioAnalysisKey(t))?.features);
        const bpmOf = (t: MediaNode): number | null => tempoBpm(featuresOf(t)?.beats);
        const wantKey = a.key != null ? parseKeyName(a.key) : null;
        if (a.key != null && wantKey == null)
          return err(
            `"${a.key}" doesn't name a key. Try 'A minor', 'F# major', 'Bbm', 'Eb' or 'minor'.`,
          );
        let tracks = groups.flatMap((p) => p.tracks);
        const everyTrack = tracks;
        if (titleQuery != null) tracks = tracks.filter((t) => matchesQuery(titleQuery, [t.title]));
        if (artistQuery != null)
          tracks = tracks.filter(
            (t) =>
              trackArtists(t).some((n) => matchesQuery(artistQuery, [n])) ||
              matchesQuery(artistQuery, [t.artist]),
          );
        if (albumQuery != null) tracks = tracks.filter((t) => matchesQuery(albumQuery, [t.album]));
        if (genreWanted != null)
          tracks = tracks.filter((t) => (t.genre ?? []).some((g) => genreKey(g) === genreWanted));
        if (decade != null) tracks = tracks.filter((t) => inDecade(t.year, decade));
        if (formatNeedle != null)
          tracks = tracks.filter(
            (t) =>
              (formatLabel(t.format) ?? "").toLowerCase().includes(formatNeedle) ||
              lc(t.format?.codec).includes(formatNeedle),
          );
        if (a.lossless === true)
          tracks = tracks.filter((t) => LOSSLESS_CODECS.has((t.format?.codec ?? "").toUpperCase()));
        if (a.hires === true) tracks = tracks.filter((t) => (t.format ? isHiRes(t.format) : false));
        // HOW MUCH OF THE ANSWER IS MEASURED (0.16.0): an analysis filter or sort reads only the
        // analyzed tracks, so the answer says how many of the tracks it chose from were (a tempo
        // filter over 6% of a library had answered as if it were the whole)
        const pool = tracks;
        const coverageOf = (has: (t: MediaNode) => boolean) => ({
          measured: pool.filter(has).length,
          of: pool.length,
        });
        const sortName = a.sort ?? "title";
        const coverage = {
          ...(a.min_dr != null || sortName === "dr"
            ? { dr: coverageOf((t) => drOf(t) != null) }
            : {}),
          ...(sortName === "loudness" ? { loudness: coverageOf((t) => lufsOf(t) != null) } : {}),
          ...(a.min_bpm != null || a.max_bpm != null || sortName === "tempo"
            ? { tempo: coverageOf((t) => bpmOf(t) != null) }
            : {}),
          ...(wantKey != null
            ? { key: coverageOf((t) => keyName(keyFromStored(featuresOf(t))) != null) }
            : {}),
        };
        if (a.min_dr != null) {
          const min = a.min_dr;
          tracks = tracks.filter((t) => (drOf(t) ?? -1) >= min);
        }
        if (a.min_bpm != null || a.max_bpm != null) {
          const lo = a.min_bpm ?? 0;
          const hi = a.max_bpm ?? Infinity;
          tracks = tracks.filter((t) => {
            const bpm = bpmOf(t);
            return bpm != null && bpm >= lo && bpm <= hi;
          });
        }
        if (wantKey != null)
          tracks = tracks.filter((t) => keyMatches(keyFromStored(featuresOf(t)), wantKey));
        const stats = await playStatsFromRecord();
        const peersOf = peersByPlayKey(indexPools());
        const statOf = (t: MediaNode) =>
          copyStat(stats, t, peersOf(playKey(t.title, t.artist, t.album)));
        if (a.played === true) tracks = tracks.filter((t) => (statOf(t)?.plays ?? 0) > 0);
        if (a.played === false) tracks = tracks.filter((t) => (statOf(t)?.plays ?? 0) === 0);
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
          if (sort === "tempo") return (bpmOf(y) ?? -1) - (bpmOf(x) ?? -1) || byTitle(x, y);
          if (sort === "plays")
            return (statOf(y)?.plays ?? 0) - (statOf(x)?.plays ?? 0) || byTitle(x, y);
          if (sort === "last_played")
            return (statOf(y)?.lastAt ?? 0) - (statOf(x)?.lastAt ?? 0) || byTitle(x, y);
          return byTitle(x, y);
        });
        const offset = a.offset ?? 0;
        const limit = a.limit ?? 50;
        const page = tracks.slice(offset, offset + limit);
        // a genre the library lacks names the nearest, as list_albums does
        const genreUnknown =
          genreWanted != null &&
          !everyTrack.some((t) => (t.genre ?? []).some((g) => genreKey(g) === genreWanted));
        return ok({
          total: tracks.length,
          offset,
          returned: page.length,
          ...(genreUnknown
            ? {
                genre_note: `The library has no genre "${a.genre}".`,
                nearest_genres: nearestNames(
                  a.genre ?? "",
                  everyTrack.flatMap((t) => t.genre ?? []),
                ),
              }
            : {}),
          ...(Object.keys(coverage).length > 0
            ? {
                coverage: {
                  ...coverage,
                  note: "Measured facts exist only for analyzed tracks: say how many were measured.",
                },
              }
            : {}),
          tracks: page.map((t) => {
            const st = statOf(t);
            const dr = drOf(t);
            const bpm = bpmOf(t);
            const key = keyName(keyFromStored(featuresOf(t)));
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
              ...(bpm != null ? { bpm } : {}),
              ...(key != null ? { key } : {}),
              plays: st?.plays ?? 0,
              last_played: st ? localTime(st.lastAt) : null,
            };
          }),
        });
      },
    }),
    get_track_analysis: defineTool({
      inputSchema: {
        server_udn: z.string().optional().describe("With object_id: the track, from a listing."),
        object_id: z.string().optional().describe("The track's id."),
        title: z
          .string()
          .optional()
          .describe("A track title in the library; omit for the playing track."),
        artist: z.string().optional(),
        album: z.string().optional(),
      },
      handler: (a) => {
        let t:
          | (Pick<MediaNode, "title" | "artist" | "album" | "durationSecs"> & {
              albumArtist?: string | null;
            })
          | null = null;
        if (a.server_udn != null || a.object_id != null) {
          if (a.server_udn == null || a.object_id == null)
            return err("Give server_udn and object_id together, from a listing.");
          // by its ids (0.16.0), the one way that names a copy exactly
          const node = indexPools()
            .find((p) => p.udn === a.server_udn)
            ?.tracks.find((n) => n.id === a.object_id);
          if (!node)
            return err(
              `No track '${String(a.object_id)}' in that server's index. Use list_tracks for its id.`,
            );
          t = node;
        } else if (a.title) {
          const title = searchFold(a.title);
          const { artist, album } = a;
          const hits = indexPools()
            .flatMap((p) => p.tracks)
            .filter(
              (n) =>
                searchFold(n.title) === title &&
                (!artist || matchesQuery(artist, [n.artist])) &&
                (!album || matchesQuery(album, [n.album])),
            );
          if (hits.length === 0)
            return err(
              `No indexed track titled "${String(a.title)}". Use list_tracks or search_library.`,
            );
          // AMBIGUITY IS AN ANSWER (0.16.0): a title on two albums had answered with the first,
          // silently; tracks measured apart (another album, a reprise, another length) come back
          // as candidates to choose between, copies of one track as one
          const distinct = new Map(hits.map((n) => [audioAnalysisKey(n), n]));
          if (distinct.size > 1)
            return ok({
              ambiguous: true,
              note: "Several tracks have that title: call again with one's server_udn and object_id, or with artist or album.",
              candidates: [...distinct.values()].slice(0, 10).map((n) => ({
                title: n.title,
                artist: n.artist,
                album: n.album,
                server_udn: n.serverUdn,
                object_id: n.id,
              })),
            });
          t = hits[0];
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
        // tempo and key as Info says them, above their floors, with the confidence either way;
        // an analysis from before the music features (0.8.0) has neither until it plays again
        // only the current version's (an older one's tempo may sit an octave off)
        const features = currentFeatures(an?.features);
        const beats = features?.beats ?? null;
        const key = keyFromStored(features);
        const round2 = (v: number): number => Math.round(v * 100) / 100;
        const hundredth = (v: number | null | undefined): number | null =>
          v != null ? round2(v) : null;
        return ok({
          track: { title: t.title, artist: t.artist, album: t.album },
          analyzed: an != null,
          ...(an
            ? {
                dr: an.dr > 0 ? an.dr : null,
                // to a hundredth, the precision a reading means (fifteen decimals had come back)
                peak_db: hundredth(an.peakDb),
                rms_db: hundredth(an.rmsDb),
                crest_db: hundredth(an.crestDb),
                lufs: hundredth(an.lufs),
                loudness_range_lu: hundredth(an.lra),
                true_peak_dbtp: hundredth(an.truePeakDb),
                tempo_bpm: tempoBpm(beats),
                tempo_confidence: beats ? round2(beats.confidence) : null,
                key: keyName(key),
                key_confidence: key ? round2(key.confidence) : null,
                ...(features == null && an.features !== null
                  ? {
                      tempo_key_note:
                        "Measured before the current tempo and key detection; they are measured again the next time it plays in TastyTunes, or with “Analyze audio” on its album.",
                    }
                  : {}),
              }
            : {
                note: "Not analyzed yet. It is analyzed the first time it plays in TastyTunes, or with “Analyze audio” on its album.",
              }),
          album_dr: albumDr,
          album_lufs: hundredth(albumEntry?.lufs),
          dr_definition:
            "TT-DR, the DR database's procedure; the album value needs every track analyzed.",
          loudness_definition:
            "EBU R128 integrated loudness (LUFS) with true peak (dBTP); the album value integrates across every track, gated as one programme.",
          tempo_key_definition: `Tempo and key measured from the audio; each is given only when its confidence (0 to 1) reaches ${TEMPO_CONFIDENCE_FLOOR} for tempo and ${KEY_CONFIDENCE_FLOOR} for key, and is null below that.`,
        });
      },
    }),
    get_album_art: defineTool({
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
        const id = a.object_id;
        const node = pool.albums.find((n) => n.id === id) ?? pool.tracks.find((n) => n.id === id);
        if (!node)
          return err(
            `Object '${id}' is not an album or a track in the index for '${pool.serverName}' — list_albums and search_library give indexed ids.`,
          );
        const tier = a.size ?? "card";
        const link = ctx.dm.snapshot().connection;
        const host = link.phase === "connected" ? link.host : null;
        const trust = artHostTrust(host);
        let got: { bytes: Buffer; type: string } | null = null;
        let from: "server" | "file" = "server";
        if (node.artUrl)
          got = artUrlResizable(node.artUrl)
            ? await fetchOrigin(artUrlAt(node.artUrl, TIERS[tier]) ?? node.artUrl, trust).then(
                (r) => (r ? { bytes: r.raw, type: r.type } : null),
              )
            : // the same storage key as the cards (thumbKey), so both find one file
              await artThumb(
                artKeyOf(node),
                tier,
                node.artUrl,
                trust,
                isDeviceArt(node.artUrl, host),
              );
        if (!got) {
          // the app's own fall-through (lib/bestArt): the picture inside the audio file when
          // the server has none, read through main's embedded-art lookup (its Settings switch
          // applies) and resized to the tier here
          const conn = ctx.dm.snapshot().connection;
          const trackId = node.isContainer ? albumTracksOf(node, pool)[0]?.id : node.id;
          const emb =
            conn.phase === "connected" && trackId
              ? await embeddedArtFor(conn.host, { serverUdn: pool.udn, objectId: trackId })
              : null;
          const m = emb ? /^data:([^;]+);base64,(.*)$/.exec(emb.dataUrl) : null;
          if (m) {
            const raw = Buffer.from(m[2], "base64");
            const img = nativeImage.createFromBuffer(raw);
            const shown = img.isEmpty()
              ? null
              : img.getSize().width > TIERS[tier]
                ? img.resize({ width: TIERS[tier], quality: "good" })
                : img;
            got = shown
              ? { bytes: shown.toJPEG(JPEG_QUALITY), type: "image/jpeg" }
              : { bytes: raw, type: m[1] };
            from = "file";
          }
        }
        if (!got)
          return err(
            node.artUrl
              ? `The server did not answer for the art of '${node.title}', and its audio file carries no picture.`
              : `The server has no art for '${node.title}' and its audio file carries none (or Album art from audio files is off in Settings › Appearance).`,
          );
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
                from,
              }),
            },
          ],
        };
      },
    }),
    get_media_info: defineTool({
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
        const id = a.object_id;
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
    }),
    play_media: defineTool({
      inputSchema: {
        server_udn: z
          .string()
          .optional()
          .describe("With object_id: the item's server, from search_library / list_media_servers."),
        object_id: z
          .string()
          .optional()
          .describe("An album, track or other item, from search_library or a listing."),
        items: tracksArg(LARGE_QUEUE_TRACKS)
          .optional()
          .describe(
            `Instead of server_udn and object_id: up to ${LARGE_QUEUE_TRACKS} tracks queued in one write, in the order given, each {server_udn, object_id} from a listing or {title, artist?, album?}.`,
          ),
        start_at: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "With an album: play it from this track, by its place on the album (1 = the first). Replaces the queue.",
          ),
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
        device: DEVICE_ARG,
      },
      handler: async (a) => {
        // the window's streamer, or another the device argument names (0.16.0)
        const t = await ctx.target(a.device);
        const s = t.snapshot();
        const host = t.host;
        const mode = a.mode ?? "play_now";
        // what it left, once the streamer says so (0.16.0): a play waits for the track to move,
        // an add for the queue to grow
        const settled = mode === "append" || mode === "play_next" ? queueGrew : trackMoved;
        // what a replace threw away, said so the agent can tell the user (0.16.0)
        const before = s.queue?.total ?? 0;
        const replacedNote = (n: number | null): string =>
          n != null && n > 0 ? ` Replaced a queue of ${n} ${n === 1 ? "track" : "tracks"}.` : "";

        // A LIST OF TRACKS (0.16.0): one write on the batch the playlists run on, in order
        if (a.items != null) {
          if (a.server_udn != null || a.object_id != null || a.start_at != null)
            return err("Give items, or server_udn and object_id, not both.");
          // a Browse-built (USB) index is revalidated first: an id in hand may have rotted
          const refs: TrackRef[] = [];
          const rotted = new Map<number, string>();
          for (const [i, ref] of a.items.entries()) {
            if (!("object_id" in ref)) refs.push(ref);
            else {
              const fresh = await freshObjectId(host, ref.server_udn, ref.object_id);
              if ("error" in fresh) rotted.set(i, fresh.error);
              refs.push(
                "error" in fresh ? ref : { server_udn: ref.server_udn, object_id: fresh.id },
              );
            }
          }
          const named = readTrackRefs(refs, rotted);
          if (named.items.length === 0) return noTrackFound(named);
          let res;
          try {
            res = await t.queueTracks(named.items, mode);
          } catch (e) {
            return err((e as Error).message);
          }
          // a track the streamer would not take is named at its place too
          const left = new Set<number>();
          for (const title of res.missed) {
            const k = named.items.findIndex((it, j) => it.title === title && !left.has(j));
            if (k < 0) continue;
            left.add(k);
            named.missed.push({
              index: named.at[k],
              ref: title,
              note: "The streamer didn't take it.",
            });
          }
          named.missed.sort((x, y) => x.index - y.index);
          const how =
            mode === "replace"
              ? "playing from the first"
              : mode === "play_now"
                ? "the first playing now, the rest after it"
                : mode === "play_next"
                  ? "to play next"
                  : "at the end of the queue";
          return settle(
            t,
            s,
            `Queued ${res.added} of ${a.items.length} ${a.items.length === 1 ? "track" : "tracks"}, ${how}.${replacedNote(res.replaced)}`,
            settled,
            refsNote(named),
          );
        }

        if (a.server_udn == null || a.object_id == null)
          return err("Give server_udn and object_id (from search_library or a listing), or items.");
        // a Browse-built (USB) index is revalidated first: the id in hand may have rotted
        const fresh = await freshObjectId(s.connection.host, a.server_udn, a.object_id);
        if ("error" in fresh) return err(fresh.error);

        // AN ALBUM FROM ONE OF ITS TRACKS (0.16.0): the album's OWN browse supplies the ids, the
        // Library's Play album from here (a pooled track's parent is the search scope)
        if (a.start_at != null) {
          if (a.mode != null && a.mode !== "replace")
            return err(
              "start_at plays the album from that track and replaces the queue: leave mode out.",
            );
          await t.ensureAwake();
          const listed = await browseChildrenOf(host, a.server_udn, fresh.id);
          const tracks = orderTracks(
            (typeof listed === "string" ? [] : listed).filter((k) => !k.isContainer),
          );
          if (tracks.length === 0)
            return err("That item has no tracks to start from: start_at needs an album.");
          const target = tracks[a.start_at - 1];
          if (!target)
            return err(`The album has ${tracks.length} tracks: start_at is 1 to ${tracks.length}.`);
          try {
            await t.queueAdd(a.server_udn, fresh.id, "PLAY_FROM_HERE", target.id, {
              confirmLarge: a.confirm_large === true,
            });
          } catch (e) {
            if (e instanceof LargeQueueError) return err(largeQueueAsk(e.tracks, "play_media"));
            return err(`Couldn't queue the album. (${(e as Error).message})`);
          }
          return settle(
            t,
            s,
            `Playing from track ${a.start_at}, "${target.title}".${replacedNote(before)}`,
            trackMoved,
          );
        }

        try {
          await t.queueAdd(a.server_udn, fresh.id, QUEUE_MODES[mode], undefined, {
            confirmLarge: a.confirm_large === true,
          });
        } catch (e) {
          if (e instanceof LargeQueueError) return err(largeQueueAsk(e.tracks, "play_media"));
          return err(
            `Couldn't queue that item — its object id may be stale; run search_library again. (${(e as Error).message})`,
          );
        }
        return settle(
          t,
          s,
          mode === "replace"
            ? `Playing.${replacedNote(before) || " The queue was empty."}`
            : mode === "play_now"
              ? "Playing now (the queue is kept)."
              : mode === "play_next"
                ? "Queued to play next."
                : "Added to the end of the queue.",
          settled,
        );
      },
    }),
  };
}
