// The local media index: a REBUILDABLE CACHE of each server's music metadata
// so search answers instantly (and, later, so the app can offer its own
// browse views instead of the server's folder hierarchy). Never a database —
// it holds nothing that can't be regenerated in seconds, is invalidated
// wholesale when the server's SystemUpdateID moves (with a TTL backstop for
// servers whose counter lies), and playback still goes through the normal
// verbatim-DIDL queue path with the same stale-id healing as ever.
//
// Capability-tiered per server, like everything else in this app:
//   Tier A (answers Search): paged class crawls — Asset-sized libraries take
//     seconds (~25 requests for 4.5k tracks, measured live).
//   Tier B (Browse-only, e.g. the streamer's USB server): a container walk,
//     built only when the user asks (slow on real hardware; ids also rot on
//     replug, which bumps SystemUpdateID and invalidates anyway).
//   Tier C (pathological): no index; the Library stays fully live.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getSettings } from '../data/persist'
import { atomicWriteFileSync } from '../data/jsonStore'
import type { MediaIndexPools, MediaIndexStatus, MediaNode, MediaSearchAllGroup, MediaServerInfo, MediaServerProfile } from '@shared/model'
import { albumsFromTracks, audioItemsOnly, dedupeAlbums, emptyProfile, preferCopy, richer, settleClasses, stripParentArtist, yearFromTracks, type Seen } from './reconcile'
import {
  browseChildrenOf,
  getSystemUpdateID,
  search as liveSearch,
  searchPage
} from './upnpBrowser'

interface StoredIndex {
  udn: string
  serverName: string
  strategy: 'search' | 'browse'
  updateId: number | null
  builtAt: number
  profile?: MediaServerProfile
  albums: MediaNode[]
  artists: MediaNode[]
  tracks: MediaNode[]
}

// v10: the survey round (2026-08-17): parser split into didl.ts (node rules:
//      dates, container-artist, title decoration, bitrate by size÷duration,
//      " / " and upnp:composer) + reconcile.ts (pool rules: class settling by
//      derivation, audio items only, dedupe copies, albums from tracks,
//      richer copy) + browse/tracks fallbacks + MediaServerProfile.
// v9: minidlna round (2026-08-16): role-less artist/creator split read as
//     albumArtist/performers; bare search classes settled structurally (the
//     "- All Albums -" virtual container no longer an album); album year
//     from its tracks when the container has none.
// v8: composers (upnp:artist role="Composer", split) — 2026-08-16.
// v7: format parse revised (m4a ALAC-vs-AAC by file bitrate, lossy kbps from
//     size ÷ duration) — the SAME parser change without a bump left the lens
//     (index) and the album leaf (live) disagreeing on one album (2026-08-16).
// v6: format (codec/bits/rate/kbps/size from the primary <res>) — 2026-08-16.
// v5: discNumber/discCount (upnp:originalDiscNumber/Count) — multi-disc
// order and within-disc positions (2026-08-15, same day as v4).
// v4: albumArtist (upnp:artist role="AlbumArtist") and the split performer
// list `artists` — featured tracks belong to their album again (2026-08-15).
// v3: genre values split on ';' ("Pop; Rock" = two genres — live-observed
// Asset tagging). v2 added upnp:genre. A bump discards stored indexes
// wholesale; rebuildHints below keeps that from costing Browse-only
// servers their Build click.
const VERSION = 10
const PAGE = 500
const MAX_TRACKS = 50_000
const MAX_CONTAINERS = 10_000
const TTL_MS = 7 * 24 * 3600 * 1000 // recrawl backstop for servers whose counter never moves
const SEARCH_RESULT_CAP = 500

const indexes = new Map<string, StoredIndex>()
// Strategies salvaged from a stale-VERSION index file: the data is discarded,
// but remembering HOW each server was crawled lets ensureFresh rebuild
// Browse-only (manual-first-build) servers automatically after a schema bump
// instead of demanding a fresh Build click.
const rebuildHints = new Map<string, 'search' | 'browse'>()
// Every server the streamer has listed this session — so Settings can show
// un-indexed ones too (a USB stick deserves its Build button).
const known = new Map<string, MediaServerInfo>()
const building = new Set<string>()
// The last build that produced NOTHING, per server, with a one-line reason —
// so the Library's doors and Settings can say "couldn't index · Retry" instead
// of quietly reverting to "not indexed" (2026-08-17). Cleared by any build.
const failed = new Map<string, string>()
let announce: (statuses: MediaIndexStatus[]) => void = () => {}
let loaded = false

