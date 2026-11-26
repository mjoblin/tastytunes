import { app, globalShortcut, shell, systemPreferences } from "electron";
import type { MediaKeysState, StreamerCommand } from "@shared/ipc";
import { getSettings } from "../data/persist";
import { deviceManager } from "./runtime";
import { nowPlayingRunning, syncNowPlaying } from "./nowPlaying";

/**
 * The OS media keys, bound while the setting is on (split out of index.ts in the 0.11.0 sweep).
 * Called at startup and when the setting itself changes.
 *
 * ON macOS THE KEYS NEED ACCESSIBILITY PERMISSION: without it, registering them fails and the keys
 * do nothing, while the setting reads on. The register result is kept, so Settings can say why and
 * open the right pane. macOS says nothing when the permission is granted, so the keys are bound
 * again when the window comes back to the front or the row is shown. The check never asks: the
 * prompting form shows a system dialog, which a test run must never raise.
 *
 * WITH THE SYSTEM'S NOW PLAYING (app/nowPlaying) the helper carries the keys from its hello on; the
 * shortcuts hold them until then, while it is down between restarts, and once it is given up on,
 * so a helper slow to start or failing never leaves the keys dead. The helper says each change
 * (its hello before it claims anything), the shortcuts are let go at the hello and bound again
 * when it goes down, and ones already bound are kept: a key is never bound twice, and a press
 * never reaches both.
 */

const KEYS: Array<[string, StreamerCommand]> = [
  ["MediaPlayPause", { type: "togglePlayback" }],
  ["MediaNextTrack", { type: "nextTrack" }],
  ["MediaPreviousTrack", { type: "previousTrack" }],
  ["MediaStop", { type: "stop" }],
];

/** Whether any shortcut is bound. */
let bound = false;
/** Whether the system's own Now Playing is the keys' route (a helper here, not given up on): it
 *  carries them while it is up, the shortcuts otherwise. */
let system = false;

/** macOS without the Accessibility permission the keys need (never asks: no dialog). */
function lacksPermission(): boolean {
  return process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(false);
}

export function syncMediaKeys(): void {
  const on = getSettings().mediaKeys;
  // the system's Now Playing through the helper carries the keys while it is up; it says when it
  // comes up, goes down or is given up on (it couldn't run here), and this runs again then
  system = syncNowPlaying(on, () => syncMediaKeys());
  if (!on || (system && nowPlayingRunning())) {
    globalShortcut.unregisterAll();
    bound = false;
    return;
  }
  // already bound: kept, never bound twice
  if (bound) return;
  for (const [accelerator, cmd] of KEYS) {
    try {
      if (globalShortcut.register(accelerator, () => deviceManager.fire(cmd))) bound = true;
    } catch {
      // Media keys can be unavailable on some platforms; not fatal.
    }
  }
}

/** The setting, whether the keys are bound (the helper up, or the shortcuts), and why not. */
export function mediaKeysState(): MediaKeysState {
  const on = getSettings().mediaKeys;
  const keys = on && (bound || (system && nowPlayingRunning()));
  const needsPermission = on && !system && !keys && lacksPermission();
  return { on, bound: keys, needsPermission, system };
}

/** Binds the keys again when they are on, unbound, and could now be bound (the permission granted
 *  since); then says where they stand. */
export function refreshMediaKeys(): MediaKeysState {
  if (!system && getSettings().mediaKeys && !bound && !lacksPermission()) syncMediaKeys();
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
