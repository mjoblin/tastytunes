// Shared MusicBrainz / Wikidata / Wikipedia plumbing for the context lookups
// (artist bios, album details). MusicBrainz enforces ONE request per second
// per IP and an identifying User-Agent (violators get 100% declined) — every
// MB call from anywhere in the app goes through the single spacing gate here.
import { version } from '../../package.json'
import { REPO_URL } from '@shared/ipc'
import { loggedFetch } from './netlog'

// Env overrides let test harnesses point each hop at a local server.
export const MB = process.env['TASTYTUNES_MB_URL'] ?? 'https://musicbrainz.org'
export const WD = process.env['TASTYTUNES_WD_URL'] ?? 'https://www.wikidata.org'
export const WIKI = process.env['TASTYTUNES_WIKI_URL'] ?? 'https://en.wikipedia.org'
const USER_AGENT = `TastyTunes/${version} (${REPO_URL})`

/** ok = an answer; missing = authoritative 404; error = we never really asked. */
export type Fetched =
  | { kind: 'ok'; body: unknown }
  | { kind: 'missing' }
  | { kind: 'error' }

export async function getJson(service: string, url: string): Promise<Fetched> {
  try {
    const res = await loggedFetch(service, url, {
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
export function mbFetch(url: string): Promise<Fetched> {
  const next = mbChain.then(async () => {
    const wait = mbLastAt + 1100 - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    mbLastAt = Date.now()
    return getJson('musicbrainz', url)
  })
  mbChain = next.catch(() => null)
  return next
}

export interface MbRelation {
  type?: string
  url?: { resource?: string }
}

/**
 * Resolve a Wikipedia summary from MB url-rels: a direct wikipedia rel
 * (legacy) or wikidata -> enwiki sitelink -> REST summary. `definitive:
 * false` means a transient failure somewhere in the chain — show what we
 * have, but don't cache it.
 */
export async function wikipediaFromRels(
  rels: MbRelation[]
): Promise<{ summary: string | null; wikipediaUrl: string | null; definitive: boolean }> {
  let definitive = true
  let title: string | null = null

  const wikipedia = rels.find((r) => r.type === 'wikipedia')?.url?.resource
  if (wikipedia) {
    title = decodeURIComponent(wikipedia.split('/wiki/')[1] ?? '')
  } else {
    const wikidata = rels.find((r) => r.type === 'wikidata')?.url?.resource
    const qid = wikidata?.split('/wiki/')[1]
    if (qid) {
      const entityGot = await getJson('wikidata', `${WD}/wiki/Special:EntityData/${qid}.json`)
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

  let summary: string | null = null
  let wikipediaUrl: string | null = null
  if (title) {
    const summaryGot = await getJson(
      'wikipedia',
      `${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(title)}`
    )
    if (summaryGot.kind === 'error') {
      definitive = false
    } else if (summaryGot.kind === 'ok') {
      const s = summaryGot.body as {
        extract?: string
        content_urls?: { desktop?: { page?: string } }
      }
      if (s.extract) {
        summary = s.extract
        wikipediaUrl =
          s.content_urls?.desktop?.page ??
          `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`
      }
    }
    // 'missing' = the article is gone: an answer, stays definitive
  }

  return { summary, wikipediaUrl, definitive }
}
