import { app, dialog, shell } from "electron";
import { REPO_URL } from "@shared/ipc";
import { appLog, revealLog } from "./appLog";
import { updateFromMain, updateOffered } from "./updater";

/**
 * A START-UP THAT FAILED SAYS SO (0.16.0, toward 1.0). Start-up is one chain, and a throw anywhere
 * in it used to end as a console line: no window, a Dock icon that did nothing, and a process
 * holding the single-instance lock, so a second launch did nothing either. A build that cannot
 * start cannot be repaired from inside it, so the dialog points at the latest version and the
 * log. With nothing on screen, the app then quits. Once the window or the menu bar icon is up
 * (`running`), the app stays: a failure after that costs the step that failed and the steps after
 * it in the chain (connecting, the scheduler, the sleep handlers), never the app, and the dialog
 * says part of it couldn't start. The update check starts ahead of the chain, in its own try, and
 * the Dock icon's handler outside it, so neither depends on the rest having worked (index.ts).
 */
export async function startupFailed(e: unknown, running = false): Promise<void> {
  console.error("startup failed:", e);
  const reason = e instanceof Error ? e.message : String(e);
  try {
    const text = e instanceof Error && e.stack ? e.stack : reason;
    appLog().write({
      at: Date.now(),
      level: "error",
      scope: "main",
      text: `startup failed: ${text}`,
    });
  } catch {
    // a log that can't be written is no reason not to say so
  }
  try {
    const { response } = await dialog.showMessageBox(
      running
        ? {
            type: "warning",
            message: "Part of TastyTunes couldn't start.",
            detail: `${reason}\n\nThe rest of TastyTunes is running. The latest version may fix this, and the log has the details.`,
            buttons: ["Get the Latest Version", "Show the Log", "Continue"],
            defaultId: 2,
            cancelId: 2,
            noLink: true,
          }
        : {
            type: "error",
            message: "TastyTunes couldn't start.",
            detail: `${reason}\n\nThe latest version may fix this, and the log has the details.`,
            buttons: ["Get the Latest Version", "Show the Log", "Quit"],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
          },
    );
    if (response === 0) await shell.openExternal(`${REPO_URL}/releases/latest`);
    if (response === 1) revealLog();
  } finally {
    if (!running) app.quit();
  }
}

let lateFailed = false;

/**
 * A START-UP STEP AFTER THE WINDOW OR THE MENU BAR ICON IS UP, IN ITS OWN TRY (0.16.0-rc.8): one
 * that throws (or whose promise rejects) costs itself, never the steps after it; the chain lost
 * connecting, the scheduler and the sleep handlers to one throw. The first failure is said in the
 * running form of the dialog; any after it go to the log.
 */
export function lateStep(what: string, run: () => unknown): void {
  const fail = (e: unknown): void => {
    if (!lateFailed) {
      lateFailed = true;
      void startupFailed(e, true);
      return;
    }
    console.error(`${what} couldn't start:`, e);
    try {
      appLog().write({
        at: Date.now(),
        level: "error",
        scope: "main",
        text: `${what} couldn't start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      });
    } catch {
      // the console has it
    }
  };
  try {
    const out = run();
    if (out instanceof Promise) out.catch(fail);
  } catch (e) {
    fail(e);
  }
}

let stuckShown = false;

/**
 * THE WINDOW THAT NEVER CAME UP, OR STOPPED AND WAS LEFT CLOSED (0.16.0-rc.8, toward 1.0): with no
 * window, the update's Download and Restart can't be reached, so the dialog offers it itself when
 * one is known (app/updater updateFromMain), else the latest version on the site, and the log.
 * Once a session; the app keeps running (the menu bar icon, a link, an agent still reach it).
 */
export async function windowStuck(how: "never-ready" | "stopped"): Promise<void> {
  if (stuckShown) return;
  stuckShown = true;
  try {
    appLog().write({
      at: Date.now(),
      level: "error",
      scope: "main",
      text:
        how === "never-ready"
          ? "the main window didn't come up"
          : "the main window stopped and was left closed",
    });
  } catch {
    // the dialog still says it
  }
  const version = updateOffered();
  const { response } = await dialog.showMessageBox({
    type: "error",
    message:
      how === "never-ready"
        ? "The TastyTunes window didn't open."
        : "The TastyTunes window stopped.",
    detail: version
      ? `TastyTunes ${version} is available and may fix this. The log has the details.`
      : "The latest version may fix this, and the log has the details.",
    buttons: [version ? "Update and Restart" : "Get the Latest Version", "Show the Log", "Close"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 0 && !(version && (await updateFromMain())))
    await shell.openExternal(`${REPO_URL}/releases/latest`);
  if (response === 1) revealLog();
}
