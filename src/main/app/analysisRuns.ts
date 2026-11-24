/**
 * WHAT THE WINDOW IS ANALYZING (0.17.0, export for an agent): audio is measured in the window,
 * one album at a time from its own queue, and main stores each track's result as it lands. What
 * main can't see from the results is whether the window is still at it: an album whose next track
 * takes minutes (an unhurried read, a long hi-res file) looks the same as one the window has
 * finished with and couldn't measure. So the window says which albums it has queued or is
 * measuring whenever that changes (lib/audioAnalysis), and an export asks here before it writes
 * "measured nothing".
 *
 * An album an agent's call has just asked for counts as running for PICKUP_MS before the window
 * names it, which covers the moment between the command and the window's queue. A window that
 * closes or reloads takes its queue with it, so the list is cleared then (app/windows).
 */

const PICKUP_MS = 15_000;

const keyOf = (serverUdn: string, albumId: string): string => `${serverUdn}|${albumId}`;

let running = new Set<string>();
const asked = new Map<string, number>();

/** The window's list, as it sent it: anything that isn't one is read as an empty list. */
export function windowAnalyzing(list: unknown): void {
  const next = new Set<string>();
  if (Array.isArray(list))
    for (const a of list) {
      const { serverUdn, albumId } = (a ?? {}) as { serverUdn?: unknown; albumId?: unknown };
      if (typeof serverUdn === "string" && typeof albumId === "string")
        next.add(keyOf(serverUdn, albumId));
    }
  running = next;
  // an album the window has named is no longer waiting to be picked up
  for (const k of next) asked.delete(k);
}

/** An agent's call asked the window to analyze an album. */
export function analysisAsked(serverUdn: string, albumId: string, now: number): void {
  asked.set(keyOf(serverUdn, albumId), now);
}

/** Whether the window is analyzing the album, or was asked to a moment ago. */
export function analysisRunning(serverUdn: string, albumId: string, now: number): boolean {
  const k = keyOf(serverUdn, albumId);
  if (running.has(k)) return true;
  const at = asked.get(k);
  return at != null && now - at < PICKUP_MS;
}

/** The window closed or reloaded: its queue is gone. */
export function windowAnalysisGone(): void {
  running = new Set();
  asked.clear();
}
