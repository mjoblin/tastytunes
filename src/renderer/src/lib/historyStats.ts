import { fmtDuration } from "@/lib/format";
import type { ListeningStats } from "@shared/historyStats";

// The figures themselves live in shared/historyStats (2026-09-14, so the MCP
// bridge answers the screen's numbers); this is the renderer's face of it —
// the same exports for the History screens, plus the one formatted line.
export {
  statsFor,
  dayStartOf,
  monthStartOf,
  sourceNameOf,
  type ListeningStats,
  type TopEntry,
} from "@shared/historyStats";

/** A month's one-line summary for the Timeline's divider: plays, time, the
 *  most-played album. Null when the month has no library plays. */
export function monthLine(stats: ListeningStats): string | null {
  if (stats.plays === 0 && stats.radioSeconds === 0 && stats.externalSeconds === 0) return null;
  const parts: string[] = [];
  if (stats.plays > 0)
    parts.push(`${stats.plays.toLocaleString()} ${stats.plays === 1 ? "play" : "plays"}`);
  const total = stats.seconds + stats.radioSeconds + stats.externalSeconds;
  if (total > 0) parts.push(fmtDuration(total));
  if (stats.topAlbums[0]) parts.push(`most: ${stats.topAlbums[0].name}`);
  return parts.join(" · ");
}
