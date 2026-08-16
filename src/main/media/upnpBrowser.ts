// UPnP media browsing for the Library screen. Server discovery rides the
// streamer (`GET /smoip/system/upnp` lists every UPnP device it knows —
// including itself when USB storage is attached); browsing is plain
// ContentDirectory:1 SOAP. Everything happens here in the main process: the
// renderer only ever sees typed MediaNodes, and DIDL-Lite never leaves this
// file except encoded inside /smoip/queue/add (queue writes) or a JSON body
// (action=PRESET — preset saves). Streamer-directed SMOIP traffic is
// unlogged (it has its own console); media-server traffic logs as 'upnp'.
import { XMLParser } from 'fast-xml-parser'
import type { MediaNode, MediaQueueAction, MediaServerInfo } from '@shared/model'
import { loggedFetch } from '../netlog'

const PAGE_SIZE = 5000 // the streamer's own server ignores RequestedCount=0

interface ServerEntry extends MediaServerInfo {
  controlUrl: string
  /** Raw SearchCaps: "*" (anything), a CSV of properties, or "" (no search). */
  searchCaps: string
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  // The SOAP Result is ESCAPED XML — every tag bracket of the inner DIDL is
  // an &lt;/&gt; entity, so a large listing (Asset's "[All Album Artists]")
  // blows straight past fast-xml-parser's default billion-laughs guard of
  // 1000 expansions ("Couldn't browse this library" on big folders). Keep
  // the guard, raise the ceilings to fit real library sizes.
  processEntities: {
    enabled: true,
    maxTotalExpansions: 5_000_000,
    maxExpandedLength: 50_000_000
  }
})

let servers = new Map<string, ServerEntry>()
// Per-node listing cache, session only. Streamer-USB ids rot across standby;
// a failed browse falls back to re-walking the breadcrumb titles from root.
const nodeCache = new Map<string, MediaNode[]>()

const asArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v])

const text = (v: unknown): string | null => {
  if (v == null) return null
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  const inner = (v as Record<string, unknown>)['#text']
  return inner == null ? null : String(inner)
}

// ------------------------------------------------------------ server registry

