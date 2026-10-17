import { IPC } from "@shared/ipc";
import type { AppSettings } from "@shared/model";
import { broadcastSettings } from "../app/broadcast";
import { syncMediaKeys } from "../app/mediaKeys";
import { deviceManager, mcpBridge } from "../app/runtime";
import { syncTray } from "../app/tray";
import { checkUpdatesNow } from "../app/updater";
import { trayDeps } from "../app/windows";
import { getSettings, updateSettings } from "../data/persist";
import { handle } from "../app/guard";

/** Settings: the one write path, and what a write sets moving. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */
export function registerSettingsIpc(): void {
  handle(IPC.getSettings, () => getSettings());
  handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => {
    const next = updateSettings(patch);
    broadcastSettings(next);
    // OS-global shortcut churn only when the toggle itself changed — every
    // settings write used to unregister/re-register all four media keys.
    if ("mediaKeys" in patch) syncMediaKeys();
    // The tray comes and goes live — toggling it is not a restart.
    if ("tray" in patch) syncTray(next.tray, trayDeps);
    mcpBridge.sync(next);
    // Only when the limit itself changed — a volume set above the limit from
    // outside the app (device knob) mustn't be ambushed by unrelated saves.
    if ("volumeLimitPercent" in patch) deviceManager.enforceVolumeLimit();
    // Turning the update check on shouldn't wait up to 4 hours to matter.
    if (patch.updateCheck === true) checkUpdatesNow();
    return next;
  });
}
