import { useEffect, useMemo } from "react";
import {
  type ListeningPlayEvent,
  type MediaNode,
  type PlayStat,
  type PlayStats,
  playKey,
} from "@shared/model";
import { useStore } from "@/store";

/**
 * The listening record's reading surfaces (0.8.0, round one). ONE hook hands
 * every surface the same stats and the same lookups: a track's tally by its
 * play key, an album's tally as the fold of its tracks (so a compilation's
 * plays land on the compilation, whoever performed them), and the record's
 * start for "since" copy. Loads once on first use; live afterwards via the
 * store's playEvent fold.
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
  return useMemo(() => (enabled ? viewOf(stats) : EMPTY), [enabled, stats]);
}

export interface PlayStatsView {
  ready: boolean;
  since: number | null;
  recent: ListeningPlayEvent[];
  track(node: Pick<MediaNode, "title" | "artist" | "album">): PlayStat | null;
  /** An album's tally over its tracks: total plays, most recent start. */
  album(tracks: ReadonlyArray<Pick<MediaNode, "title" | "artist" | "album">>): {
    plays: number;
    lastAt: number | null;
  };
}

const EMPTY: PlayStatsView = {
  ready: false,
  since: null,
  recent: [],
  track: () => null,
  album: () => ({ plays: 0, lastAt: null }),
};

export function viewOf(stats: PlayStats | null): PlayStatsView {
  if (!stats) return EMPTY;
  const track = (node: Pick<MediaNode, "title" | "artist" | "album">): PlayStat | null =>
    stats.tracks[playKey(node.title, node.artist, node.album)] ?? null;
  return {
    ready: true,
    since: stats.since,
    recent: stats.recent,
    track,
    album: (tracks) => {
      let plays = 0;
      let lastAt: number | null = null;
      for (const t of tracks) {
        const st = track(t);
        if (!st) continue;
        plays += st.plays;
        if (lastAt == null || st.lastAt > lastAt) lastAt = st.lastAt;
      }
      return { plays, lastAt };
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

// the resume helpers live in shared/model (main's MCP tools use the same rule)
export { resumeRun, resumeTarget, type ResumeRun } from "@shared/model";
