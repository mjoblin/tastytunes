// Internet-radio directory lookups via radio-browser.info — community-run,
// keyless, no shipped secrets (the same rule that vetoed Last.fm). They ask
// only for an identifying User-Agent, which is why this lives in the main
// process (renderer fetch can't set one, and the renderer CSP blocks external
// hosts anyway). Searches are live (no cache): the directory ranks by
// popularity and station health server-side, and results should reflect it.
// Deliberately NOT sent: the per-station "click" ping the directory offers —
// it would report listening activity to a third party; revisit only as an
// opt-in (privacy table in the README is a promise).
import { version } from '../../package.json'
import type { RadioStation } from '@shared/ipc'
import { REPO_URL } from '@shared/ipc'
import { loggedFetch } from './netlog'

// TASTYTUNES_RADIO_URL lets test harnesses point lookups at a local server.
// all.api.radio-browser.info is the project's round-robin DNS over its
// mirrors — fine for interactive use like ours.
const BASE = process.env['TASTYTUNES_RADIO_URL'] ?? 'https://all.api.radio-browser.info/json'
const USER_AGENT = `TastyTunes/${version} (${REPO_URL})`
const LIMIT = 60

interface ApiStation {
  stationuuid: string
  name: string
  url_resolved: string
  url: string
  favicon: string
  homepage: string
  tags: string
  country: string
  codec: string
  bitrate: number
}

function toStation(s: ApiStation): RadioStation | null {
  const url = s.url_resolved || s.url
  if (!url || !s.name?.trim()) return null
  return {
    uuid: s.stationuuid,
    name: s.name.trim(),
    url,
    favicon: s.favicon || null,
    homepage: s.homepage || null,
    tags: s.tags ?? '',
    country: s.country ?? '',
    codec: s.codec ?? '',
    bitrate: s.bitrate ?? 0
  }
}

async function stations(path: string): Promise<RadioStation[]> {
  try {
    const res = await loggedFetch('radio-browser', `${BASE}${path}`, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return []
    const body = (await res.json()) as ApiStation[]
    const out: RadioStation[] = []
    const seen = new Set<string>()
    for (const s of body) {
      const st = toStation(s)
      // the directory holds many duplicate registrations of one stream
      if (st && !seen.has(st.url)) {
        seen.add(st.url)
        out.push(st)
      }
    }
    return out
  } catch {
    return []
  }
}

/** Name search, most-listened first, broken stations filtered by the directory. */
export function radioSearch(query: string): Promise<RadioStation[]> {
  const q = query.trim()
  if (!q) return Promise.resolve([])
  const params = new URLSearchParams({
    name: q,
    limit: String(LIMIT),
    hidebroken: 'true',
    order: 'clickcount',
    reverse: 'true'
  })
  return stations(`/stations/search?${params}`)
}

/** The directory's most-listened stations — the screen's default rail. */
export function radioTop(): Promise<RadioStation[]> {
  return stations(`/stations/topclick/${LIMIT}?hidebroken=true`)
}
