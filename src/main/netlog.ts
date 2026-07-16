// Outbound-request log for the diagnostics drawer's Requests console. Every
// external fetch in the main process goes through loggedFetch: one push when
// the request starts (pending) and one when it settles — the renderer upserts
// by id. Bounded ring; no payloads, just method/url/status/timing.
import { webContents } from 'electron'
import type { NetRequestEntry } from '@shared/ipc'

const RING = 200

let nextId = 1
const entries: NetRequestEntry[] = []

function broadcast(entry: NetRequestEntry): void {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send('tt:push', { kind: 'netRequest', entry: { ...entry } })
  }
}

export function getNetRequests(): NetRequestEntry[] {
  return entries
}

/** fetch, with the request visible in the Requests console. Rethrows as fetch does. */
export async function loggedFetch(
  service: string,
  url: string | URL,
  init?: RequestInit
): Promise<Response> {
  const entry: NetRequestEntry = {
    id: nextId++,
    at: Date.now(),
    service,
    method: init?.method ?? 'GET',
    url: String(url),
    status: null,
    ms: null,
    error: false
  }
  entries.push(entry)
  if (entries.length > RING) entries.shift()
  broadcast(entry)

  const started = Date.now()
  try {
    const res = await fetch(url, init)
    entry.status = res.status
    entry.ms = Date.now() - started
    broadcast(entry)
    return res
  } catch (err) {
    entry.error = true
    entry.ms = Date.now() - started
    broadcast(entry)
    throw err
  }
}
