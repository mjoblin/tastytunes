import { useEffect, useMemo } from "react";
import { peersByPlayKey } from "@shared/model";
import { useStore } from "@/store";
import { useIndexPools } from "@/hooks/useIndexPools";
import { EMPTY_VIEW, type PlayStatsView, viewOf } from "@/lib/playStatsView";

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
  return useMemo(() => (enabled ? viewOf(stats, peersOf) : EMPTY_VIEW), [enabled, stats, peersOf]);
}
