// LRCLIB lyrics lookup (lrclib.net) — keyless, no rate limits; they ask only
// for an identifying User-Agent, which is why this lives in the main process
// (renderer fetch can't set one). Results — including misses — are cached in
// memory per track so reopening the panel never re-fetches.
import { version } from '../../package.json'
import type { LyricsQuery, LyricsResult } from '@shared/ipc'

// TASTYTUNES_LYRICS_URL lets test harnesses point lookups at a local server.
const BASE = process.env['TASTYTUNES_LYRICS_URL'] ?? 'https://lrclib.net/api'
const USER_AGENT = `TastyTunes/${version} (https://github.com/mjoblin/tastytunes)`
const CACHE_MAX = 100
// Search fallback: a duration this far off is a different recording — its
// synced timestamps would drift, so keep only the plain text.
const SYNC_TOLERANCE_SECS = 10

const cache = new Map<string, LyricsResult | null>()

interface ApiRecord {
  plainLyrics: string | null
  syncedLyrics: string | null
  instrumental: boolean
  duration?: number
}

async function getJson(url: string): Promise<unknown | null> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) return null
  return res.json()
}

export async function fetchLyrics(q: LyricsQuery): Promise<LyricsResult | null> {
  const key = [q.artist, q.title, q.album ?? '', q.duration ?? ''].join('|').toLowerCase()
  if (cache.has(key)) return cache.get(key) ?? null

  let result: LyricsResult | null = null
  try {
    const exact = new URLSearchParams({ artist_name: q.artist, track_name: q.title })
    if (q.album) exact.set('album_name', q.album)
    if (q.duration != null) exact.set('duration', String(Math.round(q.duration)))
    let rec = (await getJson(`${BASE}/get?${exact}`)) as ApiRecord | null

    let syncTrusted = true
    if (!rec) {
      const search = new URLSearchParams({ artist_name: q.artist, track_name: q.title })
      const list = (await getJson(`${BASE}/search?${search}`)) as ApiRecord[] | null
      if (list && list.length > 0) {
        rec =
          q.duration == null
            ? list[0]
            : list.reduce((best, c) =>
                Math.abs((c.duration ?? Infinity) - q.duration!) <
                Math.abs((best.duration ?? Infinity) - q.duration!)
                  ? c
                  : best
              )
        syncTrusted =
          q.duration == null ||
          (rec.duration != null && Math.abs(rec.duration - q.duration) <= SYNC_TOLERANCE_SECS)
      }
    }

    if (rec) {
      result = {
        plain: rec.plainLyrics ?? null,
        synced: syncTrusted ? (rec.syncedLyrics ?? null) : null,
        instrumental: !!rec.instrumental
      }
    }
  } catch {
    // offline / LRCLIB down — cache the miss; a track change retries naturally
  }

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest != null) cache.delete(oldest)
  }
  cache.set(key, result)
  return result
}
