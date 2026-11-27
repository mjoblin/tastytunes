import { SLEEP_DURATIONS, type SleepAction } from "@shared/model";
import type { DisplayControlAnswer, DisplaySleep, SleepChoice } from "@shared/displayControl";
import { fmtTime } from "@/lib/format";

/**
 * THE SLEEP TIMER ON ANOTHER SCREEN (0.17.0): the app's own timer, set from a sheet above the moon
 * disc (display/PageTransport), with the window's lengths and its End of track, and cancelled
 * there. What it does when it runs out, and whether it fades, are the app's settings, said on the
 * sheet and never changed from it. Armed, the moon wears the minutes left; the sheet counts down.
 */

/** The sheet's width, and its least distance from the screen's edges. */
export const SHEET_WIDTH = 340;
export const SHEET_MARGIN = 16;

/** The moon's badge: the minutes left, rounded up ("23m"), or "end" for the end of the track. */
export function sleepBadge(firesAt: number | null, now: number): string {
  if (firesAt == null) return "end";
  return `${Math.max(0, Math.ceil((firesAt - now) / 60_000))}m`;
}

/** When the badge next changes, in ms from `now` (at most a minute): the moment the minutes left,
 *  rounded up, go down by one. */
export function badgeChangesIn(firesAt: number, now: number): number {
  const left = firesAt - now;
  return left - (Math.ceil(left / 60_000) - 1) * 60_000;
}

/** The sheet's countdown, as the window's timer shows it (m:ss, h:mm:ss past an hour), or "End of
 *  track". */
export function sleepCountdown(firesAt: number | null, now: number): string {
  if (firesAt == null) return "End of track";
  return fmtTime(Math.max(0, Math.round((firesAt - now) / 1000)));
}

/** What happens when the timer runs out: the app's setting, said on the sheet. */
export const sleepThen = (action: SleepAction): string =>
  action === "pause" ? "Then pause, as set in TastyTunes." : "Then standby, as set in TastyTunes.";

/** The sheet's choices: the window's lengths, then End of track where it is offered. */
export function sleepChoices(sleep: DisplaySleep): Array<{ minutes: SleepChoice; label: string }> {
  return [
    ...SLEEP_DURATIONS,
    ...(sleep.endOfTrack ? [{ minutes: "track" as const, label: "End of track" }] : []),
  ];
}

/** What the line above the buttons says when the app didn't do a choice on the sheet (a length,
 *  End of track, or Cancel the timer), or null when it did. A cancel refused for having nothing
 *  to cancel (the timer ran out, or was cancelled in the app) came to what was asked. */
export function sleepRefused(
  verb: "sleep" | "sleepCancel",
  answer: DisplayControlAnswer | null,
): string | null {
  if (answer != null && "done" in answer) return null;
  if (verb === "sleep") return "TastyTunes couldn't set the sleep timer.";
  return answer?.refused === "nothing" ? null : "TastyTunes couldn't cancel the sleep timer.";
}

/** The sheet's place on a screen `screenW` wide: SHEET_WIDTH (narrower on a phone, inside the
 *  margins), centered over its button at `center` and kept SHEET_MARGIN inside either edge. */
export function sheetPlace(center: number, screenW: number): { left: number; width: number } {
  const width = Math.max(0, Math.min(SHEET_WIDTH, screenW - 2 * SHEET_MARGIN));
  const left = Math.max(SHEET_MARGIN, Math.min(center - width / 2, screenW - width - SHEET_MARGIN));
  return { left, width };
}
