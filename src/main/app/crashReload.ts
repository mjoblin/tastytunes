import { app, type BrowserWindow } from "electron";

/**
 * A RENDERER THAT DIES COMES BACK (0.12.0-rc.2, the 0.11 re-score's crash resilience). A window
 * whose renderer process is gone (a crash, the OS ending it under memory pressure, a GPU fault
 * taking it down) reloads rather than standing blank, and the log says which window and why.
 * Three reloads in a minute and it stops trying, so a page that dies as it loads cannot spin.
 * Each window registers once, where it is created (app/windows, app/tray).
 *
 * ONLY A RENDERER THAT FAILED ON ITS OWN (the rc.2 gate, S3): a renderer KILLED from outside (a
 * user's kill, the OS ending the app, a process group taken down; Electron's "killed") is someone's
 * intent, and reloading it kept the app alive past its own quit (the suite's dev server, stopped,
 * left its window open and blank). Nor while the app is quitting.
 */
export const RELOAD_REASONS: ReadonlySet<string> = new Set([
  "crashed",
  "oom",
  "abnormal-exit",
  "launch-failed",
  "integrity-failure",
  "memory-eviction",
]);

/** Whether a renderer gone for `reason` is reloaded (the budget aside). */
export function reloads(reason: string, quitting: boolean): boolean {
  return !quitting && RELOAD_REASONS.has(reason);
}

let quitting = false;
let quitWatched = false;
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
  // the app's quit, watched once for every window
  if (!quitWatched) {
    quitWatched = true;
    app.on("before-quit", () => {
      quitting = true;
    });
  }
  win.webContents.on("render-process-gone", (_e, details) => {
    if (win.isDestroyed() || !reloads(details.reason, quitting)) {
      if (details.reason !== "clean-exit") log(`The ${name} window stopped (${details.reason})`);
      return;
    }
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
