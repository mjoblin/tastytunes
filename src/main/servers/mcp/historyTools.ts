import { z } from "zod";
import {
  isListen,
  type ListeningEvent,
  type ListeningPlayEvent,
  playKey,
  REDISCOVER_QUIET_DAYS,
  trackArtists,
} from "@shared/model";
import { playStatsFromRecord } from "../../data/playStats";
import { listeningRecord } from "../../data/listeningRecord";
import { pools as indexPools } from "../../media/mediaIndex";
import { statsFor, type TopEntry } from "@shared/historyStats";
import { heardElsewhere, mostHeardFirst } from "@shared/elsewhere";
import { shelvesFor, UNFINISHED_QUIET_DAYS } from "@shared/rediscover";
import {
  type ToolContext,
  type ToolImpl,
  ok,
  err,
  STREAMER_ARG,
  streamerKeep,
  defineTool,
  localTime,
  dayRange,
  DETAIL_ARG,
  PERIOD_ARG,
  rowIds,
  titleMatcher,
  titleFold,
  nearestTitles,
  type TitleRef,
  type Titled,
  type ToolResult,
} from "./toolkit";
import { matchesQuery, nameKey } from "@shared/keys";

// The MCP bridge's history tools (the listening record: recents, stats, the unplayed and the
// resume offer), one of six tool modules split out of mcpServer.ts 2026-09-13; the shapes and
// helpers they share live in ./toolkit.

/**
 * A line of the record as list_history and history_on_this_day answer it (0.16.0, brief rows): its
 * local time (the offset it was recorded at), its kind and what a person asks about it, with a
 * play's listen flag; detail "full" keeps every stored field (the streamer, the source's id, the
 * picture's address, the format). Before, every row was the stored line as it was.
 */
function eventRow(
  e: ListeningEvent,
  detail: "brief" | "full" | undefined,
  ids: ReturnType<typeof rowIds>,
): Record<string, unknown> {
  const at = localTime(e.at, e.tzOffsetMin);
  // a library play carries its track's ids when the index has it (0.16.0), to play it again by
  const played = e.kind === "play" ? ids.track(e) : {};
  const listen = e.kind === "play" ? { listen: isListen(e.playedSeconds, e.duration) } : {};
  if (detail === "full") return { ...e, at, ...listen, ...played };
  switch (e.kind) {
    case "play":
      return {
        at,
        kind: e.kind,
        title: e.title,
        artist: e.artist,
        album: e.album,
        source: e.source,
        seconds_played: e.playedSeconds,
        duration_seconds: e.duration,
        ...listen,
        ...played,
      };
    case "radio-session":
      return { at, kind: e.kind, station: e.station, seconds_played: e.playedSeconds };
    case "radio-track":
      return { at, kind: e.kind, station: e.station, title: e.title, artist: e.artist };
    case "external":
      return {
        at,
        kind: e.kind,
        source: e.source,
        title: e.title,
        artist: e.artist,
        album: e.album,
        seconds_played: e.playedSeconds,
      };
    default: {
      // a kind a later version writes: readers pass it through untouched (the record's format)
      const later: Record<string, unknown> = e;
      return { ...later, at };
    }
  }
}

/** The library's tracks as the title match reads them. */
const indexTitled = (): Titled[] =>
  indexPools().flatMap((p) =>
    p.tracks.map((n) => ({ title: n.title, credits: [...trackArtists(n), n.albumArtist] })),
  );
const titled = (t: Titled): Titled => t;
const playTitled = (e: ListeningPlayEvent): Titled => ({ title: e.title, credits: [e.artist] });

/** Whether the library has the track a title names (a track it has and never played has a true
 *  answer of no plays; one it lacks too is a miss to say). */
const inLibrary = (ref: TitleRef): boolean => titleMatcher(indexTitled(), titled)(ref).length > 0;

/** A title neither the record nor the library has, with the nearest either holds (0.16.0: it had
 *  answered zero plays, as a success). */
function unknownTitle(ref: TitleRef, plays: readonly ListeningPlayEvent[]): ToolResult {
  const near = nearestTitles(ref, [...plays.map(playTitled), ...indexTitled()], titled);
  return err(
    `No track titled "${ref.title}"${ref.artist ? ` by ${ref.artist}` : ""} in the library or the listening record.${near.length > 0 ? ` The nearest: ${near.map((t) => `"${t}"`).join(", ")}.` : ""}`,
  );
}

/** A title that set aside its trailing part and so met several songs: they are named to choose. */
const severalTitles = (ref: TitleRef, titles: Iterable<string>): ToolResult =>
  err(
    `"${ref.title}" names more than one track: ${[...new Set(titles)].map((t) => `"${t}"`).join(", ")}. Give the whole title.`,
  );

