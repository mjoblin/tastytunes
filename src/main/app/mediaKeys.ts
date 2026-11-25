import { app, globalShortcut, shell, systemPreferences } from "electron";
import type { MediaKeysState, StreamerCommand } from "@shared/ipc";
import { getSettings } from "../data/persist";
import { deviceManager } from "./runtime";

/**
 * The OS media keys, bound while the setting is on (split out of index.ts in the 0.11.0 sweep).
 * Called at startup and when the setting itself changes.
 *
 * ON macOS THE KEYS NEED ACCESSIBILITY PERMISSION: without it, registering them fails and the keys
 * do nothing, while the setting reads on. The register result is kept, so Settings can say why and
 * open the right pane. macOS says nothing when the permission is granted, so the keys are bound
 * again when the window comes back to the front or the row is shown. The check never asks: the
 * prompting form shows a system dialog, which a test run must never raise.
 */

const KEYS: Array<[string, StreamerCommand]> = [
  ["MediaPlayPause", { type: "togglePlayback" }],
  ["MediaNextTrack", { type: "nextTrack" }],
  ["MediaPreviousTrack", { type: "previousTrack" }],
  ["MediaStop", { type: "stop" }],
];

/** Whether any key was bound by the last sync. */
let bound = false;

/** macOS without the Accessibility permission the keys need (never asks: no dialog). */
function lacksPermission(): boolean {
  return process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(false);
}

export function syncMediaKeys(): void {
  globalShortcut.unregisterAll();
  bound = false;
  if (!getSettings().mediaKeys) return;
  for (const [accelerator, cmd] of KEYS) {
    try {
      if (globalShortcut.register(accelerator, () => deviceManager.fire(cmd))) bound = true;
    } catch {
      // Media keys can be unavailable on some platforms; not fatal.
    }
  }
}

/** The setting, whether the keys are bound, and why not. */
export function mediaKeysState(): MediaKeysState {
  const on = getSettings().mediaKeys;
  const needsPermission = on && !bound && lacksPermission();
  return { on, bound, needsPermission };
}

/** Binds the keys again when they are on, unbound, and could now be bound (the permission granted
 *  since); then says where they stand. */
export function refreshMediaKeys(): MediaKeysState {
  if (getSettings().mediaKeys && !bound && !lacksPermission()) syncMediaKeys();
  return mediaKeysState();
}

/** System Settings' Accessibility pane, where the keys' permission is given. */
export function openAccessibilitySettings(): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  return shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  );
}

/** The window coming back to the front is when a permission granted meanwhile is picked up. */
export function watchMediaKeys(): void {
  app.on("browser-window-focus", () => void refreshMediaKeys());
}
