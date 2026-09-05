import { type ListeningEvent, type PlayStats, foldPlayEvent } from "@shared/model";
import { listeningRecord } from "./listeningRecord";

/**
 * The listening record, aggregated for the renderer's reading surfaces
 * (0.8.0). The fold itself lives in shared/model (foldPlayEvent) so the
 * renderer applies the identical rule to each pushed event.
 */
export function buildPlayStats(events: ListeningEvent[]): PlayStats {
  const stats: PlayStats = { tracks: {}, recent: [], since: null };
  // files are appended in time order, but a re-sort keeps `recent` honest
  // if a line ever lands late (a clock change, a concatenated export)
  for (const e of [...events].sort((a, b) => a.at - b.at)) foldPlayEvent(stats, e);
  // `since` is the record's first line of ANY kind — the surfaces say "since
  // <date>" about the record, not about the first library play
  for (const e of events) if (stats.since == null || e.at < stats.since) stats.since = e.at;
  return stats;
}

export async function playStatsFromRecord(): Promise<PlayStats> {
  const { events } = await listeningRecord.readAll();
  return buildPlayStats(events);
}
