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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getSettings } from './persist'
import type { MediaIndexStatus, MediaNode, MediaSearchAllGroup, MediaServerInfo } from '@shared/ipc'
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
  albums: MediaNode[]
  artists: MediaNode[]
  tracks: MediaNode[]
}

// v2: nodes carry upnp:genre (multi-valued) — bumped 2026-07-21 for the
// library lenses. A bump discards stored indexes wholesale; rebuildHints
// below keeps that from costing Browse-only servers their Build click.
const VERSION = 2
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
    mkdirSync(join(app.getPath('userData'), 'cache'), { recursive: true })
    writeFileSync(file(), JSON.stringify({ version: VERSION, servers: [...indexes.values()] }))
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
      updateId: idx.updateId
    })
  }
  for (const server of known.values()) {
    if (indexes.has(server.udn) || building.has(server.udn)) continue
    out.push({
      udn: server.udn,
      serverName: server.name,
      state: 'none',
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

// Asset generalizes classes in Search results (an album browses as
// …album.musicAlbum but searches as bare object.container.album) — normalize
// so index rows behave exactly like browsed ones in the renderer.
const normalize = (n: MediaNode, leaf: string): MediaNode =>
  n.isContainer && !n.upnpClass.includes(leaf.split('.').pop() as string)
    ? { ...n, upnpClass: leaf }
    : n

async function crawlSearch(host: string, server: MediaServerInfo): Promise<StoredIndex | null> {
  const collect = async (cls: string, leaf: string | null, cap: number): Promise<MediaNode[] | null> => {
    const seen = new Map<string, MediaNode>()
    let start = 0
    for (;;) {
      const page = await searchPage(host, server.udn, `upnp:class derivedfrom "${cls}"`, start, PAGE)
      if (!page) return start === 0 ? null : [...seen.values()]
      for (const n of page.items) seen.set(n.id, leaf ? normalize(n, leaf) : n)
      start += page.items.length
      if (page.items.length === 0 || start >= page.total || seen.size >= cap) {
        if (seen.size >= cap) console.log(`[mediaIndex] ${server.name}: ${cls} capped at ${cap}`)
        return [...seen.values()]
      }
    }
  }
  const albums = await collect('object.container.album', 'object.container.album.musicAlbum', MAX_CONTAINERS)
  const artists = await collect('object.container.person', 'object.container.person.musicArtist', MAX_CONTAINERS)
  const tracks = await collect('object.item.audioItem', null, MAX_TRACKS)
  if (tracks == null && albums == null) return null // server refused the crawl entirely
  const updateId = await getSystemUpdateID(host, server.udn)
  return {
    udn: server.udn,
    serverName: server.name,
    strategy: 'search',
    updateId,
    builtAt: Date.now(),
    albums: albums ?? [],
    artists: artists ?? [],
    tracks: tracks ?? []
  }
}

async function crawlBrowse(host: string, server: MediaServerInfo): Promise<StoredIndex | null> {
  const albums = new Map<string, MediaNode>()
  const artists = new Map<string, MediaNode>()
  const tracks = new Map<string, MediaNode>()
  const visited = new Set<string>()
  const queue: string[] = ['0']
  while (queue.length > 0 && visited.size < MAX_CONTAINERS && tracks.size < MAX_TRACKS) {
    const id = queue.shift() as string
    if (visited.has(id)) continue
    visited.add(id)
    const children = await browseChildrenOf(host, server.udn, id)
    if (!children) continue
    for (const n of children) {
      if (!n.isContainer) {
        if (n.upnpClass.includes('audioItem')) tracks.set(n.id, n)
        continue
      }
      if (n.upnpClass.includes('musicAlbum')) albums.set(n.id, n)
      else if (n.upnpClass.includes('person')) artists.set(n.id, n)
      // walk every container: album tracks live inside albums too
      queue.push(n.id)
    }
  }
  if (visited.size >= MAX_CONTAINERS || tracks.size >= MAX_TRACKS) {
    console.log(`[mediaIndex] ${server.name}: browse-crawl capped (${visited.size} containers)`)
  }
  if (tracks.size === 0 && albums.size === 0) return null
  const updateId = await getSystemUpdateID(host, server.udn)
  return {
    udn: server.udn,
    serverName: server.name,
    strategy: 'browse',
    updateId,
    builtAt: Date.now(),
    albums: [...albums.values()],
    artists: [...artists.values()],
    tracks: [...tracks.values()]
  }
}

async function build(host: string, server: MediaServerInfo, strategy: 'search' | 'browse'): Promise<void> {
  if (building.has(server.udn)) return
  building.add(server.udn)
  buildingNames.set(server.udn, server.name)
  announce(status())
  try {
    const built = strategy === 'search' ? await crawlSearch(host, server) : await crawlBrowse(host, server)
    if (built) {
      indexes.set(server.udn, built)
      rebuildHints.delete(server.udn)
      save()
    }
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
    const hay = `${n.title} ${n.artist ?? ''} ${n.album ?? ''}`.toLowerCase()
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
