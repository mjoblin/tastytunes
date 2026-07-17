// LRCLIB lyrics lookup (lrclib.net) — keyless, no rate limits; they ask only
// for an identifying User-Agent, which is why this lives in the main process
// (renderer fetch can't set one). Results are cached per track in a bounded
// disk-persisted LRU (diskCache.ts) — including DEFINITIVE misses ("LRCLIB
// answered: no lyrics") — but transient failures (unreachable, timeout, 5xx)
// are never cached, so the next request retries cleanly. `force` bypasses the
// cache read for a user-driven refresh; its fresh answer overwrites the entry.
import { version } from '../../package.json'
import type { LyricsQuery, LyricsResult } from '@shared/ipc'
import { loggedFetch } from './netlog'
import { DiskCache } from './diskCache'

// TASTYTUNES_LYRICS_URL lets test harnesses point lookups at a local server.
const BASE = process.env['TASTYTUNES_LYRICS_URL'] ?? 'https://lrclib.net/api'
const USER_AGENT = `TastyTunes/${version} (https://github.com/mjoblin/tastytunes)`
const CACHE_MAX = 500
// Search fallback: a duration this far off is a different recording — its
// synced timestamps would drift, so keep only the plain text.
const SYNC_TOLERANCE_SECS = 10

const cache = new DiskCache<LyricsResult>('lyrics', CACHE_MAX)

interface ApiRecord {
  plainLyrics: string | null
  syncedLyrics: string | null
  instrumental: boolean
  duration?: number
}

/** ok = an answer; missing = authoritative 404; error = we never really asked. */
type Fetched =
  | { kind: 'ok'; body: unknown }
  | { kind: 'missing' }
  | { kind: 'error' }

async function getJson(url: string): Promise<Fetched> {
  try {
    const res = await loggedFetch('lrclib', url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    })
    if (res.status === 404) return { kind: 'missing' }
    if (!res.ok) return { kind: 'error' }
    return { kind: 'ok', body: await res.json() }
  } catch {
    return { kind: 'error' }
  }
}

export async function fetchLyrics(q: LyricsQuery, force = false): Promise<LyricsResult | null> {
  const key = [q.artist, q.title, q.album ?? '', q.duration ?? ''].join('|').toLowerCase()
  if (!force && cache.has(key)) return cache.get(key) ?? null

  let result: LyricsResult | null = null
  // Only a conclusion built purely from real answers goes into the cache.
  let definitive = true

  const exact = new URLSearchParams({ artist_name: q.artist, track_name: q.title })
  if (q.album) exact.set('album_name', q.album)
  if (q.duration != null) exact.set('duration', String(Math.round(q.duration)))
  const got = await getJson(`${BASE}/get?${exact}`)

  let rec: ApiRecord | null = got.kind === 'ok' ? (got.body as ApiRecord) : null
  if (got.kind === 'error') definitive = false

  let syncTrusted = true
  if (!rec) {
    const search = new URLSearchParams({ artist_name: q.artist, track_name: q.title })
    const listGot = await getJson(`${BASE}/search?${search}`)
    if (listGot.kind !== 'ok') {
      // search has no 404 shape — anything non-ok is a failure to ask
      definitive = false
    } else {
      const list = listGot.body as ApiRecord[]
      if (list.length > 0) {
        // Among duration-plausible candidates, PREFER one with synced lyrics —
        // search order is arbitrary and a plain-only record can tie a synced
        // one on duration (Rein Me In taught us this). Only fall back to the
        // globally closest record (plain text only) when nothing is close.
        const delta = (c: ApiRecord): number =>
          q.duration == null ? 0 : Math.abs((c.duration ?? Infinity) - q.duration)
        const within = list.filter((c) => delta(c) <= SYNC_TOLERANCE_SECS)
        if (within.length > 0) {
          rec = within.find((c) => c.syncedLyrics) ?? within[0]
          syncTrusted = true
        } else {
          rec = list.reduce((best, c) => (delta(c) < delta(best) ? c : best))
          syncTrusted = false
        }
      }
      // an OK empty search IS an answer: no lyrics exist -> cacheable miss
    }
  }

  if (rec) {
    result = {
      plain: rec.plainLyrics ?? null,
      synced: syncTrusted ? (rec.syncedLyrics ?? null) : null,
      instrumental: !!rec.instrumental
    }
    definitive = true // a found record is an answer regardless of the path here
  }

  if (definitive) cache.set(key, result)
  return result
}
