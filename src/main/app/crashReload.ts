import type { BrowserWindow } from "electron";

/**
 * A RENDERER THAT DIES COMES BACK (0.12.0-rc.2, the 0.11 re-score's crash resilience). A window
 * whose renderer process is gone (a crash, the OS ending it under memory pressure, a GPU fault
 * taking it down) reloads rather than standing blank, and the log says which window and why.
 * Three reloads in a minute and it stops trying, so a page that dies as it loads cannot spin.
 * Each window registers once, where it is created (app/windows, app/tray).
 */
export const CRASH_WINDOW_MS = 60_000;
export const CRASH_MAX_RELOADS = 3;

/** Whether one more reload fits the budget; records it when it does. `times` holds the window's
 *  recent reloads and is pruned to the last minute. */
export function takeReload(times: number[], now: number): boolean {
  while (times.length > 0 && now - times[0] > CRASH_WINDOW_MS) times.shift();
  if (times.length >= CRASH_MAX_RELOADS) return false;
  times.push(now);
  return true;
}

export function reloadOnCrash(win: BrowserWindow, name: string, log: (text: string) => void): void {
  const times: number[] = [];
  win.webContents.on("render-process-gone", (_e, details) => {
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    if (!takeReload(times, Date.now())) {
      log(
        `The ${name} window stopped (${details.reason}) and was left closed: ${CRASH_MAX_RELOADS} reloads in a minute`,
      );
      return;
    }
    log(`The ${name} window stopped (${details.reason}) and was reloaded`);
    win.webContents.reload();
  });
}
