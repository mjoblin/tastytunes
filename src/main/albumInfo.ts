// Album context: MusicBrainz release-group search -> release-group lookup
// (genre tags + Wikipedia via url-rels) -> earliest release lookup (label +
// release-level credits). Shares mb.ts's 1 rps MusicBrainz gate. Results
// cache per artist+album in a bounded disk-persisted LRU (diskCache.ts),
// including DEFINITIVE misses; transient failures return the best partial
// answer but are never cached, so the next request retries. `force` bypasses
// the cache read for the panel's refresh.
import type { AlbumInfo } from '@shared/ipc'
import { DiskCache } from './diskCache'
import { MB, mbFetch, wikipediaFromRels, type MbRelation } from './mb'

const CACHE_MAX = 500
const MIN_MATCH_SCORE = 75
const MAX_GENRES = 4
const MAX_CREDITS = 6

const cache = new DiskCache<AlbumInfo>('album', CACHE_MAX)

interface MbReleaseGroup {
  id: string
  title: string
  score?: number
  'first-release-date'?: string
  'primary-type'?: string
}

interface MbTag {
  name?: string
  count?: number
}

interface MbRelease {
  id?: string
  date?: string
}

interface MbCreditRel {
  type?: string
  artist?: { name?: string }
}

export async function fetchAlbumInfo(
  artist: string,
  album: string,
  force = false
): Promise<AlbumInfo | null> {
  const key = `${artist.trim()}|${album.trim()}`.toLowerCase()
  if (!artist.trim() || !album.trim()) return null
  if (!force && cache.has(key)) return cache.get(key) ?? null

  let result: AlbumInfo | null = null
  // Only a conclusion built purely from real answers goes into the cache.
  let definitive = true

  const query = `releasegroup:${JSON.stringify(album)} AND artist:${JSON.stringify(artist)}`
  const searchGot = await mbFetch(
    `${MB}/ws/2/release-group?query=${encodeURIComponent(query)}&fmt=json&limit=5`
  )
  if (searchGot.kind !== 'ok') {
    // couldn't even search — nothing to show, nothing to remember
    return null
  }
  // An album and a single can share a title exactly (Iron Maiden's "The
  // Number of the Beast") and tie on search score, with the single sorted
  // first. We're resolving an album tag from track metadata, so prefer the
  // Album-typed release group; fall back to the top result so a genuinely
  // playing single still resolves.
  const candidates = ((searchGot.body as { 'release-groups'?: MbReleaseGroup[] })[
    'release-groups'
  ] ?? []).filter((rg) => (rg.score ?? 0) >= MIN_MATCH_SCORE)
  const match = candidates.find((rg) => rg['primary-type'] === 'Album') ?? candidates[0]

  if (match) {
    result = {
      title: match.title,
      year: match['first-release-date']?.slice(0, 4) || null,
      type: match['primary-type'] ?? null,
      label: null,
      genres: [],
      credits: [],
      summary: null,
      wikipediaUrl: null,
      musicbrainzUrl: `https://musicbrainz.org/release-group/${match.id}`
    }

    const lookupGot = await mbFetch(
      `${MB}/ws/2/release-group/${match.id}?inc=url-rels+tags+releases&fmt=json`
    )
    if (lookupGot.kind !== 'ok') {
      definitive = false // detail state unknown — show the partial, retry later
    } else {
      const body = lookupGot.body as {
        relations?: MbRelation[]
        tags?: MbTag[]
        releases?: MbRelease[]
      }

      result.genres = (body.tags ?? [])
        .filter((t) => t.name && (t.count ?? 0) > 0)
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
        .slice(0, MAX_GENRES)
        .map((t) => t.name as string)

      const wiki = await wikipediaFromRels(body.relations ?? [])
      result.summary = wiki.summary
      result.wikipediaUrl = wiki.wikipediaUrl
      if (!wiki.definitive) definitive = false

      // The earliest dated release carries the original label and any
      // release-level credits (producer etc.). Recording-level credits would
      // cost a query burst against MB's 1 rps budget, so they stay out.
      const releases = (body.releases ?? []).filter((r) => r.id)
      releases.sort((a, b) => ((a.date || '9999') < (b.date || '9999') ? -1 : 1))
      const first = releases[0]
      if (first?.id) {
        const relGot = await mbFetch(`${MB}/ws/2/release/${first.id}?inc=labels+artist-rels&fmt=json`)
        if (relGot.kind !== 'ok') {
          definitive = false
        } else {
          const rel = relGot.body as {
            'label-info'?: Array<{ label?: { name?: string } }>
            relations?: MbCreditRel[]
          }
          result.label = rel['label-info']?.find((l) => l.label?.name)?.label?.name ?? null

          const seen = new Set<string>()
          for (const r of rel.relations ?? []) {
            const name = r.artist?.name
            if (!r.type || !name) continue
            const role = r.type[0].toUpperCase() + r.type.slice(1)
            const dedupe = `${role}|${name}`
            if (seen.has(dedupe)) continue
            seen.add(dedupe)
            result.credits.push({ role, name })
            if (result.credits.length >= MAX_CREDITS) break
          }
        }
      }
    }
  }
  // no match / low score with an OK search: an answer — cache the null

  if (definitive) cache.set(key, result)
  return result
}
