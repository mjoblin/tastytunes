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
 * Percent-encode a query value the firmware's way: StreamMagic decodes
 * %-escapes but takes '+' LITERALLY (probed live 2026-07-19 — a
 * URLSearchParams-encoded name came back as "102.7+KIIS+FM"), so spaces must
 * be %20 and never '+'. encodeURIComponent does exactly that.
 */
const enc = encodeURIComponent

/** Rename a preset — the query-param GET verb probed live on the Evo. */
export async function presetRename(host: string, slot: number, name: string): Promise<void> {
  const res = await fetch(`http://${host}/smoip/presets/rename?preset=${slot}&name=${enc(name)}`, {
    signal: AbortSignal.timeout(5000)
  })
  if (!res.ok) throw new Error(`GET /smoip/presets/rename -> HTTP ${res.status}`)
}

/**
 * Snapshot the current queue into a device preset (type MediaQueue) — the
 * query-param GET verb probed live on the Evo 2026-07-18. Both params are
 * optional: the firmware defaults to the next free slot / "Queue Preset N".
 */
export async function queueSavePreset(
  host: string,
  slot: number | null,
  name: string | null
): Promise<void> {
  const parts: string[] = []
  if (slot != null) parts.push(`preset=${slot}`)
  if (name) parts.push(`name=${enc(name)}`)
  const qs = parts.length > 0 ? `?${parts.join('&')}` : ''
  const res = await fetch(`http://${host}/smoip/queue/save_preset${qs}`, {
    signal: AbortSignal.timeout(5000)
  })
  if (!res.ok) throw new Error(`GET /smoip/queue/save_preset -> HTTP ${res.status}`)
}

/**
 * Play an internet-radio stream by direct URL — probed live on the Evo
 * 2026-07-18/19. Requires url+name AND an explicit zone: without it the
 * firmware 400s with "'zone/preset' value missing" (the one smoip GET verb
 * we've met that doesn't default the zone).
 */
export async function streamRadio(host: string, url: string, name: string): Promise<void> {
  const res = await fetch(
    `http://${host}/smoip/stream/radio?zone=ZONE1&url=${enc(url)}&name=${enc(name)}`,
    { signal: AbortSignal.timeout(10_000) }
  )
  if (!res.ok) throw new Error(`GET /smoip/stream/radio -> HTTP ${res.status}`)
}

/**
 * Save the CURRENT playback to a preset slot — /zone/save_preset, probed live
 * 2026-07-18. Track-level for media (recall replaces the queue with one
 * track), the natural verb for a playing radio station. The slot is REQUIRED
 * here on purpose: called bare, the firmware executes with defaults and
 * silently takes the next free slot.
 */
export async function zoneSavePreset(host: string, slot: number): Promise<void> {
  const qs = new URLSearchParams({ preset: String(slot) })
  const res = await fetch(`http://${host}/smoip/zone/save_preset?${qs}`, {
    signal: AbortSignal.timeout(5000)
  })
  if (!res.ok) throw new Error(`GET /smoip/zone/save_preset -> HTTP ${res.status}`)
}

/**
 * Fetch /zone/audio/spec — the self-describing tone/EQ capability document
 * (enum/range/readonly per field; probed live on the Evo 2026-07-19). null =
 * unreachable / 404 / unparseable, which all mean "no tone controls here":
 * the exact negative shape on non-EQ models is unobserved, so every
 * non-positive answer is treated as absence.
 */
export async function getAudioSpec(host: string): Promise<unknown | null> {
  try {
    const res = await fetch(`http://${host}/smoip/zone/audio/spec?zone=ZONE1`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null
    return body?.data ?? null
  } catch {
    return null
  }
}

/**
 * Fetch a self-describing /spec document (display or power) — the §10
 * capability probe, mirroring getAudioSpec. null on any non-positive answer
 * (404 on a headless unit, timeout, junk) = "control not supported".
 */
async function getSpec(host: string, path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`http://${host}/smoip${path}`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null
    return body?.data ?? null
  } catch {
    return null
  }
}
export const getDisplaySpec = (host: string): Promise<unknown | null> =>
  getSpec(host, '/system/display/spec')
export const getPowerSpec = (host: string): Promise<unknown | null> =>
  getSpec(host, '/system/power/spec')

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