const file = (): string => join(app.getPath('userData'), 'cache', 'media-index.json')

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as {
      version?: number
      servers?: StoredIndex[]
    }
    if (raw.version === VERSION && Array.isArray(raw.servers)) {
      for (const idx of raw.servers) indexes.set(idx.udn, idx)
    } else if (Array.isArray(raw.servers)) {
      for (const idx of raw.servers) {
        if (idx?.udn && (idx.strategy === 'search' || idx.strategy === 'browse')) {
          rebuildHints.set(idx.udn, idx.strategy)
        }
      }
    }
  } catch {
    // no index yet — built on first listing
  }
}

function save(): void {
  try {
    // atomic like the user-data stores — a torn index only costs a rebuild,
    // but a rebuild of a big Asset library is minutes, not milliseconds
    atomicWriteFileSync(file(), JSON.stringify({ version: VERSION, servers: [...indexes.values()] }))
  } catch {
    // disk trouble only costs a rebuild next launch
  }
}

export function init(onChange: (statuses: MediaIndexStatus[]) => void): void {
  announce = onChange
  load()
  announce(status())
}

export function status(): MediaIndexStatus[] {
  load()
  const out: MediaIndexStatus[] = []
  for (const idx of indexes.values()) {
    out.push({
      udn: idx.udn,
      serverName: idx.serverName,
      state: building.has(idx.udn) ? 'building' : 'ready',
      strategy: idx.strategy,
      tracks: idx.tracks.length,
      albums: idx.albums.length,
      artists: idx.artists.length,
      builtAt: idx.builtAt,
      updateId: idx.updateId,
      ...(idx.profile ? { profile: idx.profile } : {})
    })
  }
  for (const server of known.values()) {
    if (indexes.has(server.udn) || building.has(server.udn)) continue
    const why = failed.get(server.udn)
    out.push({
      udn: server.udn,
      serverName: server.name,
      state: why ? 'failed' : 'none',
      ...(why ? { failure: why } : {}),
      strategy: null,
      tracks: 0,
      albums: 0,
      artists: 0,
      builtAt: null,
      updateId: null
    })
  }
  for (const udn of building) {
    if (!indexes.has(udn)) {
      out.push({
        udn,
        serverName: buildingNames.get(udn) ?? udn,
        state: 'building',
        strategy: null,
        tracks: 0,
        albums: 0,
        artists: 0,
        builtAt: null,
        updateId: null
      })
    }
  }
  return out
}
const buildingNames = new Map<string, string>()

// ---------------------------------------------------------------- the crawl
//
// Strategy is chosen from what the server just did, never from its brand, and
// each choice is written into the server's MediaServerProfile (the Info
// modal's Source section and MCP list_media_servers read it):
//   search  → paged class searches; results settled by SHAPE (reconcile.ts:
//             leaf / generalized / unhonoured); a faulting page retries at a
//             smaller size before the crawl gives up on that class
//   ↓ no albums from Search but tracks came back (Emby: class ignored)
//   browse  → walk the container tree for albums/artists (dedupe by id,
//             keep the richer copy)
//   ↓ still no album containers anywhere (UMS: folders only)
//   tracks  → synthesise albums from the tracks (id = their container)
// The pool rules run last, in order: dedupe copies (Gerbera), fill years from
// tracks (minidlna), and every step that changed something leaves a note.
// Profile notes are USER-FACING (Info › Source, MCP): plain words, no UPnP
// vocabulary, and a note only when something needed handling — a healthy
// server reads "Indexed: by search" and nothing else.
const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
const ALBUM_BASE = 'object.container.album'
const ALBUM_LEAF = 'object.container.album.musicAlbum'
const ARTIST_BASE = 'object.container.person'
const ARTIST_LEAF = 'object.container.person.musicArtist'
const TRACK_BASE = 'object.item.audioItem'

interface Crawled { albums: MediaNode[]; artists: MediaNode[]; tracks: MediaNode[]; profile: MediaServerProfile; parentsOf?: Map<string, Set<string>> }

async function collectClass(host: string, server: MediaServerInfo, cls: string, cap: number, note: (s: string) => void): Promise<MediaNode[] | null> {
  const seen = new Map<string, MediaNode>()
  let start = 0
  let pageSize = PAGE
  for (;;) {
    const page = await searchPage(host, server.udn, `upnp:class derivedfrom "${cls}"`, start, pageSize)
    if (!page) {
      // a page that faults (Jellyfin mid-scan: SOAP 500 on a 500-item page)
      // is retried once at a fifth of the size before this class is given up
      if (pageSize === PAGE) { pageSize = Math.max(50, Math.floor(PAGE / 5)); note(`the server's search failed on large pages — read in smaller pages instead`); continue }
      return start === 0 ? null : [...seen.values()]
    }
    for (const n of page.items) seen.set(n.id, n)
    start += page.items.length
    if (page.items.length === 0 || start >= page.total || seen.size >= cap) {
      if (seen.size >= cap) console.log(`[mediaIndex] ${server.name}: ${cls} capped at ${cap}`)
      return [...seen.values()]
    }
  }
}