export function historyTools(ctx: ToolContext): Record<string, ToolImpl> {
  const { dm } = ctx;
  return {
    list_history: defineTool({
      inputSchema: {
        streamer: STREAMER_ARG,
        from: z.string().optional().describe("Earliest local date, YYYY-MM-DD."),
        to: z.string().optional().describe("Latest local date, YYYY-MM-DD, inclusive."),
        period: PERIOD_ARG,
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
        detail: DETAIL_ARG,
      },
      // Local files only — works with the streamer off, so no connected() gate.
      handler: async (a) => {
        const { events: everyLine, unreadable, later } = await listeningRecord.readAll();
        const keep = streamerKeep(a.streamer, dm.snapshot().devices);
        const events = keep ? everyLine.filter(keep) : everyLine;
        const range = dayRange(a);
        if ("error" in range) return err(range.error);
        const { from: fromMs, to: toMs } = range;
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
        const offset = a.offset ?? 0;
        const limit = a.limit ?? 50;
        const ids = rowIds();
        const page = filtered.slice(offset, offset + limit).map((e) => eventRow(e, a.detail, ids));
        return ok({
          total: filtered.length,
          offset,
          returned: page.length,
          ...(unreadable > 0 ? { unreadable_lines: unreadable } : {}),
          // a later version's lines, kept in the record and not counted here
          ...(later > 0 ? { later_version_lines: later } : {}),
          events: page,
        });
      },
    }),
    history_top: defineTool({
      inputSchema: {
        streamer: STREAMER_ARG,
        by: z
          .enum(["artists", "albums", "tracks", "stations", "presets", "playlists"])
          .describe(
            "What to rank: library artists, albums or tracks by listens; or the stations most tuned, and the presets and playlists most started from (the Stats view's lists).",
          ),
        from: z.string().optional().describe("Earliest local date, YYYY-MM-DD."),
        to: z.string().optional().describe("Latest local date, YYYY-MM-DD, inclusive."),
        period: PERIOD_ARG,
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
      handler: async (a) => {
        const { events: everyLine } = await listeningRecord.readAll();
        const keep = streamerKeep(a.streamer, dm.snapshot().devices);
        const events = keep ? everyLine.filter(keep) : everyLine;
        const range = dayRange(a);
        if ("error" in range) return err(range.error);
        const { from: fromMs, to: toMs } = range;
        const limit = a.limit ?? 20;
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
            // the name and what qualifies it apart, never one joined label (0.16.0)
            results: rows.slice(0, limit).map((r) => ({
              name: r.name,
              ...(r.sub ? { sub: r.sub } : {}),
              plays: r.plays,
              seconds: r.seconds,
            })),
          });
        }
        // each rank's fields apart (0.16.0: one joined "title · artist" label an agent had to split
        // before it could search), and the album's or track's ids when the index has it
        const counts = new Map<string, { e: ListeningPlayEvent; plays: number; listens: number }>();
        for (const e of events) {
          // Library plays only: a count means "played from the library".
          if (e.kind !== "play") continue;
          if ((fromMs != null && e.at < fromMs) || (toMs != null && e.at > toMs)) continue;
          const key =
            a.by === "artists"
              ? nameKey(e.artist ?? "")
              : a.by === "albums"
                ? `${nameKey(e.album ?? "")}|${nameKey(e.artist ?? "")}`
                : `${nameKey(e.title)}|${nameKey(e.artist ?? "")}`;
          const row = counts.get(key) ?? { e, plays: 0, listens: 0 };
          row.plays += 1;
          if (isListen(e.playedSeconds, e.duration)) row.listens += 1;
          counts.set(key, row);
        }
        const ids = rowIds();
        const results = [...counts.values()]
          .sort((x, y) => y.listens - x.listens || y.plays - x.plays)
          .slice(0, limit)
          .map(({ e, plays, listens }) =>
            a.by === "artists"
              ? { artist: e.artist ?? "Unknown artist", plays, listens }
              : a.by === "albums"
                ? {
                    album: e.album ?? "Unknown album",
                    artist: e.artist,
                    plays,
                    listens,
                    ...ids.album(e.album, e.artist),
                  }
                : {
                    title: e.title,
                    artist: e.artist,
                    album: e.album,
                    plays,
                    listens,
                    ...ids.track(e),
                  },
          );
        return ok({
          by: a.by,
          listen_definition: "half the track or four minutes of real play time",
          results,
        });
      },
    }),
    history_summary: defineTool({
      inputSchema: {
        streamer: STREAMER_ARG,
        from: z.string().optional().describe("Earliest local date, YYYY-MM-DD."),
        to: z.string().optional().describe("Latest local date, YYYY-MM-DD, inclusive."),
        period: PERIOD_ARG,
        top: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many of each top list (default 10)."),
        include: z
          .array(z.enum(["hours", "calendar"]))
          .optional()
          .describe(
            "The large parts, on request: 'hours' the weekday by hour grid (168 cells), 'calendar' the seconds heard on each day.",
          ),
      },
      // History's Stats view as a tool (2026-09-14, the MCP round three): the same
      // statsFor the screen draws from (shared/historyStats), so the figures agree.
      handler: async (a) => {
        const { events: everyLine } = await listeningRecord.readAll();
        const keep = streamerKeep(a.streamer, dm.snapshot().devices);
        const events = keep ? everyLine.filter(keep) : everyLine;
        const range = dayRange(a);
        if ("error" in range) return err(range.error);
        const { from: fromMs, to: toMs } = range;
        const st = statsFor(events, {
          from: fromMs ?? 0,
          to: toMs != null ? toMs + 1 : Number.POSITIVE_INFINITY,
        });
        const top = a.top ?? 10;
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
          // the days asked about, as resolved (0.16.0: a named period had echoed two nulls)
          period: {
            from: fromMs != null ? localDay(fromMs) : null,
            to: toMs != null ? localDay(toMs) : null,
          },
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
          // the two large parts only when asked (0.16.0: a grid of 168 cells and a row per day
          // were half of every summary)
          ...(a.include?.includes("hours")
            ? {
                weekday_hour_seconds: {
                  note: "rows Monday to Sunday, columns hour 0 to 23, seconds of library play",
                  rows: grid,
                },
              }
            : {}),
          ...(a.include?.includes("calendar")
            ? {
                seconds_by_day: [...st.byDay.entries()]
                  .sort((x, y) => x[0] - y[0])
                  .map(([day, seconds]) => ({ day: localDay(day), seconds })),
              }
            : {}),
        });
      },
    }),
    history_elsewhere: defineTool({
      inputSchema: {
        streamer: STREAMER_ARG,
        in_library: z
          .enum(["all", "yes", "no"])
          .optional()
          .describe("Default all; 'no' is the artists the library does not have."),
        limit: z.number().int().min(1).max(200).optional().describe("Artists, default 20."),
        tracks_per_artist: z.number().int().min(0).max(50).optional().describe("Default 3."),
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
        const artists = heard.artists
          .filter((x) => (want === "yes" ? x.inLibrary : want === "no" ? !x.inLibrary : true))
          .sort(mostHeardFirst);
        const limit = a.limit ?? 20;
        const perArtist = a.tracks_per_artist ?? 3;
        return ok({
          sources: heard.sources,
          stations: heard.stations,
          total: artists.length,
          returned: Math.min(limit, artists.length),
          artists: artists.slice(0, limit).map((x) => ({
            name: x.name,
            heard: x.heard,
            last_heard: localTime(x.lastAt),
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
              last_heard: localTime(tr.lastAt),
              in_library: tr.owned,
            })),
          })),
        });
      },
    }),
    history_shelves: defineTool({
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
        const limit = a.limit ?? 12;
        const row = (s: (typeof shelves.quiet)[number]): unknown => ({
          server_udn: s.album.serverUdn,
          object_id: s.album.id,
          title: s.album.title,
          artist: s.album.artist,
          year: s.album.year,
          plays: s.plays,
          last_played: s.lastAt > 0 ? localTime(s.lastAt) : null,
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
    }),
    history_on_this_day: defineTool({
      inputSchema: {
        streamer: STREAMER_ARG,
        month: z.number().int().min(1).max(12).optional().describe("Default: today's month."),
        day: z.number().int().min(1).max(31).optional().describe("Default: today's day."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
        offset: z.number().int().min(0).optional().describe("For paging; default 0."),
        detail: DETAIL_ARG,
      },
      handler: async (a) => {
        const now = new Date();
        const month = a.month ?? now.getMonth() + 1;
        const day = a.day ?? now.getDate();
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
          .sort((x, y) => y.at - x.at);
        // bounded (0.16.0: a busy day across the years was 150 events, every one in full)
        const offset = a.offset ?? 0;
        const limit = a.limit ?? 50;
        const ids = rowIds();
        const page = hits.slice(offset, offset + limit).map((e) => eventRow(e, a.detail, ids));
        return ok({ month, day, total: hits.length, offset, returned: page.length, events: page });
      },
    }),
    history_first_listen: defineTool({
      inputSchema: {
        streamer: STREAMER_ARG,
        title: z
          .string()
          .describe(
            "Track title, case, accents and punctuation ignored; with artist, a trailing part in parentheses or brackets may be left off.",
          ),
        artist: z
          .string()
          .optional()
          .describe("Narrow by artist: its words in the recorded artist."),
      },
      handler: async (a) => {
        const { events: everyLine } = await listeningRecord.readAll();
        const keep = streamerKeep(a.streamer, dm.snapshot().devices);
        const events = keep ? everyLine.filter(keep) : everyLine;
        const every = events.filter((e): e is ListeningPlayEvent => e.kind === "play");
        // the agent's title match (toolkit's titleMatcher), as a track reference is matched
        const ref = { title: a.title, artist: a.artist };
        const plays = titleMatcher(every, playTitled)(ref).sort((x, y) => x.at - y.at);
        if (new Set(plays.map((e) => titleFold(e.title))).size > 1)
          return severalTitles(
            ref,
            plays.map((e) => e.title),
          );
        if (plays.length === 0)
          return inLibrary(ref) ? ok({ found: false }) : unknownTitle(ref, every);
        const listens = plays.filter((e) => isListen(e.playedSeconds, e.duration));
        return ok({
          found: true,
          title: plays[0].title,
          first_played: localTime(plays[0].at),
          first_listen: listens.length > 0 ? localTime(listens[0].at) : null,
          plays: plays.length,
          listens: listens.length,
        });
      },
    }),
    // ---- the record's reading surfaces as tools (0.8.0)
    history_stats: defineTool({
      inputSchema: {
        streamer: STREAMER_ARG,
        server_udn: z
          .string()
          .optional()
          .describe("With object_id: a library track or album, from a listing, instead of names."),
        object_id: z.string().optional().describe("The track's or album's id."),
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
        // by its ids (0.16.0): a track's or an album's names as the index has them
        let named = { title: a.title, artist: a.artist, album: a.album };
        if (a.server_udn != null || a.object_id != null) {
          if (a.server_udn == null || a.object_id == null)
            return err("Give server_udn and object_id together, from a listing.");
          const pool = indexPools().find((p) => p.udn === a.server_udn);
          const node =
            pool?.tracks.find((n) => n.id === a.object_id) ??
            pool?.albums.find((n) => n.id === a.object_id);
          if (!node)
            return err(`No track or album '${String(a.object_id)}' in that server's index.`);
          named = node.isContainer
            ? { title: undefined, artist: node.artist ?? undefined, album: node.title }
            : {
                title: node.title,
                artist: node.artist ?? undefined,
                album: node.album ?? undefined,
              };
        }
        const md = dm.snapshot().playState?.metadata;
        const title = named.title ?? (named.album ? undefined : (md?.title ?? undefined));
        const artist =
          named.artist ?? (named.title || named.album ? undefined : (md?.artist ?? undefined));
        const album = named.album ?? (named.title ? undefined : (md?.album ?? undefined));
        const since = stats.since != null ? localTime(stats.since) : null;
        if (title) {
          const exact = stats.tracks[playKey(title, artist ?? null, album ?? null)];
          let loose = exact ? [exact] : [];
          if (!exact) {
            // the agent's title match over the record's keys (title|artist|album)
            const keyed = Object.entries(stats.tracks).map(([k, v]) => {
              const [t, ar] = k.split("|");
              return { t, ar, v };
            });
            const hits = titleMatcher(keyed, (x) => ({ title: x.t, credits: [x.ar] }))({
              title,
              artist,
            });
            if (new Set(hits.map((x) => titleFold(x.t))).size > 1)
              return severalTitles(
                { title, artist },
                hits.map((x) => x.t),
              );
            loose = hits.map((x) => x.v);
          }
          // a title the agent named that the library lacks too is a miss, not zero plays
          if (loose.length === 0 && a.title != null && !inLibrary({ title, artist })) {
            const { events: everyLine } = await listeningRecord.readAll();
            return unknownTitle(
              { title, artist },
              everyLine.filter((e): e is ListeningPlayEvent => e.kind === "play"),
            );
          }
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
            last_played: localTime(lastAt),
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
            if (titleFold(al) !== titleFold(album)) continue;
            if (artist && !matchesQuery(artist, [ar])) continue;
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
            last_played: lastAt > 0 ? localTime(lastAt) : null,
            seconds_heard: seconds,
            record_since: since,
          });
        }
        return err("Nothing is playing and no track or album was named.");
      },
    }),
    history_resume: defineTool({
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
            last_played: localTime(offer.run.last.at),
            plays_in_run: offer.run.plays.length,
            how: "resume_album plays it from that track (opt-in queue editing).",
          },
        });
      },
    }),
  };
}
