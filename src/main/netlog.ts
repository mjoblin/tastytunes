// Outbound-request log for the diagnostics drawer's Requests console. Every
// external fetch in the main process goes through loggedFetch: one push when
// the request starts (pending) and one when it settles — the renderer upserts
// by id. Bounded ring; no payloads, just method/url/status/timing.
import { webContents } from "electron";
import { NET_RING_SIZE, type NetRequestEntry } from "@shared/model";
import { REPO_URL } from "@shared/ipc";
import { version } from "../../package.json";

/**
 * The identifying User-Agent every external service sees (MusicBrainz
 * declines absent or mismatched ones outright). ONE string (2026-08-16):
 * mb, radio-browser and lrclib each built their own copy — identical by
 * discipline, not by construction.
 */
export const USER_AGENT = `TastyTunes/${version} (${REPO_URL})`;

let nextId = 1;
const entries: NetRequestEntry[] = [];

function broadcast(entry: NetRequestEntry): void {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send("tt:push", { kind: "netRequest", entry: { ...entry } });
  }
}

export function getNetRequests(): NetRequestEntry[] {
  return entries;
}

/** fetch, with the request visible in the Requests console. Rethrows as fetch does. */
export async function loggedFetch(
  service: string,
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const entry: NetRequestEntry = {
    id: nextId++,
    at: Date.now(),
    service,
    method: init?.method ?? "GET",
    url: String(url),
    status: null,
    ms: null,
    error: false,
  };
  entries.push(entry);
  if (entries.length > NET_RING_SIZE) entries.shift();
  broadcast(entry);

  const started = Date.now();
  try {
    const res = await fetch(url, init);
    entry.status = res.status;
    entry.ms = Date.now() - started;
    broadcast(entry);
    return res;
  } catch (err) {
    entry.error = true;
    entry.ms = Date.now() - started;
    broadcast(entry);
    throw err;
  }
}
