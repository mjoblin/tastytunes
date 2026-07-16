// Artist context: MusicBrainz search -> URL relations -> Wikidata sitelink ->
// Wikipedia summary. MusicBrainz enforces ONE request per second per IP and an
// identifying User-Agent (violators get 100% declined) — every MB call goes
// through a spacing gate. Results, including misses, cache in memory per
// artist name so track flipping never re-queries.
import { version } from '../../package.json'
import type { ArtistInfo } from '@shared/ipc'

// Env overrides let test harnesses point each hop at a local server.
const MB = process.env['TASTYTUNES_MB_URL'] ?? 'https://musicbrainz.org'
const WD = process.env['TASTYTUNES_WD_URL'] ?? 'https://www.wikidata.org'
const WIKI = process.env['TASTYTUNES_WIKI_URL'] ?? 'https://en.wikipedia.org'
const USER_AGENT = `TastyTunes/${version} (https://github.com/mjoblin/tastytunes)`
const CACHE_MAX = 50
const MIN_MATCH_SCORE = 75

const cache = new Map<string, ArtistInfo | null>()

async function getJson(url: string): Promise<unknown | null> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) return null
  return res.json()
}

// The MusicBrainz 1 rps gate: calls queue behind each other, spaced >= 1.1s.
let mbChain: Promise<unknown> = Promise.resolve()
let mbLastAt = 0
function mbFetch(url: string): Promise<unknown | null> {
  const next = mbChain.then(async () => {
    const wait = mbLastAt + 1100 - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    mbLastAt = Date.now()
    return getJson(url)
  })
  mbChain = next.catch(() => null)
  return next
}

interface MbArtist {
  id: string
  name: string
  score?: number
}

interface MbRelation {
  type?: string
  url?: { resource?: string }
}

export async function fetchArtistInfo(artist: string): Promise<ArtistInfo | null> {
  const key = artist.trim().toLowerCase()
  if (!key) return null
  if (cache.has(key)) return cache.get(key) ?? null

  let result: ArtistInfo | null = null
  try {
    const search = (await mbFetch(
      `${MB}/ws/2/artist?query=artist:${encodeURIComponent(JSON.stringify(artist))}&fmt=json&limit=3`
    )) as { artists?: MbArtist[] } | null
    const match = search?.artists?.[0]
    if (match && (match.score ?? 0) >= MIN_MATCH_SCORE) {
      const musicbrainzUrl = `https://musicbrainz.org/artist/${match.id}`
      result = { name: match.name, summary: null, wikipediaUrl: null, musicbrainzUrl }

      const lookup = (await mbFetch(
        `${MB}/ws/2/artist/${match.id}?inc=url-rels&fmt=json`
      )) as { relations?: MbRelation[] } | null
      const rels = lookup?.relations ?? []

      // Modern MB links to Wikidata; direct Wikipedia rels are legacy but easy.
      let title: string | null = null
      const wikipedia = rels.find((r) => r.type === 'wikipedia')?.url?.resource
      if (wikipedia) {
        title = decodeURIComponent(wikipedia.split('/wiki/')[1] ?? '')
      } else {
        const wikidata = rels.find((r) => r.type === 'wikidata')?.url?.resource
        const qid = wikidata?.split('/wiki/')[1]
        if (qid) {
          const entity = (await getJson(`${WD}/wiki/Special:EntityData/${qid}.json`)) as {
            entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }>
          } | null
          title = entity?.entities?.[qid]?.sitelinks?.enwiki?.title ?? null
        }
      }

      if (title) {
        const summary = (await getJson(
          `${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(title)}`
        )) as { extract?: string; content_urls?: { desktop?: { page?: string } } } | null
        if (summary?.extract) {
          result.summary = summary.extract
          result.wikipediaUrl =
            summary.content_urls?.desktop?.page ??
            `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`
        }
      }
    }
  } catch {
    result = null // offline etc — cached as a miss; a later track retries via new artists
  }

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest != null) cache.delete(oldest)
  }
  cache.set(key, result)
  return result
}
