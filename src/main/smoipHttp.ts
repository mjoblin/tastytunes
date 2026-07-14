// Queue and preset edits are only proven against the streamer's HTTP surface
// (vibin drives them with POSTs to http://<host>/smoip/...), so they go over HTTP.
// Everything else rides the WebSocket.

async function smoipPost(host: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`http://${host}/smoip${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  })
  if (!res.ok) throw new Error(`POST /smoip${path} -> HTTP ${res.status}`)
}

export const queueDelete = (host: string, id: number): Promise<void> =>
  smoipPost(host, '/queue/delete', { ids: [id] })

export const queueMove = (host: string, id: number, from: number, to: number): Promise<void> =>
  smoipPost(host, '/queue/move', { id, from, to })

export const presetDelete = (host: string, presetId: number): Promise<void> =>
  smoipPost(host, '/presets/delete', { preset: presetId })

export const presetMove = (host: string, from: number, to: number): Promise<void> =>
  smoipPost(host, '/presets/move', { from, to })

/**
 * Fetch the preset list over HTTP — how vibin refreshes stale is_playing flags.
 * (A bare WS request for /presets/list is not proven against real hardware.)
 */
export async function getPresets(host: string): Promise<unknown | null> {
  const res = await fetch(`http://${host}/smoip/presets/list`, {
    signal: AbortSignal.timeout(5000)
  })
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null
  return body?.data ?? null
}