async function crawlSearch(host: string, server: MediaServerInfo): Promise<Crawled | null> {
  const profile = emptyProfile('search')
  const note = (s: string): void => { profile.notes.push(s) }
  const rawAlbums = await collectClass(host, server, ALBUM_BASE, MAX_CONTAINERS, note)
  const rawArtists = await collectClass(host, server, ARTIST_BASE, MAX_CONTAINERS, note)
  const rawTracks = await collectClass(host, server, TRACK_BASE, MAX_TRACKS, note)
  if (rawTracks == null && rawAlbums == null) return null // server refused the crawl entirely
  const albumsSettled = settleClasses(rawAlbums ?? [], ALBUM_BASE, ALBUM_LEAF)
  const artistsSettled = settleClasses(rawArtists ?? [], ARTIST_BASE, ARTIST_LEAF)
  const tracksSettled = audioItemsOnly(rawTracks ?? [])
  profile.classSearch = albumsSettled.mode === 'empty' ? artistsSettled.mode === 'empty' ? 'leaf' : artistsSettled.mode : albumsSettled.mode
  // (a generalizing server — Asset — needs no note: promotion is how it is
  // meant to be read; 'unhonoured' is explained by the note the fallback
  // writes when it recovers the albums another way)
  if (albumsSettled.mode === 'leaf' && albumsSettled.dropped > 0) note(`${n(albumsSettled.dropped, 'entry', 'entries')} the server adds for navigation (such as “- All Albums -”) left out of the albums`)
  if (artistsSettled.mode === 'leaf' && artistsSettled.dropped > 0) note(`${n(artistsSettled.dropped, 'navigation entry', 'navigation entries')} left out of the artists`)
  if (tracksSettled.dropped > 0) note(`${n(tracksSettled.dropped, 'entry', 'entries')} that ${tracksSettled.dropped === 1 ? 'was' : 'were'} not a track left out of the tracks`)
  return { albums: albumsSettled.kept, artists: artistsSettled.kept, tracks: tracksSettled.kept, profile }
}

async function crawlBrowse(host: string, server: MediaServerInfo, into?: Crawled): Promise<Crawled | null> {
  const profile = into?.profile ?? emptyProfile('browse')
  const albums = new Map<string, Seen>()
  const artists = new Map<string, MediaNode>()
  const tracks = new Map<string, MediaNode>(into ? into.tracks.map((t) => [t.id, t]) : [])
  const visited = new Set<string>()
  const parents = new Map<string, { title: string; isArtist: boolean }>() // container id → what it is, for the parent-as-artist and canonical-branch rules
  const parentsOf = new Map<string, Set<string>>() // album id → every container it was listed under (dedupe's sibling evidence)
  const queue: string[] = ['0']
  const put = (m: Map<string, MediaNode>, n: MediaNode): void => { const prev = m.get(n.id); m.set(n.id, prev ? richer(prev, n) : n) }
  while (queue.length > 0 && visited.size < MAX_CONTAINERS && tracks.size < MAX_TRACKS) {
    const id = queue.shift() as string
    if (visited.has(id)) continue
    visited.add(id)
    const children = await browseChildrenOf(host, server.udn, id)
    if (!children) continue
    const parent = parents.get(id) ?? null
    for (const raw of children) {
      // an album under its ARTIST container is credited to that artist by
      // right; under any other container, a matching credit is the listing's
      const n = stripParentArtist(raw, parent && !parent.isArtist ? parent.title : null)
      if (!n.isContainer) {
        if (n.upnpClass.includes('audioItem') && !into) put(tracks, n)
        continue
      }
      parents.set(n.id, { title: n.title, isArtist: n.upnpClass.includes('person') })
      if (n.upnpClass.includes('musicAlbum')) {
        albums.set(n.id, preferCopy(albums.get(n.id), { node: n, underArtist: parent?.isArtist === true }))
        parentsOf.set(n.id, (parentsOf.get(n.id) ?? new Set()).add(id))
      }
      else if (n.upnpClass.includes('person')) put(artists, n)
      // walk every container: album tracks live inside albums too
      queue.push(n.id)
    }
  }
  if (visited.size >= MAX_CONTAINERS || tracks.size >= MAX_TRACKS) {
    console.log(`[mediaIndex] ${server.name}: browse-crawl capped (${visited.size} containers)`)
    profile.notes.push(`browsing stopped after ${visited.size} folders — a very large library may be only partly indexed`)
  }
  if (tracks.size === 0 && albums.size === 0) return null
  return {
    albums: [...albums.values()].map((s) => s.node),
    artists: [...(into && into.artists.length > 0 ? new Map(into.artists.map((a) => [a.id, a])) : artists).values()],
    tracks: [...tracks.values()],
    profile,
    parentsOf
  }
}

