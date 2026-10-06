import { z } from "zod";
import { nameSortKey } from "@shared/model";
import {
  isListen,
  type ListeningPlayEvent,
  playKey,
  albumTally,
  REDISCOVER_QUIET_DAYS,
} from "@shared/model";
import { playStatsFromRecord } from "../../data/playStats";
import { listeningRecord } from "../../data/listeningRecord";
import { pools as indexPools } from "../../media/mediaIndex";
import { statsFor, type TopEntry } from "@shared/historyStats";
import { heardElsewhere } from "@shared/elsewhere";
import { shelvesFor, UNFINISHED_QUIET_DAYS } from "@shared/rediscover";
import { type ToolContext, type ToolImpl, ok, err, STREAMER_ARG, streamerKeep } from "./toolkit";

// The MCP bridge's history tools (the listening record: recents, stats, the unplayed and the
// resume offer), one of six tool modules split out of mcpServer.ts 2026-09-13; the shapes and
// helpers they share live in ./toolkit.

export function historyTools(ctx: ToolContext): Record<string, ToolImpl> {
  const { dm } = ctx;
  return {
    list_history: {
      inputSchema: {
        streamer: STREAMER_ARG,
        from: z.string().optional().describe("Earliest local date, YYYY-MM-DD."),
        to: z.string().optional().describe("Latest local date, YYYY-MM-DD, inclusive."),
        kind: z
          .enum(["play", "radio-session", "radio-track", "external"])
          .optional()
          .describe("One kind only; default all."),
        listens_only: z
          .boolean()
          .optional()
          .describe(
            "Only library plays that reached a listen (half the track or four minutes of real play time), as the Timeline's filter.",
          ),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
        offset: z.number().int().min(0).optional().describe("For paging; default 0."),
      },
      // Local files only — works with the streamer off, so no connected() gate.
      handler: async (a) => {
        const { events: everyLine, unreadable } = await listeningRecord.readAll();
        const keep = streamerKeep(a.streamer, dm.snapshot().devices);
        const events = keep ? everyLine.filter(keep) : everyLine;
        const fromMs = a.from != null ? Date.parse(`${a.from as string}T00:00:00`) : null;
        const toMs = a.to != null ? Date.parse(`${a.to as string}T23:59:59.999`) : null;
        const filtered = events
          .filter(
            (e) =>
              (fromMs == null || e.at >= fromMs) &&
              (toMs == null || e.at <= toMs) &&
              (a.kind == null || e.kind === a.kind) &&
              (a.listens_only !== true ||
                (e.kind === "play" && isListen(e.playedSeconds, e.duration))),
          )
          .sort((x, y) => y.at - x.at);
        const offset = (a.offset as number | undefined) ?? 0;
        const limit = (a.limit as number | undefined) ?? 50;
        const page = filtered.slice(offset, offset + limit).map((e) => ({
          ...e,
          at: new Date(e.at).toISOString(),
          ...(e.kind === "play" ? { listen: isListen(e.playedSeconds, e.duration) } : {}),
        }));
        return ok({
          total: filtered.length,
          offset,
          returned: page.length,
          ...(unreadable > 0 ? { unreadable_lines: unreadable } : {}),
          events: page,
        });
      },
    },
    history_top: {
      inputSchema: {
        streamer: STREAMER_ARG,
        by: z
          .enum(["artists", "albums", "tracks", "stations", "presets", "playlists"])
          .describe(
            "What to rank: library artists, albums or tracks by listens; or the stations most tuned, and the presets and playlists most started from (the Stats view's lists).",
          ),
        from: z.string().optional().describe("Earliest local date, YYYY-MM-DD."),
        to: z.string().optional().describe("Latest local date, YYYY-MM-DD, inclusive."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
      handler: async (a) => {
        const { events: everyLine } = await listeningRecord.readAll();
        const keep = streamerKeep(a.streamer, dm.snapshot().devices);
        const events = keep ? everyLine.filter(keep) : everyLine;
        const fromMs = a.from != null ? Date.parse(`${a.from as string}T00:00:00`) : null;
        const toMs = a.to != null ? Date.parse(`${a.to as string}T23:59:59.999`) : null;
        const limit = (a.limit as number | undefined) ?? 20;
        if (a.by === "stations" || a.by === "presets" || a.by === "playlists") {
          // the Stats view's own ranks (shared/historyStats), over the range
          const st = statsFor(events, {
            from: fromMs ?? 0,
            to: toMs != null ? toMs + 1 : Number.POSITIVE_INFINITY,
          });
          const rows: TopEntry[] =
            a.by === "stations"
              ? st.topStations
              : a.by === "presets"
                ? st.topPresets
                : st.topPlaylists;
          return ok({
            by: a.by,
            note:
              a.by === "stations"
                ? "plays are tuning sessions, seconds the time tuned"
                : "plays are library plays started from it, seconds their play time",
            results: rows.slice(0, limit).map((r) => ({
              label: `${r.name}${r.sub ? ` · ${r.sub}` : ""}`,
              plays: r.plays,
              seconds: r.seconds,
            })),
          });
        }
        const counts = new Map<string, { label: string; plays: number; listens: number }>();
        for (const e of events) {
          // Library plays only: a count means "played from the library".
          if (e.kind !== "play") continue;
          if ((fromMs != null && e.at < fromMs) || (toMs != null && e.at > toMs)) continue;
          const label =
            a.by === "artists"
              ? (e.artist ?? "Unknown artist")
              : a.by === "albums"
                ? `${e.album ?? "Unknown album"}${e.artist ? ` · ${e.artist}` : ""}`
                : `${e.title}${e.artist ? ` · ${e.artist}` : ""}`;
          const key = label.toLowerCase();
          const row = counts.get(key) ?? { label, plays: 0, listens: 0 };
          row.plays += 1;
          if (isListen(e.playedSeconds, e.duration)) row.listens += 1;
          counts.set(key, row);
        }
        const results = [...counts.values()]
          .sort((x, y) => y.listens - x.listens || y.plays - x.plays)
          .slice(0, limit);
        return ok({
          by: a.by,
          listen_definition: "half the track or four minutes of real play time",
          results,
        });
      },
    },
    history_summary: {
      inputSchema: {
        streamer: STREAMER_ARG,
        from: z.string().optional().describe("Earliest local date, YYYY-MM-DD."),
        to: z.string().optional().describe("Latest local date, YYYY-MM-DD, inclusive."),
        top: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many of each top list (default 10)."),
      },
      // History's Stats view as a tool (2026-09-14, the MCP round three): the same
      // statsFor the screen draws from (shared/historyStats), so the figures agree.
      handler: async (a) => {
        const { events: everyLine } = await listeningRecord.readAll();
        const keep = streamerKeep(a.streamer, dm.snapshot().devices);
        const events = keep ? everyLine.filter(keep) : everyLine;
        const fromMs = a.from != null ? Date.parse(`${a.from as string}T00:00:00`) : null;
        const toMs = a.to != null ? Date.parse(`${a.to as string}T23:59:59.999`) : null;
        if ((fromMs != null && Number.isNaN(fromMs)) || (toMs != null && Number.isNaN(toMs)))
          return err("from and to must be YYYY-MM-DD.");
        const st = statsFor(events, {
          from: fromMs ?? 0,
          to: toMs != null ? toMs + 1 : Number.POSITIVE_INFINITY,
        });
        const top = (a.top as number | undefined) ?? 10;
        const list = (rows: TopEntry[]): unknown[] =>
          rows.slice(0, top).map((r) => ({
            name: r.name,
            ...(r.sub ? { sub: r.sub } : {}),
            ...(r.album ? { album: r.album } : {}),
            plays: r.plays,
            seconds: r.seconds,
          }));
        const localDay = (ms: number): string => {
          const d = new Date(ms);
          const p = (n: number): string => String(n).padStart(2, "0");
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        };
        const grid: number[][] = [];
        for (let day = 0; day < 7; day++)
          grid.push(st.byWeekdayHour.slice(day * 24, day * 24 + 24));
        return ok({
          period: { from: a.from ?? null, to: a.to ?? null },
          listen_definition: "half the track or four minutes of real play time",
          plays: st.plays,
          listens: st.listens,
          time_heard_seconds: st.seconds,
          radio_seconds: st.radioSeconds,
          external_seconds: st.externalSeconds,
          radio_songs: st.radioSongs,
          distinct: { albums: st.albums, artists: st.artists, tracks: st.tracks },
          days_with_listening: st.days,
          top_albums: list(st.topAlbums),
          top_artists: list(st.topArtists),
          top_tracks: list(st.topTracks),
          top_stations: list(st.topStations),
          ...(st.viaSeen
            ? {
                top_presets: list(st.topPresets),
                top_playlists: list(st.topPlaylists),
                started_from: st.startedFrom,
              }
            : {}),
          by_source: st.bySource,
          quality: st.quality,
          weekday_hour_seconds: {
            note: "rows Monday to Sunday, columns hour 0 to 23, seconds of library play",
            rows: grid,
          },
          seconds_by_day: [...st.byDay.entries()]
            .sort((x, y) => x[0] - y[0])
            .map(([day, seconds]) => ({ day: localDay(day), seconds })),
        });
      },
    },
    history_elsewhere: {
      inputSchema: {
        streamer: STREAMER_ARG,
        in_library: z
          .enum(["all", "yes", "no"])
          .optional()
          .describe("Default all; 'no' is the artists the library does not have."),
        limit: z.number().int().min(1).max(200).optional().describe("Artists, default 40."),
        tracks_per_artist: z.number().int().min(0).max(50).optional().describe("Default 5."),
      },
      // History's Elsewhere view as a tool: the same heardElsewhere (shared/elsewhere)
      // over the record and the library index, so "in your library" is the Library's
      // own rule for an artist page.
      handler: async (a) => {
        const { events: everyLine } = await listeningRecord.readAll();
        const keep = streamerKeep(a.streamer, dm.snapshot().devices);
        const events = keep ? everyLine.filter(keep) : everyLine;
        const heard = heardElsewhere(events, indexPools());
        const want = (a.in_library as string | undefined) ?? "all";
        const artists = heard.artists.filter((x) =>
          want === "yes" ? x.inLibrary : want === "no" ? !x.inLibrary : true,
        );
        const limit = (a.limit as number | undefined) ?? 40;
        const perArtist = (a.tracks_per_artist as number | undefined) ?? 5;
        return ok({
          sources: heard.sources,
          stations: heard.stations,
          total: artists.length,
          returned: Math.min(limit, artists.length),
          artists: artists.slice(0, limit).map((x) => ({
            name: x.name,
            heard: x.heard,
            last_heard: new Date(x.lastAt).toISOString(),
            where: x.where,
            in_library: x.inLibrary,
            library_albums: x.albums,
            library_credits: x.credits,
            owned_tracks: x.ownedTracks,
            tracks: x.tracks.slice(0, perArtist).map((tr) => ({
              title: tr.title,
              ...(tr.artist ? { artist: tr.artist } : {}),
              ...(tr.album ? { album: tr.album } : {}),
              where: tr.where,
              heard: tr.heard,
              last_heard: new Date(tr.lastAt).toISOString(),
              in_library: tr.owned,
            })),
          })),
        });
      },
    },
    history_shelves: {
      inputSchema: {
        streamer: STREAMER_ARG,
        limit: z.number().int().min(1).max(100).optional().describe("Per shelf, default 12."),
      },
      // History's Rediscover view as a tool: the four shelves from the one
      // shelvesFor (shared/rediscover) the screen reads.
      handler: async (a) => {
        const groups = indexPools();
        if (groups.length === 0) return err(ctx.kickIndex());
        const stats = await playStatsFromRecord(streamerKeep(a.streamer, dm.snapshot().devices));
        const shelves = shelvesFor(groups, stats, Date.now());
        const limit = (a.limit as number | undefined) ?? 12;
        const row = (s: (typeof shelves.quiet)[number]): unknown => ({
          server_udn: s.album.serverUdn,
          object_id: s.album.id,
          title: s.album.title,
          artist: s.album.artist,
          year: s.album.year,
          plays: s.plays,
          last_played: s.lastAt > 0 ? new Date(s.lastAt).toISOString() : null,
          tracks: s.tracks,
          tracks_reached: s.reached,
        });
        return ok({
          shelves: {
            unfinished: `started and not finished, nothing since for ${UNFINISHED_QUIET_DAYS} days`,
            more_from: "unplayed albums by the artists played most",
            quiet: `played, but not in ${REDISCOVER_QUIET_DAYS} days, longest ago first`,
            never_played: "no recorded play since the record began",
          },
          unfinished: shelves.unfinished.slice(0, limit).map(row),
          more_from: shelves.moreFrom.slice(0, limit).map(row),
          quiet: shelves.quiet.slice(0, limit).map(row),
          never_played: shelves.neverPlayed.slice(0, limit).map(row),
          counts: {
            unfinished: shelves.unfinished.length,
            more_from: shelves.moreFrom.length,
            quiet: shelves.quiet.length,
            never_played: shelves.neverPlayed.length,
          },
        });
      },
    },
    history_on_this_day: {
      inputSchema: {
        streamer: STREAMER_ARG,
        month: z.number().int().min(1).max(12).optional().describe("Default: today's month."),
        day: z.number().int().min(1).max(31).optional().describe("Default: today's day."),
      },
      handler: async (a) => {
        const now = new Date();
        const month = (a.month as number | undefined) ?? now.getMonth() + 1;
        const day = (a.day as number | undefined) ?? now.getDate();
        const { events: everyLine } = await listeningRecord.readAll();
        const keep = streamerKeep(a.streamer, dm.snapshot().devices);
        const events = keep ? everyLine.filter(keep) : everyLine;
        const hits = events
          .filter((e) => {
            // The local day AS IT WAS RECORDED: shift by the stored tz
            // offset, then read the shifted date's UTC fields.
            const local = new Date(e.at - e.tzOffsetMin * 60000);
            return local.getUTCMonth() + 1 === month && local.getUTCDate() === day;
          })
          .sort((x, y) => y.at - x.at)
          .map((e) => ({
            ...e,
            at: new Date(e.at).toISOString(),
            ...(e.kind === "play" ? { listen: isListen(e.playedSeconds, e.duration) } : {}),
          }));
        return ok({ month, day, total: hits.length, events: hits });
      },
    },
    history_first_listen: {
      inputSchema: {
        streamer: STREAMER_ARG,
        title: z.string().describe("Track title, case-insensitive exact match."),
        artist: z
          .string()
          .optional()
          .describe("Narrow by artist, case-insensitive substring of the recorded artist."),
      },
      handler: async (a) => {
        const lc = (v: string): string => v.trim().toLowerCase();
        const { events: everyLine } = await listeningRecord.readAll();
        const keep = streamerKeep(a.streamer, dm.snapshot().devices);
        const events = keep ? everyLine.filter(keep) : everyLine;
        const plays = events
          .filter(
            (e): e is ListeningPlayEvent =>
              e.kind === "play" &&
              lc(e.title) === lc(a.title as string) &&
              (a.artist == null || (e.artist ?? "").toLowerCase().includes(lc(a.artist as string))),
          )
          .sort((x, y) => x.at - y.at);
        if (plays.length === 0) return ok({ found: false });
        const listens = plays.filter((e) => isListen(e.playedSeconds, e.duration));
        return ok({
          found: true,
          first_played: new Date(plays[0].at).toISOString(),
          first_listen: listens.length > 0 ? new Date(listens[0].at).toISOString() : null,
          plays: plays.length,
          listens: listens.length,
        });
      },
    },
    // ---- the record's reading surfaces as tools (0.8.0)
    history_stats: {
      inputSchema: {
        streamer: STREAMER_ARG,
        title: z
          .string()
          .optional()
          .describe(
            "A track title (add artist/album to disambiguate). Omit title AND album for the playing track.",
          ),
        artist: z.string().optional(),
        album: z.string().optional().describe("With no title: the whole album's tally."),
      },
      handler: async (a) => {
        const stats = await playStatsFromRecord(streamerKeep(a.streamer, dm.snapshot().devices));
        const md = dm.snapshot().playState?.metadata;
        const title =
          (a.title as string | undefined) ?? (a.album ? undefined : (md?.title ?? undefined));
        const artist =
          (a.artist as string | undefined) ??
          (a.title || a.album ? undefined : (md?.artist ?? undefined));
        const album =
          (a.album as string | undefined) ?? (a.title ? undefined : (md?.album ?? undefined));
        const since = stats.since != null ? new Date(stats.since).toISOString() : null;
        const lc = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();
        if (title) {
          const exact = stats.tracks[playKey(title, artist ?? null, album ?? null)];
          const loose = exact
            ? [exact]
            : Object.entries(stats.tracks)
                .filter(
                  ([k]) =>
                    k.startsWith(`${lc(title)}|`) && (!artist || k.includes(`|${lc(artist)}|`)),
                )
                .map(([, v]) => v);
          if (loose.length === 0)
            return ok({
              track: { title, artist: artist ?? null, album: album ?? null },
              plays: 0,
              listens: 0,
              last_played: null,
              seconds_heard: 0,
              record_since: since,
            });
          const plays = loose.reduce((n, v) => n + v.plays, 0);
          const listens = loose.reduce((n, v) => n + v.listens, 0);
          const lastAt = Math.max(...loose.map((v) => v.lastAt));
          const seconds = loose.reduce((n, v) => n + v.seconds, 0);
          return ok({
            track: { title, artist: artist ?? null, album: album ?? null },
            plays,
            listens,
            last_played: new Date(lastAt).toISOString(),
            seconds_heard: seconds,
            record_since: since,
          });
        }
        if (album) {
          let plays = 0,
            listens = 0,
            seconds = 0,
            lastAt = 0;
          const titles = new Set<string>();
          for (const [k, v] of Object.entries(stats.tracks)) {
            const [t, ar, al] = k.split("|");
            if (al !== lc(album)) continue;
            if (artist && ar !== lc(artist)) continue;
            plays += v.plays;
            listens += v.listens;
            seconds += v.seconds;
            lastAt = Math.max(lastAt, v.lastAt);
            titles.add(t);
          }
          return ok({
            album: { title: album, artist: artist ?? null },
            plays,
            listens,
            distinct_tracks_played: titles.size,
            last_played: lastAt > 0 ? new Date(lastAt).toISOString() : null,
            seconds_heard: seconds,
            record_since: since,
          });
        }
        return err("Nothing is playing and no track or album was named.");
      },
    },
    history_unplayed: {
      inputSchema: {
        streamer: STREAMER_ARG,
        artist: z.string().optional().describe("Case-insensitive substring on the album artist."),
        genre: z.string().optional(),
        decade: z.string().optional().describe("e.g. '1990s'."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
        offset: z.number().int().min(0).optional(),
      },
      handler: async (a) => {
        const groups = indexPools();
        if (groups.length === 0) return err(ctx.kickIndex());
        const stats = await playStatsFromRecord(streamerKeep(a.streamer, dm.snapshot().devices));
        const poolOf = new Map(groups.map((p) => [p.udn, p]));
        const artistNeedle = (a.artist as string | undefined)?.toLowerCase();
        const genreNeedle = (a.genre as string | undefined)?.toLowerCase();
        const decade = a.decade != null ? String(a.decade).replace(/s$/i, "") : null;
        const albums = groups
          .flatMap((p) => p.albums)
          .filter(
            (n) => artistNeedle == null || (n.artist ?? "").toLowerCase().includes(artistNeedle),
          )
          .filter(
            (n) =>
              genreNeedle == null || (n.genre ?? []).some((g) => g.toLowerCase() === genreNeedle),
          )
          .filter(
            (n) =>
              decade == null ||
              (n.year != null && String(Math.floor(Number(n.year) / 10) * 10) === decade),
          )
          .filter((n) => {
            const pool = n.serverUdn ? poolOf.get(n.serverUdn) : undefined;
            return pool ? albumTally(n, pool, stats).plays === 0 : true;
          })
          .sort(
            (x, y) =>
              nameSortKey(x.artist ?? "￿").localeCompare(nameSortKey(y.artist ?? "￿")) ||
              x.title.localeCompare(y.title),
          );
        const offset = (a.offset as number | undefined) ?? 0;
        const limit = (a.limit as number | undefined) ?? 50;
        const page = albums.slice(offset, offset + limit);
        return ok({
          record_since: stats.since != null ? new Date(stats.since).toISOString() : null,
          note: "Unplayed means no recorded play since the listening record began, not never.",
          total: albums.length,
          offset,
          returned: page.length,
          albums: page.map((n) => ({
            server_udn: n.serverUdn,
            object_id: n.id,
            title: n.title,
            artist: n.artist,
            year: n.year,
            genres: n.genre ?? [],
          })),
        });
      },
    },
    history_rediscover: {
      inputSchema: {
        streamer: STREAMER_ARG,
        not_since: z
          .string()
          .optional()
          .describe("Local date YYYY-MM-DD; albums last played BEFORE ctx. Default: 90 days ago."),
        min_plays: z.number().int().min(1).optional().describe("Default 1."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 30."),
      },
      handler: async (a) => {
        const groups = indexPools();
        if (groups.length === 0) return err(ctx.kickIndex());
        const stats = await playStatsFromRecord(streamerKeep(a.streamer, dm.snapshot().devices));
        const cutoff =
          a.not_since != null
            ? Date.parse(`${a.not_since as string}T00:00:00`)
            : Date.now() - REDISCOVER_QUIET_DAYS * 86_400_000;
        if (Number.isNaN(cutoff)) return err("not_since must be YYYY-MM-DD.");
        const minPlays = (a.min_plays as number | undefined) ?? 1;
        const poolOf = new Map(groups.map((p) => [p.udn, p]));
        const rows = groups
          .flatMap((p) => p.albums)
          .flatMap((n) => {
            const pool = n.serverUdn ? poolOf.get(n.serverUdn) : undefined;
            const { plays, lastAt } = pool ? albumTally(n, pool, stats) : { plays: 0, lastAt: 0 };
            return plays >= minPlays && lastAt > 0 && lastAt < cutoff ? [{ n, plays, lastAt }] : [];
          });
        rows.sort((x, y) => x.lastAt - y.lastAt);
        const limit = (a.limit as number | undefined) ?? 30;
        return ok({
          not_since: new Date(cutoff).toISOString(),
          total: rows.length,
          returned: Math.min(limit, rows.length),
          albums: rows.slice(0, limit).map(({ n, plays, lastAt }) => ({
            server_udn: n.serverUdn,
            object_id: n.id,
            title: n.title,
            artist: n.artist,
            year: n.year,
            plays,
            last_played: new Date(lastAt).toISOString(),
          })),
        });
      },
    },
    history_resume: {
      handler: async () => {
        const offer = await ctx.resumeOffer();
        if ("reason" in offer) return ok({ offer: null, reason: offer.reason });
        return ok({
          offer: {
            album: offer.node.title,
            artist: offer.node.artist,
            server_udn: offer.node.serverUdn,
            object_id: offer.node.id,
            resume_from: { title: offer.target.title, track: offer.position, of: offer.total },
            last_played: new Date(offer.run.last.at).toISOString(),
            plays_in_run: offer.run.plays.length,
            how: "resume_playback plays it from that track (opt-in queue editing).",
          },
        });
      },
    },
  };
}
