import { useEffect, useMemo } from "react";
import {
  type ListeningPlayEvent,
  type PlayStat,
  type PlayStats,
  type CopyRow,
  copiesOf,
  copyStat,
  nodeFacts,
  peersByPlayKey,
  playKey,
  sameCopyRow,
} from "@shared/model";
import { useStore } from "@/store";
import { useIndexPools } from "@/hooks/useIndexPools";

/**
 * The listening record's reading surfaces (0.8.0, round one). ONE hook hands
 * every surface the same stats and the same lookups: a track's tally by its
 * play key, an album's tally as the fold of its tracks (so a compilation's
 * plays land on the compilation, whoever performed them), and the record's
 * start for "since" copy. Loads once on first use; live afterwards via the
 * store's playEvent fold. Since 0.13.0 a row reads its own COPY's tally: the
 * index's tracks are the other copies its plays are told apart from
 * (shared/model/copies), so two takes on one album, or two copies of one
 * album, no longer share one count.
 */
export function usePlayStats(): PlayStatsView {
  const stats = useStore((s) => s.playStats);
  const load = useStore((s) => s.loadPlayStats);
  // ONE gate for every surface: the record off, or its display off (Settings ›
  // History), and no surface has stats — the sorts step aside, the facet
  // hides, the header fact and the resume offer stay away
  const enabled = useStore((s) => s.settings.listeningRecord && s.settings.showListeningHistory);
  useEffect(() => {
    if (enabled && stats == null) void load();
  }, [enabled, stats, load]);
  const pools = useIndexPools(enabled);
  const peersOf = useMemo(() => peersByPlayKey(pools ?? []), [pools]);
  return useMemo(() => (enabled ? viewOf(stats, peersOf) : EMPTY), [enabled, stats, peersOf]);
}

export interface PlayStatsView {
  ready: boolean;
  since: number | null;
  recent: ListeningPlayEvent[];
  /** A track's tally, its copy's share (`peers`: rows beside it that may be other copies,
   *  besides the index's). */
  track(node: CopyRow, peers?: readonly CopyRow[]): PlayStat | null;
  /** An album's tally over its tracks: total plays, most recent start, and
   *  its WHOLE listens — runs in which every one of these tracks was heard as
   *  a listen (0.8.0 round two; the record's runs against the index's tracks).
   *  One copy's tracks give that copy's tally. */
  album(tracks: readonly CopyRow[]): {
    plays: number;
    lastAt: number | null;
    whole: number;
    lastWholeAt: number | null;
  };
}

const EMPTY: PlayStatsView = {
  ready: false,
  since: null,
  recent: [],
  track: () => null,
  album: () => ({ plays: 0, lastAt: null, whole: 0, lastWholeAt: null }),
};

export function viewOf(
  stats: PlayStats | null,
  peersOf: (key: string) => readonly CopyRow[] = () => [],
): PlayStatsView {
  if (!stats) return EMPTY;
  const track = (node: CopyRow, peers: readonly CopyRow[] = []): PlayStat | null =>
    copyStat(stats, node, [...peersOf(playKey(node.title, node.artist, node.album)), ...peers]);
  return {
    ready: true,
    since: stats.since,
    recent: stats.recent,
    track,
    album: (tracks) => {
      let plays = 0;
      let lastAt: number | null = null;
      for (const t of tracks) {
        const st = track(t, tracks);
        if (!st) continue;
        plays += st.plays;
        if (lastAt == null || st.lastAt > lastAt) lastAt = st.lastAt;
      }
      // whole listens: a run that heard every track (by play key) as a listen
      let whole = 0;
      let lastWholeAt: number | null = null;
      if (tracks.length > 0) {
        const keys = new Set(tracks.map((t) => playKey(t.title, t.artist, t.album)));
        const albumKeys = new Set(tracks.map((t) => playKey(null, null, t.album)));
        // another copy of this album in the library: a run is this copy's when its facts say so,
        // read against one track the copies share (a run without facts could be any copy's)
        let probe: { t: CopyRow; copies: CopyRow[] } | null = null;
        for (const t of tracks) {
          const others = peersOf(playKey(t.title, t.artist, t.album)).filter(
            (p) => !tracks.some((x) => sameCopyRow(x, p)),
          );
          if (others.length > 0) {
            probe = { t, copies: [t, ...others] };
            break;
          }
        }
        const ours = (facts: Parameters<typeof copiesOf>[0] | undefined): boolean =>
          probe == null ||
          facts == null ||
          copiesOf(facts, probe.copies, nodeFacts).includes(probe.t);
        for (const ak of albumKeys)
          for (const run of stats.albumRuns[ak] ?? []) {
            if (run.listened.length < keys.size) continue;
            if (!ours(run.facts)) continue;
            const heard = new Set(run.listened);
            let all = true;
            for (const k of keys)
              if (!heard.has(k)) {
                all = false;
                break;
              }
            if (!all) continue;
            whole += 1;
            if (lastWholeAt == null || run.endAt > lastWholeAt) lastWholeAt = run.endAt;
          }
      }
      return { plays, lastAt, whole, lastWholeAt };
    },
  };
}

/** The Played facet's buckets, by the most recent play. `never` is the
 *  record's word for it: nothing since the record began, not "never". */
export type PlayedBucket = "never" | "week" | "month" | "older";
export function playedBucket(lastAt: number | null, now: number = Date.now()): PlayedBucket {
  if (lastAt == null) return "never";
  const d = now - lastAt;
  if (d < 7 * 86_400_000) return "week";
  if (d < 30 * 86_400_000) return "month";
  return "older";
}
export const PLAYED_LABELS: Record<PlayedBucket, string> = {
  never: "Unplayed",
  week: "Past week",
  month: "Past month",
  older: "Longer ago",
};
const PLAYED_ORDER: PlayedBucket[] = ["never", "week", "month", "older"];
/** Facet options from the shown items' last-played times, count-carrying,
 *  in fixed order; offered only when they would narrow (0 < count < total). */
export function playedOptionsOf(
  lastAts: ReadonlyArray<number | null>,
  now: number = Date.now(),
): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<PlayedBucket, number>();
  for (const at of lastAts) {
    const b = playedBucket(at, now);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const total = lastAts.length;
  return PLAYED_ORDER.filter((b) => {
    const c = counts.get(b) ?? 0;
    return c > 0 && c < total;
  }).map((b) => ({ value: b, label: PLAYED_LABELS[b], count: counts.get(b) ?? 0 }));
}
