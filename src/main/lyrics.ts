// LRCLIB lyrics lookup (lrclib.net) — keyless, no rate limits; they ask only
// for an identifying User-Agent, which is why this lives in the main process
// (renderer fetch can't set one). Results are cached per track in a bounded
// disk-persisted LRU (diskCache.ts) — including DEFINITIVE misses ("LRCLIB
// answered: no lyrics") — but transient failures (unreachable, timeout, 5xx)
// are never cached, so the next request retries cleanly. `force` bypasses the
// cache read for a user-driven refresh; its fresh answer overwrites the entry.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { version } from '../../package.json'
import type { LyricsQuery, LyricsResult } from '@shared/ipc'
import { REPO_URL } from '@shared/ipc'
import { loggedFetch } from './netlog'
import { DiskCache } from './diskCache'

// TASTYTUNES_LYRICS_URL lets test harnesses point lookups at a local server.
const BASE = process.env['TASTYTUNES_LYRICS_URL'] ?? 'https://lrclib.net/api'
const USER_AGENT = `TastyTunes/${version} (${REPO_URL})`
const CACHE_MAX = 500
// Search fallback: a duration this far off is a different recording — its
// synced timestamps would drift, so keep only the plain text.
const SYNC_TOLERANCE_SECS = 10

// Generation 2: v1 predates the plain-only-/get synced upgrade below, so its
// entries can hold plain-only results for tracks whose synced record was one
// search away. A cache is a cache — start clean rather than serve those
// until LRU turnover (the v1 file is removed on first use).
const cache = new DiskCache<LyricsResult>('lyrics2', CACHE_MAX)
let purgedV1 = false

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
  if (!purgedV1) {
    purgedV1 = true
    try {
      rmSync(join(app.getPath('userData'), 'cache', 'lyrics.json'), { force: true })
    } catch {
      // best-effort tidy-up of the generation-1 file
    }
  }
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
  // The exact hit only SEEDS the answer: LRCLIB's /get fuzzy-matches, and a
  // plain-only exact record can sit one search away from synced records of
  // the same recording (live-hit 2026-07-21: Keane's "On A Day Like Today" —
  // plain-only /get answer, six synced candidates within tolerance). A
  // plain-only, non-instrumental /get result therefore still runs the
  // search, looking for a duration-plausible SYNCED record to upgrade to —
  // the record swaps wholesale (its plain + timestamps come from the same
  // edit; never mix lines from one record with timing from another).
  const wantUpgrade = rec != null && !rec.syncedLyrics && !rec.instrumental
  let upgradeIncomplete = false
  if (!rec || wantUpgrade) {
    const search = new URLSearchParams({ artist_name: q.artist, track_name: q.title })
    const listGot = await getJson(`${BASE}/search?${search}`)
    if (listGot.kind !== 'ok') {
      // search has no 404 shape — anything non-ok is a failure to ask
      if (rec) upgradeIncomplete = true
      else definitive = false
    } else {
      const list = listGot.body as ApiRecord[]
      const delta = (c: ApiRecord): number =>
        q.duration == null ? 0 : Math.abs((c.duration ?? Infinity) - q.duration)
      // Among duration-plausible candidates, PREFER synced, closest first —
      // search order is arbitrary and a plain-only record can tie a synced
      // one on duration (Rein Me In taught us this).
      const within = list
        .filter((c) => delta(c) <= SYNC_TOLERANCE_SECS)
        .sort((a, b) => delta(a) - delta(b))
      const synced = within.find((c) => c.syncedLyrics) ?? null
      if (wantUpgrade) {
        // only a synced record improves on the exact answer we already hold
        if (synced) rec = synced
      } else if (within.length > 0) {
        rec = synced ?? within[0]
        syncTrusted = true
      } else if (list.length > 0) {
        // Only fall back to the globally closest record (plain text only)
        // when nothing is close.
        rec = list.reduce((best, c) => (delta(c) < delta(best) ? c : best))
        syncTrusted = false
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
    // a found record is an answer — unless the upgrade check never really
    // ran, in which case the next request should get to retry it
    if (!upgradeIncomplete) definitive = true
    else definitive = false
  }

  if (definitive) cache.set(key, result)
  return result
}
