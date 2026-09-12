import { useEffect, useMemo } from "react";
import type { ListeningEvent } from "@shared/model";
import { useStore } from "@/store";
import { narrowToStreamer } from "@/lib/historyStreamers";

/**
 * The whole listening record for a History view that reads all of it
 * (Rediscover, Elsewhere): every year loaded once, the lines in year order,
 * narrowed to the rail's streamer. `allLoaded` says whether the figures are
 * final; `years` is null until the census of year files arrives.
 */
export function useWholeRecord(streamer: string | null): {
  events: ListeningEvent[];
  years: number[] | null;
  allLoaded: boolean;
} {
  const years = useStore((s) => s.history.years);
  const loaded = useStore((s) => s.history.loaded);
  const loadYears = useStore((s) => s.loadHistoryYears);
  const loadYear = useStore((s) => s.loadHistoryYear);
  useEffect(() => {
    if (years == null) void loadYears();
    else for (const y of years) if (loaded[y] == null) void loadYear(y);
  }, [years, loaded, loadYears, loadYear]);
  const events = useMemo(() => {
    const out: ListeningEvent[] = [];
    for (const y of Object.keys(loaded)
      .map(Number)
      .sort((a, b) => a - b))
      out.push(...(loaded[y] ?? []));
    return narrowToStreamer(out, streamer);
  }, [loaded, streamer]);
  return { events, years, allLoaded: years != null && years.every((y) => loaded[y] != null) };
}
