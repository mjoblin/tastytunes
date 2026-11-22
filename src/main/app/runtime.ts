import { DeviceManager } from "../device/deviceManager";
import { McpBridge } from "../servers/mcpServer";
import { app, webContents } from "electron";
import { onSavedNotes, onSaveFailedNotice } from "../data/savedFiles";

// The main process's two long-lived services, one instance each (split out of index.ts in the
// 0.11.0 sweep). Constructed when first imported, which is after app/boot has pinned userData.

export const deviceManager = new DeviceManager();
// A promise that rejects with nobody to catch it would otherwise vanish from
// main; the log keeps it where the diagnostics drawer shows it.
process.on("unhandledRejection", (reason) => deviceManager.logUnhandled(reason));
// The last resort for a throw nothing caught: logged where the drawer shows it, the app kept up
// (Electron's default is a modal error box and a main process in an unknown state either way).
process.on("uncaughtException", (err) => deviceManager.logUnhandled(err, "uncaught exception"));
// what the saved files' checks found (data/savedFiles), the notes from before this point first
onSavedNotes((note) => deviceManager.log(note.level, "saved", note.text));
// a failed save, or a saved file that couldn't be read, is said in every window too, as a notice
// (data/savedFiles); said before any window has finished loading (the settings and saved files
// are read while the first window is still loading, for the tray's menu), it waits for the first
// page that loads (0.16.0-rc.8: it was sent to a page not yet there, and lost)
const heldNotices: string[] = [];
onSaveFailedNotice((text) => {
  const ready = webContents
    .getAllWebContents()
    .filter((wc) => !wc.isDestroyed() && !wc.isLoading());
  if (ready.length === 0) heldNotices.push(text);
  for (const wc of ready) wc.send("tt:push", { kind: "notice", text });
});
app.on("web-contents-created", (_e, wc) => {
  wc.on("did-finish-load", () => {
    for (const text of heldNotices.splice(0)) wc.send("tt:push", { kind: "notice", text });
  });
});
export const mcpBridge = new McpBridge(deviceManager);

/** The connected streamer's host; media-browser calls need one and throw without it. */
export function streamerHost(): string {
  const conn = deviceManager.snapshot().connection;
  if (conn.phase !== "connected") throw new Error("not connected to a streamer");
  return conn.host;
}

/** The connected streamer's host, or null: best-effort lookups answer null while the socket
 *  recycles rather than throw. */
export function connectedHost(): string | null {
  const conn = deviceManager.snapshot().connection;
  return conn.phase === "connected" ? conn.host : null;
}
