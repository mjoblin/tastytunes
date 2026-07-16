// Artist context: MusicBrainz search -> URL relations -> Wikidata sitelink ->
// Wikipedia summary. MusicBrainz enforces ONE request per second per IP and an
// identifying User-Agent (violators get 100% declined) — every MB call goes
// through a spacing gate. Results cache in memory per artist name, including
// DEFINITIVE misses ("MB answered: no such artist" / "no Wikipedia linked");
// transient failures anywhere in the chain (unreachable, timeout, 5xx) return
// the best partial answer for the moment but are never cached, so the next
// request retries. `force` bypasses the cache read for a user-driven refresh.
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

/** ok = an answer; missing = authoritative 404; error = we never really asked. */
type Fetched =
  | { kind: 'ok'; body: unknown }
  | { kind: 'missing' }
  | { kind: 'error' }

async function getJson(url: string): Promise<Fetched> {
  try {
    const res = await fetch(url, {
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

// The MusicBrainz 1 rps gate: calls queue behind each other, spaced >= 1.1s.
let mbChain: Promise<unknown> = Promise.resolve()
let mbLastAt = 0
function mbFetch(url: string): Promise<Fetched> {
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

      // Modern MB links to Wikidata; direct Wikipedia rels are legacy but easy.
      let title: string | null = null
      const wikipedia = rels.find((r) => r.type === 'wikipedia')?.url?.resource
      if (wikipedia) {
        title = decodeURIComponent(wikipedia.split('/wiki/')[1] ?? '')
      } else {
        const wikidata = rels.find((r) => r.type === 'wikidata')?.url?.resource
        const qid = wikidata?.split('/wiki/')[1]
        if (qid) {
          const entityGot = await getJson(`${WD}/wiki/Special:EntityData/${qid}.json`)
          if (entityGot.kind === 'error') {
            definitive = false
          } else if (entityGot.kind === 'ok') {
            const entities = (
              entityGot.body as {
                entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }>
              }
            ).entities
            title = entities?.[qid]?.sitelinks?.enwiki?.title ?? null
          }
          // 'missing' = no such entity: an answer, stays definitive
        }
        // no wikidata relation at all: an answer — no summary to link
      }

      if (title) {
        const summaryGot = await getJson(
          `${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(title)}`
        )
        if (summaryGot.kind === 'error') {
          definitive = false
        } else if (summaryGot.kind === 'ok') {
          const summary = summaryGot.body as {
            extract?: string
            content_urls?: { desktop?: { page?: string } }
          }
          if (summary.extract) {
            result.summary = summary.extract
            result.wikipediaUrl =
              summary.content_urls?.desktop?.page ??
              `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`
          }
        }
        // 'missing' = the article is gone: an answer, stays definitive
      }
    }
  }
  // no match / low score with an OK search: an answer — cache the null

  if (definitive) {
    if (cache.size >= CACHE_MAX && !cache.has(key)) {
      const oldest = cache.keys().next().value
      if (oldest != null) cache.delete(oldest)
    }
    cache.set(key, result)
  }
  return result
}
