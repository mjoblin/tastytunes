import { BrowserWindow } from "electron";
import { IPC } from "@shared/ipc";
import type { AppSettings } from "@shared/model";
import { listeningRecord } from "../data/listeningRecord";

// Pushes every window hears (split out of index.ts in the 0.11.0 sweep). The device's own
// pushes fan out from DeviceManager; these are main's.

/**
 * Every window hears a settings write — the mini player tracks the main window
 * live (display font, theme, ambient art), and an MCP-driven change (schedules)
 * reaches both. The sender re-applies the same object idempotently; the store's
 * 'settings' push just sets state.
 */
export function broadcastSettings(settings: AppSettings): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.push, { kind: "settings", settings });
  }
}

// The History tab's truth row stays live: every append (or failed append)
// re-reads the stats and pushes them — the recents pattern, at track-boundary
// frequency.
export function broadcastListening(): void {
  void listeningRecord.stats().then((data) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC.push, { kind: "listening", data });
    }
  });
}

/** Wires the listening record's notifiers to the pushes; once, at startup. */
export function wireListeningPushes(): void {
  listeningRecord.setNotifier(broadcastListening);
  // Each appended line reaches the renderer's play stats as ONE event (the fold
  // is shared with main's builder), so counts and last-played stay live at
  // track boundaries without re-reading the files.
  listeningRecord.setEventNotifier((event) => {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send(IPC.push, { kind: "playEvent", event });
  });
}