export async function refreshServers(host: string): Promise<MediaServerInfo[]> {
  const res = await fetch(`http://${host}/smoip/system/upnp`, {
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) throw new Error(`system/upnp -> HTTP ${res.status}`)
  const body = (await res.json()) as {
    data?: {
      devices?: Array<{
        model?: string
        name?: string
        manufacturer?: string
        udn?: string
        description_url?: string
      }>
    }
  }

  const streamerIp = host.split(':')[0]
  const next = new Map<string, ServerEntry>()
  for (const dev of body.data?.devices ?? []) {
    if (!dev.udn || !dev.description_url) continue
    const controlUrl = await contentDirectoryControlUrl(dev.description_url)
    if (!controlUrl) continue // no ContentDirectory — a renderer-only device
    const searchCaps = await getSearchCaps(controlUrl)
    next.set(dev.udn, {
      udn: dev.udn,
      name: dev.name ?? dev.model ?? 'Media server',
      model: dev.model ?? null,
      isStreamer: new URL(dev.description_url).hostname === streamerIp,
      searchable: searchCaps.length > 0,
      searchCaps,
      controlUrl
    })
  }
  servers = next
  nodeCache.clear()
  return [...next.values()].map(({ udn, name, model, isStreamer, searchable }) => ({
    udn,
    name,
    model,
    isStreamer,
    searchable
  }))
}

/** GetSearchCapabilities: "*" = anything, CSV = specific properties, "" = none. */
async function getSearchCaps(controlUrl: string): Promise<string> {
  try {
    const res = await loggedFetch('upnp', controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#GetSearchCapabilities"'
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><u:GetSearchCapabilities xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"></u:GetSearchCapabilities></s:Body>
</s:Envelope>`,
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return ''
    const doc = parser.parse(await res.text()) as {
      Envelope?: { Body?: { GetSearchCapabilitiesResponse?: { SearchCaps?: unknown } } }
    }
    return text(doc.Envelope?.Body?.GetSearchCapabilitiesResponse?.SearchCaps)?.trim() ?? ''
  } catch {
    return ''
  }
}

async function contentDirectoryControlUrl(descriptionUrl: string): Promise<string | null> {
  try {
    const res = await loggedFetch('upnp', descriptionUrl, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const doc = parser.parse(await res.text()) as Record<string, never>
    const device = (doc as { root?: { device?: unknown } }).root?.device as
      | Record<string, unknown>
      | undefined
    if (!device) return null
    const services = asArray(
      (device.serviceList as { service?: unknown } | undefined)?.service as
        | Record<string, unknown>
        | Array<Record<string, unknown>>
        | undefined
    )
    const cd = services.find((s) => String(s.serviceType ?? '').includes('ContentDirectory'))
    const control = cd && text(cd.controlURL)
    return control ? new URL(control, descriptionUrl).toString() : null
  } catch {
    return null
  }
}

async function entryFor(host: string, serverUdn: string): Promise<ServerEntry> {
  if (!servers.has(serverUdn)) await refreshServers(host)
  const entry = servers.get(serverUdn)
  if (!entry) throw new Error('media server not found')
  return entry
}

// ------------------------------------------------------------------ SOAP Browse

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function soapEnvelope(objectId: string, flag: string, start: number, count: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <ObjectID>${xmlEscape(objectId)}</ObjectID>
      <BrowseFlag>${flag}</BrowseFlag>
      <Filter>*</Filter>
      <StartingIndex>${start}</StartingIndex>
      <RequestedCount>${count}</RequestedCount>
      <SortCriteria></SortCriteria>
    </u:Browse>
  </s:Body>
</s:Envelope>`
}

async function soapBrowse(
  entry: ServerEntry,
  objectId: string,
  flag: 'BrowseDirectChildren' | 'BrowseMetadata',
  start = 0,
  count = PAGE_SIZE
): Promise<{ didl: string; returned: number; total: number } | null> {
  try {
    const res = await loggedFetch('upnp', entry.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'
      },
      body: soapEnvelope(objectId, flag, start, count),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) return null
    const doc = parser.parse(await res.text()) as {
      Envelope?: {
        Body?: {
          BrowseResponse?: { Result?: unknown; NumberReturned?: number; TotalMatches?: number }
        }
      }
    }
    const br = doc.Envelope?.Body?.BrowseResponse
    const didl = text(br?.Result)
    if (didl == null) return null
    return { didl, returned: Number(br?.NumberReturned ?? 0), total: Number(br?.TotalMatches ?? 0) }
  } catch {
    return null
  }
}

// "0:06:58.000" -> seconds
function parseDuration(v: string | null): number | null {
  if (!v) return null
  const m = v.match(/^(\d+):(\d{1,2}):(\d{1,2})/)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

function didlToNodes(didl: string): MediaNode[] {
  const doc = parser.parse(didl) as { 'DIDL-Lite'?: Record<string, unknown> }
  const root = doc['DIDL-Lite']
  if (!root) return []

  const node = (raw: Record<string, unknown>, isContainer: boolean): MediaNode | null => {
    const id = text(raw['@_id'])
    const title = text(raw.title)
    if (!id || title == null) return null
    const res = asArray(raw.res as Record<string, unknown> | Array<Record<string, unknown>>)[0]
    // multi-valued two ways: taggers repeat <upnp:genre> AND pack several
    // into one value ("Pop; Rock" — live-observed on Asset). Split on ';',
    // dedupe case-insensitively, keep first-seen casing and order.
    const seenGenres = new Map<string, string>()
    for (const g of asArray(raw.genre as Record<string, unknown> | Array<Record<string, unknown>>)) {
      for (const part of (text(g) ?? '').split(';')) {
        const trimmed = part.trim()
        if (trimmed && !seenGenres.has(trimmed.toLowerCase()))
          seenGenres.set(trimmed.toLowerCase(), trimmed)
      }
    }
    const genres = [...seenGenres.values()]
    // upnp:artist is multi-valued THREE ways, all live-observed on Asset
    // (2026-08-15, a Daft Punk track with a featured singer):
    //   <upnp:artist role="AlbumArtist">Daft Punk</upnp:artist>
    //   <upnp:artist>Daft Punk; Julian Casablancas</upnp:artist>
    //   <upnp:artist role="Composer">Thomas Bangalter; Guy-Manuel …</upnp:artist>
    // — repeated elements, a role attribute, AND several names packed into
    // one value with '; ' (the same packing genres use). Before this the
    // parser took text() of the ARRAY, got null, and fell through to
    // dc:creator — so every featured track carried the packed performer
    // string as its whole identity, and an album's featured tracks fell out
    // of the album under its artist. Now: `artist` stays the display string
    // (the performers, packed — "Daft Punk; Julian Casablancas" is what a
    // row should say), `albumArtist` is the AlbumArtist role when a server
    // sends one, and `artists` is the split performer list when there is
    // more than one name — the lens keys identity on those two, never on
    // the packed string. Composer/Conductor/… roles are not performers.
    const artistEls = asArray(raw.artist as unknown | unknown[])
    const roleOf = (el: unknown): string =>
      el != null && typeof el === 'object' ? String((el as Record<string, unknown>)['@_role'] ?? '').toLowerCase() : ''
    const albumArtist = text(artistEls.find((el) => roleOf(el) === 'albumartist')) ?? null
    const performerEls = artistEls.filter((el) => ['', 'performer', 'artist'].includes(roleOf(el)))
    const performerText = performerEls.map(text).filter((v): v is string => !!v?.trim())
    const artist =
      (performerText.length > 0 ? performerText.join('; ') : null) ??
      text(raw.creator) ??
      albumArtist ??
      text(artistEls[0]) ??
      null
    const seenArtists = new Map<string, string>()
    for (const part of (artist ?? '').split(';')) {
      const trimmed = part.trim()
      if (trimmed && !seenArtists.has(trimmed.toLowerCase())) seenArtists.set(trimmed.toLowerCase(), trimmed)
    }
    const artists = [...seenArtists.values()]
    return {
      ...(genres.length > 0 ? { genre: genres } : {}),
      ...(albumArtist != null && albumArtist.trim() ? { albumArtist: albumArtist.trim() } : {}),
      ...(artists.length > 1 ? { artists } : {}),
      id,
      parentId: text(raw['@_parentID']),
      title,
      upnpClass: text(raw.class) ?? '',
      isContainer,
      artUrl: text(raw.albumArtURI),
      artist,
      album: text(raw.album),
      year: text(raw.date)?.slice(0, 4) ?? null,
      trackNumber: raw.originalTrackNumber != null ? Number(text(raw.originalTrackNumber)) : null,
      // multi-disc: Asset sends both, and packs disc×100+track into the
      // track number besides — decoded by trackPosition(), never here.
      ...(raw.originalDiscNumber != null && Number.isFinite(Number(text(raw.originalDiscNumber)))
        ? { discNumber: Number(text(raw.originalDiscNumber)) }
        : {}),
      ...(raw.originalDiscCount != null && Number.isFinite(Number(text(raw.originalDiscCount)))
        ? { discCount: Number(text(raw.originalDiscCount)) }
        : {}),
      durationSecs: res ? parseDuration(text(res['@_duration'])) : null
    }
  }

  const containers = asArray(
    root.container as Record<string, unknown> | Array<Record<string, unknown>>
  )
    .map((c) => node(c, true))
    .filter((n): n is MediaNode => n != null)
  const items = asArray(root.item as Record<string, unknown> | Array<Record<string, unknown>>)
    .map((i) => node(i, false))
    .filter((n): n is MediaNode => n != null)
  return [...containers, ...items]
}

async function browseChildren(entry: ServerEntry, objectId: string): Promise<MediaNode[] | null> {
  const first = await soapBrowse(entry, objectId, 'BrowseDirectChildren')
  if (!first) return null
  let nodes = didlToNodes(first.didl)
  // Page through folders bigger than one response (and servers that cap it).
  while (nodes.length < first.total) {
    const more = await soapBrowse(entry, objectId, 'BrowseDirectChildren', nodes.length)
    if (!more) break
    const add = didlToNodes(more.didl)
    if (add.length === 0) break
    nodes = nodes.concat(add)
  }
  return nodes
}

export async function browse(
  host: string,
  serverUdn: string,
  objectId: string | null,
  titlePath: string[]
): Promise<MediaNode[]> {
  const entry = await entryFor(host, serverUdn)
  const id = objectId ?? '0'
  const key = `${serverUdn}|${id}`
  const cached = nodeCache.get(key)
  if (cached) return cached

  let nodes = await browseChildren(entry, id)
  if (nodes == null && objectId != null) {
    // Stale id (streamer-USB ids rot across standby) — drop this server's
    // cache and re-walk the breadcrumb titles from the root.
    for (const k of [...nodeCache.keys()]) if (k.startsWith(`${serverUdn}|`)) nodeCache.delete(k)
    nodes = await rewalk(entry, titlePath)
  }
  if (nodes == null) throw new Error('browse failed')
  nodeCache.set(key, nodes)
  return nodes
}

async function rewalk(entry: ServerEntry, titlePath: string[]): Promise<MediaNode[] | null> {
  let id = '0'
  for (const title of titlePath) {
    const kids = await browseChildren(entry, id)
    const next = kids?.find((k) => k.isContainer && k.title === title)
    if (!next) return null
    id = next.id
  }
  return browseChildren(entry, id)
}

// ----------------------------------------------------------------- Search

const SEARCH_MAX = 500

async function searchScope(
  entry: ServerEntry,
  criteria: string
): Promise<{ items: MediaNode[]; total: number } | null> {
  return searchPageRaw(entry, criteria, 0, SEARCH_MAX)
}

async function searchPageRaw(
  entry: ServerEntry,
  criteria: string,
  start: number,
  count: number
): Promise<{ items: MediaNode[]; total: number } | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:Search xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <ContainerID>0</ContainerID>
      <SearchCriteria>${xmlEscape(criteria)}</SearchCriteria>
      <Filter>*</Filter>
      <StartingIndex>${start}</StartingIndex>
      <RequestedCount>${count}</RequestedCount>
      <SortCriteria></SortCriteria>
    </u:Search>
  </s:Body>
</s:Envelope>`
  try {
    const res = await loggedFetch('upnp', entry.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Search"'
      },
      body,
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) return null
    const doc = parser.parse(await res.text()) as {
      Envelope?: {
        Body?: { SearchResponse?: { Result?: unknown; TotalMatches?: number } }
      }
    }
    const sr = doc.Envelope?.Body?.SearchResponse
    const didl = text(sr?.Result)
    if (didl == null) return null
    return { items: didlToNodes(didl), total: Number(sr?.TotalMatches ?? 0) }
  } catch {
    return null
  }
}

/**
 * Whole-library search. Probed grammar reality (Asset): criteria MUST be
 * scoped with `upnp:class derivedfrom …` to return anything, OR works
 * WITHIN a scope but not across scoped groups — so run one search per
 * entity kind (albums, artists, tracks) and merge, deduped by id. Field
 * clauses only reference properties the server DECLARES searchable
 * (SearchCaps "*" = all; a CSV limits us — e.g. a title-only server still
 * gets title search instead of silent zero-result queries).
 */
export async function search(
  host: string,
  serverUdn: string,
  query: string
): Promise<{ items: MediaNode[]; total: number }> {
  const entry = await entryFor(host, serverUdn)
  const phrase = query.replace(/["\\]/g, '') // criteria-grammar safe

  const caps = entry.searchCaps
  const has = (prop: string): boolean => caps === '*' || caps.split(',').some((c) => c.trim() === prop)
  const orClause = (props: string[]): string | null => {
    const usable = props.filter(has)
    if (usable.length === 0) return null
    const inner = usable.map((p) => `${p} contains "${phrase}"`).join(' or ')
    return usable.length > 1 ? `(${inner})` : inner
  }

  const scopes = [
    {
      cls: 'object.container.album',
      leaf: 'object.container.album.musicAlbum',
      fields: orClause(['dc:title', 'upnp:artist'])
    },
    {
      cls: 'object.container.person',
      leaf: 'object.container.person.musicArtist',
      fields: orClause(['dc:title'])
    },
    { cls: 'object.item.audioItem', leaf: null, fields: orClause(['dc:title', 'upnp:artist', 'upnp:album']) }
  ].filter((s): s is { cls: string; leaf: string | null; fields: string } => s.fields != null)
  if (scopes.length === 0) throw new Error('server declares no searchable text properties')

  const results = []
  for (const s of scopes) {
    const r = await searchScope(entry, `upnp:class derivedfrom "${s.cls}" and ${s.fields}`)
    // Asset generalizes classes in Search results to the scoped base class
    // (an album browses as …album.musicAlbum but searches as bare
    // object.container.album) — normalize to the specific leaf so the
    // vividness/chips/album-header rules behave exactly like browsing.
    if (r && s.leaf != null) {
      const leaf = s.leaf
      const tail = leaf.split('.').pop() as string
      r.items = r.items.map((n) =>
        n.isContainer && !n.upnpClass.includes(tail) ? { ...n, upnpClass: leaf } : n
      )
    }
    results.push(r)
  }
  if (results.every((r) => r == null)) throw new Error('search failed')

  const seen = new Set<string>()
  const items: MediaNode[] = []
  let total = 0
  for (const r of results) {
    if (!r) continue
    total += r.total
    for (const node of r.items) {
      if (seen.has(node.id)) continue
      seen.add(node.id)
      if (items.length < SEARCH_MAX) items.push(node)
    }
  }
  return { items, total }
}

// ------------------------------------------------------ index-crawler primitives

/** One raw-criteria Search page — the index crawler's fast path. */
export async function searchPage(
  host: string,
  serverUdn: string,
  criteria: string,
  start: number,
  count: number
): Promise<{ items: MediaNode[]; total: number } | null> {
  const entry = await entryFor(host, serverUdn)
  return searchPageRaw(entry, criteria, start, count)
}

/** Direct children of one container (paged internally) — the browse-crawl path. */
export async function browseChildrenOf(
  host: string,
  serverUdn: string,
  objectId: string
): Promise<MediaNode[] | null> {
  const entry = await entryFor(host, serverUdn)
  return browseChildren(entry, objectId)
}

/**
 * The server's SystemUpdateID — a MANDATORY ContentDirectory action, so even
 * search-less servers answer it. Bumps whenever the library changes; the one
 * cheap question that keeps the media index honest.
 */
export async function getSystemUpdateID(host: string, serverUdn: string): Promise<number | null> {
  try {
    const entry = await entryFor(host, serverUdn)
    const res = await loggedFetch('upnp', entry.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#GetSystemUpdateID"'
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><u:GetSystemUpdateID xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"></u:GetSystemUpdateID></s:Body>
</s:Envelope>`,
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return null
    const doc = parser.parse(await res.text()) as {
      Envelope?: { Body?: { GetSystemUpdateIDResponse?: { Id?: unknown } } }
    }
    const id = text(doc.Envelope?.Body?.GetSystemUpdateIDResponse?.Id)
    return id == null ? null : Number(id)
  } catch {
    return null
  }
}

// --------------------------------------------------------- queue/preset writes

async function metadataDidl(entry: ServerEntry, objectId: string): Promise<string> {
  const r = await soapBrowse(entry, objectId, 'BrowseMetadata', 0, 200)
  if (!r) throw new Error('could not fetch item metadata')
  return r.didl
}

export async function queueAdd(
  host: string,
  serverUdn: string,
  objectId: string,
  action: MediaQueueAction,
  playFromId?: string
): Promise<void> {
  const entry = await entryFor(host, serverUdn)
  const didl = await metadataDidl(entry, objectId)
  const udn = serverUdn.replace(/^uuid:/, '')
  // The endpoint is encoding-sensitive: EVERY special character in the DIDL
  // must be percent-encoded (vibin's hard-won quote(didl, safe="") lesson).
  let url =
    `http://${host}/smoip/queue/add?action=${action}` +
    `&didl=${encodeURIComponent(didl)}&server_udn=${encodeURIComponent(udn)}`
  if (action === 'PLAY_FROM_HERE' && playFromId) {
    url += `&play_from_id=${encodeURIComponent(playFromId)}`
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`queue/add -> HTTP ${res.status}`)
}

export async function presetSave(
  host: string,
  serverUdn: string,
  objectId: string,
  slot: number
): Promise<void> {
  if (slot < 1 || slot > 99) throw new Error(`preset slot must be 1-99, got ${slot}`)
  const entry = await entryFor(host, serverUdn)
  const didl = await metadataDidl(entry, objectId)
  const res = await fetch(`http://${host}/smoip/queue/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'PRESET',
      preset: slot,
      server_udn: serverUdn.replace(/^uuid:/, ''),
      type: 'didl',
      didl
    }),
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) throw new Error(`queue/add PRESET -> HTTP ${res.status}`)
}
