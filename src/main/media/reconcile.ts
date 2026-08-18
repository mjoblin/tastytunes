/**
 * POOL RULES — reconciliation over a whole crawl result, PURE (no Electron,
 * no network; the corpus test imports this beside didl.ts).
 *
 * didl.ts reads one node the way the spec says and applies the rules a single
 * node can answer for itself. What a node cannot know — whether the server
 * distinguishes leaf classes at all, whether an album container is one of
 * five copies, what year an undated album is, whether "albums" exist anywhere
 * — is decided here, over the pool, by the SHAPE of the result set. Every
 * rule is a NO-OP on a spec-clean server, names the server that taught it
 * (dev/upnp-survey/REPORT.md), and reports what it did into the server's
 * MediaServerProfile so the app can say why (Info › Source, MCP
 * list_media_servers) instead of leaving the user to guess.
 *
 * Nothing in here keys on a vendor string. When a new server misbehaves,
 * capture its DIDL (dev/upnp-survey/capture-corpus.mjs), see which shape is
 * new, and add a rule — not a branch.
 */
import type { MediaNode, MediaServerProfile } from '@shared/model'
import { trackInAlbumOf } from '@shared/model'

const lc = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()
const leafOf = (leaf: string): string => leaf.split('.').pop() as string

export interface Settled {
  kept: MediaNode[]
  /** 'leaf': the server distinguishes the leaf class — bare/foreign results were dropped;
   *  'generalized': every result was the bare base class — all promoted (Asset);
   *  'unhonoured': nothing derived from the asked class came back at all (Emby/UMS: folders). */
  mode: 'leaf' | 'generalized' | 'unhonoured' | 'empty'
  dropped: number
}

/**
 * POOL RULE class-settling (minidlna 2026-08-16; Emby/UMS/Jellyfin 2026-08-17).
 * A class search asks for `base` (object.container.album) and wants `leaf`
 * (…album.musicAlbum). Servers answer four ways:
 *   - Asset: EVERY result is the bare base class (it generalizes in Search) →
 *     promote them all;
 *   - minidlna: real albums are the leaf class, only its virtual
 *     "- All Albums -" is bare → keep the leaf, drop the bare;
 *   - Emby / UMS: what comes back is not album-derived at all
 *     (storageFolder) → nothing here is an album;
 *   - Jellyfin: everything in the library, whatever the class → keep the
 *     leaf, drop the rest.
 * Structural, not vendor-sniffed: results not derived from `base` are never
 * albums (a storageFolder, a track); among the derived, a server that
 * distinguishes the leaf means it.
 */
export function settleClasses(nodes: MediaNode[], base: string, leaf: string): Settled {
  const derived = nodes.filter((n) => n.isContainer && n.upnpClass.startsWith(base))
  if (derived.length === 0) return { kept: [], mode: nodes.length > 0 ? 'unhonoured' : 'empty', dropped: nodes.length }
  const isLeaf = (n: MediaNode): boolean => n.upnpClass.includes(leafOf(leaf))
  if (derived.some(isLeaf)) {
    const kept = derived.filter(isLeaf)
    return { kept, mode: 'leaf', dropped: nodes.length - kept.length }
  }
  return { kept: derived.map((n) => ({ ...n, upnpClass: leaf })), mode: 'generalized', dropped: nodes.length - derived.length }
}

/** POOL RULE audio-items-only (Jellyfin 2026-08-17): a track search that returns containers too keeps only audio ITEMS. */
export function audioItemsOnly(nodes: MediaNode[]): { kept: MediaNode[]; dropped: number } {
  const kept = nodes.filter((n) => !n.isContainer && n.upnpClass.includes('audioItem'))
  return { kept, dropped: nodes.length - kept.length }
}

/**
 * POOL RULE year-from-tracks (minidlna 2026-08-16): an album container with
 * no dc:date takes the year its tracks agree on (the most common one).
 */
export function yearFromTracks(albums: MediaNode[], tracks: MediaNode[]): { albums: MediaNode[]; filled: number } {
  const byAlbum = new Map<string, Map<string, number>>()
  for (const t of tracks) {
    if (!t.album || !t.year) continue
    const key = lc(t.album)
    const m = byAlbum.get(key) ?? new Map<string, number>()
    m.set(t.year, (m.get(t.year) ?? 0) + 1)
    byAlbum.set(key, m)
  }
  let filled = 0
  const out = albums.map((a) => {
    if (a.year) return a
    const m = byAlbum.get(lc(a.title))
    if (!m) return a
    filled++
    const [year] = [...m.entries()].sort((x, y) => y[1] - x[1])[0]
    return { ...a, year }
  })
  return { albums: out, filled }
}