/** The pool rules, in order, over whatever the crawl produced. */
function reconcilePools(c: Crawled, serverName: string): Crawled {
  const note = (s: string): void => { c.profile.notes.push(s) }
  let albums = c.albums
  if (albums.length === 0 && c.tracks.length > 0) {
    albums = albumsFromTracks(c.tracks)
    c.profile.albumsFrom = 'tracks'
    note(`this server doesn't list albums — TastyTunes assembled them from its ${n(c.tracks.length, 'track', 'tracks')}`)
    console.log(`[mediaIndex] ${serverName}: ${albums.length} albums synthesised from tracks`)
  }
  const dd = dedupeAlbums(albums, c.tracks, c.parentsOf)
  if (dd.collapsed > 0) note(`${n(dd.collapsed, 'duplicate album entry', 'duplicate album entries')} merged — the server lists some albums more than once`)
  const yf = yearFromTracks(dd.albums, c.tracks)
  if (yf.filled > 0) note(yf.filled === 1 ? '1 album with no year took the year from its tracks' : `${yf.filled} albums with no year took the year from their tracks`)
  return { ...c, albums: yf.albums }
}

async function crawl(host: string, server: MediaServerInfo, strategy: 'search' | 'browse'): Promise<StoredIndex | null> {
  let c: Crawled | null = strategy === 'search' ? await crawlSearch(host, server) : await crawlBrowse(host, server)
  if (!c && strategy === 'search') {
    // Search refused outright — a searchable server that faults on every
    // page (Jellyfin mid-scan) is a browse-only server for today
    const b = await crawlBrowse(host, server)
    if (b) { b.profile.notes.push("the server's search failed — the library was indexed by browsing instead"); c = b }
  }
  if (!c) return null
  if (c.profile.strategy === 'search' && c.albums.length === 0 && c.tracks.length > 0) {
    // Emby: the class search returned no albums, its Browse tree has them
    const b = await crawlBrowse(host, server, c)
    if (b && b.albums.length > 0) {
      c = { ...c, albums: b.albums, artists: c.artists.length > 0 ? c.artists : b.artists, parentsOf: b.parentsOf }
      c.profile.albumsFrom = 'browse'
      c.profile.notes.push(`the server's album search returned nothing — ${n(b.albums.length, 'album was', 'albums were')} found by browsing instead`)
    }
  }
  const r = reconcilePools(c, server.name)
  const updateId = await getSystemUpdateID(host, server.udn)
  return {
    udn: server.udn,
    serverName: server.name,
    strategy: r.profile.strategy,
    updateId,
    builtAt: Date.now(),
    albums: r.albums,
    artists: r.artists,
    tracks: r.tracks,
    profile: r.profile
  }
}

async function build(host: string, server: MediaServerInfo, strategy: 'search' | 'browse'): Promise<void> {
  if (building.has(server.udn)) return
  building.add(server.udn)
  buildingNames.set(server.udn, server.name)
  announce(status())
  try {
    const built = await crawl(host, server, strategy)
    if (built) {
      indexes.set(server.udn, built)
      rebuildHints.delete(server.udn)
      failed.delete(server.udn)
      save()
    } else {
      failed.set(server.udn, strategy === 'search' ? "the server didn't respond to search or browsing" : 'the server returned an empty library')
      console.log(`[mediaIndex] ${server.name}: build produced no index (${failed.get(server.udn)})`)
    }
  } catch (e) {
    failed.set(server.udn, e instanceof Error ? e.message : String(e))
    console.log(`[mediaIndex] ${server.name}: build failed — ${failed.get(server.udn)}`)
  } finally {
    building.delete(server.udn)
    announce(status())
  }
}

