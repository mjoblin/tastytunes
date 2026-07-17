// Artist context: MusicBrainz search -> URL relations -> Wikipedia summary
// (shared plumbing in mb.ts, including the 1 rps MusicBrainz gate). Results
// cache per artist name in a bounded disk-persisted LRU (diskCache.ts),
// including DEFINITIVE misses ("MB answered: no such artist" / "no Wikipedia
// linked"); transient failures anywhere in the chain (unreachable, timeout,
// 5xx) return the best partial answer for the moment but are never cached, so
// the next request retries. `force` bypasses the cache read for a
// user-driven refresh.
import type { ArtistInfo } from '@shared/ipc'
import { DiskCache } from './diskCache'
import { MB, mbFetch, wikipediaFromRels, type MbRelation } from './mb'

const CACHE_MAX = 500
const MIN_MATCH_SCORE = 75

const cache = new DiskCache<ArtistInfo>('artist', CACHE_MAX)

interface MbArtist {
  id: string
  name: string
  score?: number
}

export async function fetchArtistInfo(artist: string, force = false): Promise<ArtistInfo | null> {
  const key = artist.trim().toLowerCase()
  if (!key) return null
  if (!force && cache.has(key)) return cache.get(key) ?? null

  let result: ArtistInfo | null = null
  // Only a conclusion built purely from real answers goes into the cache.
  let definitive = true

  const searchGot = await mbFetch(
    `${MB}/ws/2/artist?query=artist:${encodeURIComponent(JSON.stringify(artist))}&fmt=json&limit=3`
  )
  if (searchGot.kind !== 'ok') {
    // couldn't even search — nothing to show, nothing to remember
    return null
  }
  const match = (searchGot.body as { artists?: MbArtist[] }).artists?.[0]

  if (match && (match.score ?? 0) >= MIN_MATCH_SCORE) {
    const musicbrainzUrl = `https://musicbrainz.org/artist/${match.id}`
    result = { name: match.name, summary: null, wikipediaUrl: null, musicbrainzUrl }

    const lookupGot = await mbFetch(`${MB}/ws/2/artist/${match.id}?inc=url-rels&fmt=json`)
    if (lookupGot.kind !== 'ok') {
      definitive = false // summary state unknown — show the partial, retry later
    } else {
      const rels = (lookupGot.body as { relations?: MbRelation[] }).relations ?? []
      const wiki = await wikipediaFromRels(rels)
      result.summary = wiki.summary
      result.wikipediaUrl = wiki.wikipediaUrl
      if (!wiki.definitive) definitive = false
    }
  }
  // no match / low score with an OK search: an answer — cache the null

  if (definitive) cache.set(key, result)
  return result
}