/**
 * POOL RULE duplicate-containers (Gerbera 2026-08-17): the same album arrives
 * as several containers — one under Albums, one under Artists/<each performer
 * on it>, … — same title and year; the copies under performer branches are
 * even CREDITED to that performer (a 19-artist compilation became 19 albums,
 * one per singer). Real TWIN EDITIONS (Asset: a 16-bit rip and a 24-bit
 * download of one album) look alike at the container level, but then the
 * pool holds the tracks TWICE — the same title and duration under two ids.
 * So, per (title, year): when the pool's tracks for that title carry no
 * duplicated content there is ONE album here — keep one container (the one
 * with art, then first seen), credited to the album artist the tracks
 * agree on, else to the single artist the copies share, else — three or
 * more different performers each claiming it — to Various Artists.
 * Editions (duplicated content) and same-titled albums by two different
 * artists (each container's tracks are its own) survive untouched.
 */
export function dedupeAlbums(albums: MediaNode[], tracks: MediaNode[]): { albums: MediaNode[]; collapsed: number } {
  const groups = new Map<string, MediaNode[]>()
  for (const a of albums) {
    const k = `${lc(a.title)}|${a.year ?? ''}`
    groups.set(k, [...(groups.get(k) ?? []), a])
  }
  const out: MediaNode[] = []
  let collapsed = 0
  for (const group of groups.values()) {
    if (group.length === 1) { out.push(group[0]); continue }
    const title = lc(group[0].title)
    const own = tracks.filter((t) => lc(t.album) === title)
    const content = new Set<string>()
    let duplicatedContent = false
    for (const t of own) {
      const key = `${lc(t.title)}|${t.durationSecs ?? ''}`
      if (content.has(key)) { duplicatedContent = true; break }
      content.add(key)
    }
    if (duplicatedContent) { out.push(...group); continue } // editions: the pool really holds N albums' worth
    // Mirrors are SCATTERED — one copy under Albums, one under each
    // performer's branch, all with different parents. Real same-titled
    // albums are SIBLINGS: Asset lists a boxed set's two disc containers (both
    // titled the album) and a second edition side by side under one parent.
    // Any two copies sharing a parent means these are distinct albums; and
    // with no tracks in the pool there is no content evidence — leave the
    // group alone in both cases.
    const parents = group.map((a) => a.parentId ?? '')
    const siblings = new Set(parents).size < parents.length
    if (own.length === 0 || siblings) { out.push(...group); continue }
    const artistsOfCopies = new Set(group.map((a) => lc(a.artist)).filter(Boolean))
    // two different artists with a same-titled album whose tracks are each their own: not copies
    if (artistsOfCopies.size === 2 && own.length > 0 && group.every((a) => own.some((t) => trackInAlbumOf(t, a.artist ?? null) && !group.some((b) => b !== a && trackInAlbumOf(t, b.artist ?? null))))) {
      out.push(...group)
      continue
    }
    const albumArtists = new Set(own.map((t) => lc(t.albumArtist)).filter(Boolean))
    const credit =
      albumArtists.size === 1 ? (own.find((t) => t.albumArtist)?.albumArtist ?? null)
      : artistsOfCopies.size === 1 ? group[0].artist
      : artistsOfCopies.size >= 3 ? 'Various Artists'
      : group[0].artist
    const keep = group.find((a) => a.artUrl) ?? group[0]
    out.push(credit && credit !== keep.artist ? { ...keep, artist: credit, artists: [credit], ...(albumArtists.size === 1 ? { albumArtist: credit } : {}) } : keep)
    collapsed += group.length - 1
  }
  return { albums: out, collapsed }
}

/** How much a node knows — for choosing between two copies of the same object id. */
const richness = (n: MediaNode): number =>
  [n.artist, n.album, n.year, n.artUrl, n.albumArtist, n.trackNumber, n.durationSecs, n.format, n.genre?.length ? 1 : null].filter((v) => v != null).length

/**
 * POOL RULE richer-copy (Plex 2026-08-17): a browse crawl meets the same
 * object id in several branches, and the copies differ — Plex's "By Album"
 * branch titles the album "Artist - Album (Year)" and credits it to the
 * BRANCH ("By Album", "2000"); its Artists branch has the real fields; a
 * track seen via one branch has no dc:date. Keep the copy that knows more;
 * a container whose artist is its parent container's title knows nothing.
 */
export function richer(a: MediaNode, b: MediaNode): MediaNode {
  return richness(b) > richness(a) ? b : a
}

