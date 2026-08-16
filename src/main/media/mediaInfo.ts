// Everything the library knows about a thing a LIST holds only a ref to —
// a queue row, a favorite, a playlist item, a recent, a search hit — for the
// Info modal. Three tiers, cheapest first, the same order resolveContent
// walks for playback:
//   1. the index by identity (server + object id, when the ref carries them)
//   2. the index by CONTENT (title, then artist when both sides claim one,
//      album as the tie-break — resolveContent's matching rule)
//   3. a live BrowseMetadata, when server + id are known but not indexed
// Null when nothing is found; the caller shows what the list knew.
import { albumTracksOf, artistSummary, trackArtists, trackInAlbumOf, type MediaInfoQuery, type MediaInfoTarget, type MediaNode } from '@shared/model'
import { pools } from './mediaIndex'
import { browseMetadataNode } from './upnpBrowser'

const lc = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase()

function contentMatch(q: MediaInfoQuery, n: MediaNode): boolean {
  if (lc(n.title) !== lc(q.title)) return false
  if (q.artist && n.artist && !trackInAlbumOf(n, q.artist) && lc(n.artist) !== lc(q.artist)) return false
  return true
}

/** A page for a name the index only knows as a CREDIT (a guest singer, a composer) — no entity node exists, so one is made. */
function creditedArtistNode(name: string, pool: { udn: string; serverName: string; albums: ReadonlyArray<MediaNode>; tracks: ReadonlyArray<MediaNode> }): MediaNode | null {
  const key = name.trim().toLowerCase()
  const credited =
    pool.albums.some((a) => (a.artist ?? '').trim().toLowerCase() === key) ||
    pool.tracks.some((t) => trackArtists(t).some((x) => x.trim().toLowerCase() === key) || (t.composers ?? []).some((c) => c.trim().toLowerCase() === key))
  if (!credited) return null
  return {
    id: '',
    parentId: null,
    title: name.trim(),
    upnpClass: 'object.container.person.musicArtist',
    isContainer: true,
    artUrl: null,
    artist: null,
    album: null,
    year: null,
    trackNumber: null,
    durationSecs: null,
    serverUdn: pool.udn,
    serverName: pool.serverName
  }
}

export async function lookupMediaInfo(host: string | null, q: MediaInfoQuery): Promise<MediaInfoTarget | null> {
  const groups = pools()
  const withAlbum = (pool: (typeof groups)[number], node: MediaNode): MediaInfoTarget => {
    if (node.isContainer && /person|Artist/.test(node.upnpClass)) {
      const summary = artistSummary(node.title, pool)
      return { node: node.artUrl ? node : { ...node, artUrl: summary.artUrl }, artist: summary, serverName: pool.serverName }
    }
    return {
      node,
      tracks: node.isContainer ? albumTracksOf(node, pool) : undefined,
      serverName: pool.serverName
    }
  }
  // 1. identity
  if (q.serverUdn && q.objectId) {
    const pool = groups.find((p) => p.udn === q.serverUdn)
    if (pool) {
      const hit =
        (q.kind === 'track' ? pool.tracks : q.kind === 'album' ? pool.albums : pool.artists).find((n) => n.id === q.objectId) ??
        [...pool.tracks, ...pool.albums, ...pool.artists].find((n) => n.id === q.objectId)
      if (hit) return withAlbum(pool, hit)
    }
  }
  // 2. content, every ready index (the ref's own server first)
  const ordered = [...groups].sort((a, b) => (a.udn === q.serverUdn ? -1 : b.udn === q.serverUdn ? 1 : 0))
  for (const pool of ordered) {
    const candidates = (q.kind === 'track' ? pool.tracks : q.kind === 'album' ? pool.albums : pool.artists).filter((n) =>
      contentMatch(q, n)
    )
    if (candidates.length === 0) continue
    // prefer the same album (tracks) — a title recorded on several
    const best =
      (q.album && candidates.find((n) => lc(n.album) === lc(q.album))) ||
      candidates.find((n) => q.artist == null || lc(n.artist) === lc(q.artist)) ||
      candidates[0]
    return withAlbum(pool, best)
  }
  // 2b. an artist the index knows only as a credit (guest, composer, or the
  //     album artist of a server without person entities) still gets a page
  if (q.kind === 'artist') {
    for (const pool of ordered) {
      const node = creditedArtistNode(q.title, pool)
      if (node) return withAlbum(pool, node)
    }
  }
  // 3. live, when we know exactly what to ask for
  if (host && q.serverUdn && q.objectId) {
    const node = await browseMetadataNode(host, q.serverUdn, q.objectId)
    if (node) return { node, serverName: null }
  }
  return null
}