/**
 * Called on every server listing (Library entry): keep Tier A indexes fresh
 * automatically — build when absent, rebuild when SystemUpdateID moved or the
 * TTL passed. Browse-built (Tier B) indexes only REVALIDATE here; their first
 * build is the user's call (a walk can be slow on real hardware).
 */
export function ensureFresh(host: string, servers: MediaServerInfo[]): void {
  load()
  let announceNeeded = false
  for (const server of servers) {
    if (!known.has(server.udn)) announceNeeded = true
    known.set(server.udn, server)
  }
  if (announceNeeded) announce(status())
  if (getSettings().mediaIndexAuto === false) return // user said: buttons only
  for (const server of servers) {
    const existing = indexes.get(server.udn)
    // Tier B: manual first build — unless a schema bump salvaged its
    // strategy, in which case the rebuild is on the house.
    if (!server.searchable && !existing && !rebuildHints.has(server.udn)) continue
    void (async () => {
      if (existing) {
        const id = await getSystemUpdateID(host, server.udn)
        const stale =
          (id != null && existing.updateId != null && id !== existing.updateId) ||
          Date.now() - existing.builtAt > TTL_MS
        if (!stale) return
        await build(host, server, existing.strategy)
        return
      }
      await build(host, server, server.searchable ? 'search' : (rebuildHints.get(server.udn) ?? 'browse'))
    })()
  }
}

/** The manual rebuild — and the only way to first-build a Browse-only server. */
export async function rebuild(host: string, server: MediaServerInfo): Promise<void> {
  load()
  await build(host, server, server.searchable ? 'search' : 'browse')
}

/** Fresh-index tokenized search; null = no usable index (caller goes live). */
export function searchIndex(udn: string, query: string): { items: MediaNode[]; total: number } | null {
  load()
  const idx = indexes.get(udn)
  if (!idx || building.has(udn)) return null
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { items: [], total: 0 }
  const matches = (n: MediaNode): boolean => {
    // composers are searchable ("bangalter" finds the track) without being artists
    const hay = `${n.title} ${n.artist ?? ''} ${n.album ?? ''} ${(n.composers ?? []).join(' ')}`.toLowerCase()
    return tokens.every((t) => hay.includes(t))
  }
  const items: MediaNode[] = []
  let total = 0
  // Hierarchy order — artists make albums, albums contain tracks — mirrored
  // by the result sections and the kind filter (user call, 2026-07-21).
  for (const pool of [idx.artists, idx.albums, idx.tracks]) {
    for (const n of pool) {
      if (!matches(n)) continue
      total++
      if (items.length < SEARCH_RESULT_CAP) items.push(n)
    }
  }
  return { items, total }
}

/**
 * Cross-server search: every READY index at once, grouped by server. Nodes
 * carry serverUdn/serverName stamps so mixed listings can act on them.
 * Index-only by design — live fallback stays per-server (no SOAP fan-out),
 * so a searchable-but-unindexed server simply isn't in these results.
 */
export function searchAllIndexes(query: string): MediaSearchAllGroup[] {
  load()
  const groups: MediaSearchAllGroup[] = []
  for (const idx of indexes.values()) {
    const res = searchIndex(idx.udn, query)
    if (!res || res.total === 0) continue
    groups.push({
      udn: idx.udn,
      serverName: idx.serverName,
      items: res.items.map((n) => ({ ...n, serverUdn: idx.udn, serverName: idx.serverName })),
      total: res.total
    })
  }
  return groups
}

/**
 * Full pools of every READY index, nodes stamped with their server — the
 * Artists/Albums lenses' feedstock. A snapshot copy: callers can't mutate
 * the index, and the renderer caches it keyed on builtAt signatures.
 */
export function pools(): MediaIndexPools[] {
  load()
  const out: MediaIndexPools[] = []
  for (const idx of indexes.values()) {
    if (building.has(idx.udn)) continue
    const stamp = (n: MediaNode): MediaNode => ({
      ...n,
      serverUdn: idx.udn,
      serverName: idx.serverName
    })
    out.push({
      udn: idx.udn,
      serverName: idx.serverName,
      albums: idx.albums.map(stamp),
      artists: idx.artists.map(stamp),
      tracks: idx.tracks.map(stamp),
      ...(idx.profile ? { profile: idx.profile } : {})
    })
  }
  return out
}

/** Index-first server search with the live ContentDirectory search as fallback. */
export async function searchServer(
  host: string,
  serverUdn: string,
  query: string
): Promise<{ items: MediaNode[]; total: number }> {
  const fromIndex = searchIndex(serverUdn, query)
  if (fromIndex) return fromIndex
  return liveSearch(host, serverUdn, query)
}
