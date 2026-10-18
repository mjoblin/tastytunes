import { IPC } from "@shared/ipc";
import { shell } from "electron";
import { hasLocalNetworkPrivacy } from "../app/localNetwork";
import { deviceManager, mcpBridge } from "../app/runtime";
import { checkUpdatesOnDemand, downloadUpdate, installUpdate } from "../app/updater";
import {
  sendMenuCommand,
  setUndoMenuLabel,
  showMainWindow,
  toggleMiniPlayer,
} from "../app/windows";
import { handle, listen } from "../app/guard";

/** The app itself: links out, updates, the windows, the undo label and the display mode. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */
export function registerAppIpc(): void {
  handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:/i.test(url)) return shell.openExternal(url);
    return Promise.resolve();
  });
  handle(IPC.localNetworkPrivacy, () =>
    Promise.resolve(hasLocalNetworkPrivacy(process.platform, process.getSystemVersion())),
  );
  // a surface that failed to render says so in the diagnostics log (SurfaceBoundary)
  handle(IPC.reportRenderError, (_e, surface: string, message: string) => {
    deviceManager.log(
      "error",
      "renderer",
      `${String(surface).slice(0, 40)} failed to render: ${String(message).slice(0, 300)}`,
    );
    return Promise.resolve();
  });
  handle(IPC.updateDownload, () => downloadUpdate());
  handle(IPC.updateInstall, () => installUpdate());
  handle(IPC.updateCheckNow, () => checkUpdatesOnDemand());
  // the renderer's display mode, for the MCP bridge (2026-09-14)
  listen(IPC.displayModeReport, (_e, on: boolean) => mcpBridge.reportDisplayMode(on === true));
  handle(IPC.toggleMini, () => toggleMiniPlayer());
  // A named screen goes through sendMenuCommand, which already creates the
  // window if it's gone, waits for the load, restores/focuses it and then
  // navigates — the exact sequence the tray menu's own items rely on.
  handle(IPC.showMain, (_e, screen?: string) =>
    screen ? sendMenuCommand({ id: "screen", screen }) : showMainWindow(),
  );
  handle(IPC.undoLabelSet, (_e, label: string | null) => setUndoMenuLabel(label));
}
