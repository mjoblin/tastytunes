import { globalShortcut } from "electron";
import type { StreamerCommand } from "@shared/ipc";
import { getSettings } from "../data/persist";
import { deviceManager } from "./runtime";

/** The OS media keys, bound while the setting is on (split out of index.ts in the 0.11.0
 *  sweep). Called at startup and when the setting itself changes. */
export function syncMediaKeys(): void {
  globalShortcut.unregisterAll();
  if (!getSettings().mediaKeys) return;
  const bind = (accelerator: string, cmd: StreamerCommand): void => {
    try {
      globalShortcut.register(accelerator, () => deviceManager.fire(cmd));
    } catch {
      // Media keys can be unavailable on some platforms; not fatal.
    }
  };
  bind("MediaPlayPause", { type: "togglePlayback" });
  bind("MediaNextTrack", { type: "nextTrack" });
  bind("MediaPreviousTrack", { type: "previousTrack" });
  bind("MediaStop", { type: "stop" });
}
