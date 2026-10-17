import { DeviceManager } from "../device/deviceManager";
import { McpBridge } from "../servers/mcpServer";

// The main process's two long-lived services, one instance each (split out of index.ts in the
// 0.11.0 sweep). Constructed when first imported, which is after app/boot has pinned userData.

export const deviceManager = new DeviceManager();
// A promise that rejects with nobody to catch it would otherwise vanish from
// main; the log keeps it where the diagnostics drawer shows it.
process.on("unhandledRejection", (reason) => deviceManager.logUnhandled(reason));
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
