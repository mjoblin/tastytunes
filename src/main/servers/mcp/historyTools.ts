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
              (a.kind == null || e.kind === a.kind),
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
        by: z.enum(["artists", "albums", "tracks"]).describe("What to rank."),
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
        const limit = (a.limit as number | undefined) ?? 20;
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
