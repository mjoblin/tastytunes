import { app, dialog, shell } from "electron";
import { REPO_URL } from "@shared/ipc";
import { appLog, revealLog } from "./appLog";

/**
 * A START-UP THAT FAILED SAYS SO (0.16.0, toward 1.0). Start-up is one chain, and a throw anywhere
 * in it used to end as a console line: no window, a Dock icon that did nothing, and a process
 * holding the single-instance lock, so a second launch did nothing either. A build that cannot
 * start cannot be repaired from inside it, so the dialog points at the latest version and the
 * log, and the app then quits. The update check starts ahead of the chain, in its own try, and the
 * Dock icon's handler outside it, so neither depends on the rest having worked (index.ts).
 */
export async function startupFailed(e: unknown): Promise<void> {
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
    const { response } = await dialog.showMessageBox({
      type: "error",
      message: "TastyTunes couldn't start.",
      detail: `${reason}\n\nThe latest version may fix this, and the log has the details.`,
      buttons: ["Get the Latest Version", "Show the Log", "Quit"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) await shell.openExternal(`${REPO_URL}/releases/latest`);
    if (response === 1) revealLog();
  } finally {
    app.quit();
  }
}
