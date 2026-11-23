import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { app, dialog, shell, type BrowserWindow } from "electron";
import type { ExportFolderStatus } from "@shared/ipc";
import { getSettings, updateSettings } from "../data/persist";
import { broadcastSettings } from "./broadcast";

/**
 * WHERE EXPORTS GO (0.17.0, export for an agent): one folder, chosen by the owner in a dialog,
 * never a path an agent gives. Asked when the Exports group is first switched on, and changed from
 * Settings › Integrations; main alone sets it (a window's settings patch can't, ipc/settings).
 */

/** The folder suggested: "TastyTunes Exports" in Music, not Documents, which iCloud may sync. */
const suggested = (): string => join(app.getPath("music"), "TastyTunes Exports");

export function exportFolderStatus(): ExportFolderStatus {
  const folder = getSettings().agentExportFolder;
  let usable = false;
  try {
    usable = folder != null && statSync(folder).isDirectory();
  } catch {
    usable = false;
  }
  return { folder, usable };
}

/** The folder the exports are written into, or why there is none (said to the agent). */
export function exportRoot(): { root: string } | { why: string } {
  const s = exportFolderStatus();
  if (s.folder == null)
    return {
      why: "No export folder is chosen. Ask the user to choose one in Settings › Integrations, beside the Exports tools.",
    };
  if (!s.usable)
    return {
      why: `The export folder (${s.folder}) isn't there any more. Ask the user to choose it again in Settings › Integrations.`,
    };
  return { root: s.folder };
}

/** The dialog: the suggested folder made and offered when nothing is chosen yet, and taken away
 *  again, empty as it was made, when the owner picks another or cancels. */
export async function chooseExportFolder(
  parent: BrowserWindow | null,
): Promise<ExportFolderStatus> {
  const current = getSettings().agentExportFolder;
  let made: string | null = null;
  let start = current ?? suggested();
  if (!current && !existsSync(start)) {
    try {
      mkdirSync(start, { recursive: true });
      made = start;
    } catch {
      start = app.getPath("music");
    }
  }
  const opts: Electron.OpenDialogOptions = {
    title: "Where exports go",
    message: "Choose the folder TastyTunes writes exports into for your AI agents.",
    buttonLabel: "Use This Folder",
    defaultPath: start,
    properties: ["openDirectory", "createDirectory"],
  };
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  const picked = r.canceled ? null : (r.filePaths[0] ?? null);
  if (made && picked !== made) {
    try {
      if (readdirSync(made).length === 0) rmdirSync(made);
    } catch {
      // left as made: an empty folder in Music
    }
  }
  if (picked) broadcastSettings(updateSettings({ agentExportFolder: picked }));
  return exportFolderStatus();
}

export async function revealExportFolder(): Promise<void> {
  const s = exportFolderStatus();
  if (s.folder && s.usable) await shell.openPath(s.folder);
}