/**
 * POOL RULE parent-as-artist (Plex 2026-08-17): an album container credited
 * to the title of the container it was listed in ("By Album", "2000",
 * "By Genre") is not credited at all.
 */
export function stripParentArtist(n: MediaNode, parentTitle: string | null): MediaNode {
  if (!n.isContainer || !n.artist) return n
  // the parent's title, or a bare year/decade ("2000", "2000s" — Plex's By
  // Decade branch credits albums to the decade): neither is an artist
  const isParent = parentTitle != null && lc(n.artist) === lc(parentTitle)
  const isDate = /^\d{4}s?$/.test(n.artist.trim())
  if (!isParent && !isDate) return n
  const { artists: _artists, ...rest } = n
  void _artists
  return { ...rest, artist: null }
}

/**
 * POOL RULE canonical-branch (Plex 2026-08-17): when a browse crawl meets the
 * same album id under several containers, the copy listed under an ARTIST
 * container (object.container.person…) is the canonical one — an album's
 * home is its artist; the copies under By Album / By Decade / Recently Added
 * are listings, and Plex decorates those. Preferred over mere richness.
 */
export interface Seen { node: MediaNode; underArtist: boolean }
export function preferCopy(prev: Seen | undefined, next: Seen): Seen {
  if (!prev) return next
  if (prev.underArtist !== next.underArtist) return prev.underArtist ? prev : next
  return richer(prev.node, next.node) === prev.node ? prev : next
}

/**
 * POOL RULE albums-from-tracks (UMS 2026-08-17; any folder-only server, and
 * quite possibly the streamer's own USB storage): a server that exposes NO
 * album containers — its "albums" are storageFolders — still tells us the
 * album on every track. Build the album from the tracks: one per
 * (album title, album artist ?? the performers' common artist), id = the
 * container the tracks were listed in (so the album leaf can browse it),
 * art / year / genre from the tracks. The synthesised container is marked so
 * the profile can say so.
 */
export function albumsFromTracks(tracks: MediaNode[]): MediaNode[] {
  // an album is a folder of tracks sharing an album tag: key on (container,
  // title) so two same-titled albums in different folders stay apart
  const groups = new Map<string, MediaNode[]>()
  for (const t of tracks) {
    if (!t.album) continue
    const key = `${t.parentId ?? ''}|${lc(t.album)}`
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  const out: MediaNode[] = []
  for (const group of groups.values()) {
    const first = group[0]
    // the album's artist: the AlbumArtist role when every track agrees on
    // one, else the one performer they all share, else Various Artists
    const albumArtists = new Set(group.map((t) => lc(t.albumArtist)).filter(Boolean))
    const performerSets = group.map((t) => new Set((t.artists ?? (t.artist ? [t.artist] : [])).map(lc)))
    const shared = [...(performerSets[0] ?? [])].filter((p) => performerSets.every((s) => s.has(p)))
    const artist =
      (albumArtists.size === 1 ? group.find((t) => t.albumArtist)?.albumArtist : null) ??
      (shared.length > 0
        ? (group.flatMap((t) => t.artists ?? (t.artist ? [t.artist] : [])).find((n) => lc(n) === shared[0]) ?? null)
        : 'Various Artists')
    // the container the tracks live in: the most common parentId
    const parents = new Map<string, number>()
    for (const t of group) if (t.parentId) parents.set(t.parentId, (parents.get(t.parentId) ?? 0) + 1)
    const parentId = [...parents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    if (!parentId) continue
    const years = new Map<string, number>()
    for (const t of group) if (t.year) years.set(t.year, (years.get(t.year) ?? 0) + 1)
    const year = [...years.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const genre = [...new Set(group.flatMap((t) => t.genre ?? []))]
    out.push({
      id: parentId,
      parentId: null,
      title: first.album as string,
      upnpClass: 'object.container.album.musicAlbum',
      isContainer: true,
      artUrl: group.find((t) => t.artUrl)?.artUrl ?? null,
      artist,
      album: null,
      year,
      trackNumber: null,
      durationSecs: null,
      ...(genre.length > 0 ? { genre } : {}),
      ...(albumArtists.size === 1 && first.albumArtist ? { albumArtist: first.albumArtist } : {})
    })
  }
  return out
}

/** A fresh, honest profile — the crawl fills it in as it learns. */
export function emptyProfile(strategy: MediaServerProfile['strategy']): MediaServerProfile {
  return { strategy, albumsFrom: strategy === 'search' ? 'search' : 'browse', classSearch: strategy === 'search' ? 'leaf' : 'unavailable', notes: [] }
}
