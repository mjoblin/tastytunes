// The listening record's view for the Library's surfaces (0.8.0; split from playStats.ts in
// 0.13.0 so it loads in plain Node: it is pure, and the scale fixture holds it to time budgets).
// A track's tally is its copy's (shared/model copyStat), an album's the fold of its tracks.

import {
  type ListeningPlayEvent,
  type PlayStat,
  type PlayStats,
  type CopyRow,
  copiesOf,
  copyStat,
  nodeFacts,
  playKey,
  sameCopyRow,
} from "@shared/model";

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

export const EMPTY_VIEW: PlayStatsView = {
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
  if (!stats) return EMPTY_VIEW;
  const track = (node: CopyRow, peers: readonly CopyRow[] = []): PlayStat | null => {
    const k = playKey(node.title, node.artist, node.album);
    // most rows were never played: no copies to compare
    if (!stats.tracks[k]) return null;
    return copyStat(stats, node, [...peersOf(k), ...peers]);
  };
  return {
    ready: true,
    since: stats.since,
    recent: stats.recent,
    track,
    album: (tracks) => {
      let plays = 0;
      let lastAt: number | null = null;
      // the album's own rows by play key, made once: a row is compared only with its twins (a
      // play key per pair of rows made every album's tally grow as its tracks squared)
      const byKey = new Map<string, CopyRow[]>();
      for (const t of tracks) {
        const k = playKey(t.title, t.artist, t.album);
        byKey.set(k, [...(byKey.get(k) ?? []), t]);
      }
      for (const t of tracks) {
        const st = track(t, byKey.get(playKey(t.title, t.artist, t.album)) ?? []);
        if (!st) continue;
        plays += st.plays;
        if (lastAt == null || st.lastAt > lastAt) lastAt = st.lastAt;
      }
      // whole listens: a run that heard every track (by play key) as a listen
      let whole = 0;
      let lastWholeAt: number | null = null;
      // the runs long enough to have heard every track; most albums have none, and skip the rest
      const keys = [...byKey.keys()];
      const runs = [...new Set(tracks.map((t) => playKey(null, null, t.album)))]
        .flatMap((ak) => stats.albumRuns[ak] ?? [])
        .filter((run) => run.listened.length >= keys.length);
      if (runs.length > 0) {
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
        for (const run of runs) {
          if (!ours(run.facts)) continue;
          const heard = new Set(run.listened);
          if (!keys.every((k) => heard.has(k))) continue;
          whole += 1;
          if (lastWholeAt == null || run.endAt > lastWholeAt) lastWholeAt = run.endAt;
        }
      }
      return { plays, lastAt, whole, lastWholeAt };
    },
  };
}

/** Each row's tally, read once: a sort that reads them inside its comparator asks for a 50,000-
 *  track lens's tallies a million and a half times (0.13.0, the scale fixture). */
export function talliesOf<T extends CopyRow>(
  view: PlayStatsView,
  rows: readonly T[],
): Map<T, PlayStat | null> {
  return new Map(rows.map((t) => [t, view.track(t)]));
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
