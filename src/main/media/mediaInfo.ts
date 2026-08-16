// Everything the library knows about a thing a LIST holds only a ref to —
// a queue row, a favorite, a playlist item, a recent, a search hit — for the
// Info modal. Three tiers, cheapest first, the same order resolveContent
// walks for playback:
//   1. the index by identity (server + object id, when the ref carries them)
//   2. the index by CONTENT (title, then artist when both sides claim one,
//      album as the tie-break — resolveContent's matching rule)
//   3. a live BrowseMetadata, when server + id are known but not indexed
// Null when nothing is found; the caller shows what the list knew.
import { albumTracksOf, trackInAlbumOf, type MediaInfoQuery, type MediaInfoTarget, type MediaNode } from '@shared/model'
import { pools } from './mediaIndex'
import { browseMetadataNode } from './upnpBrowser'

const lc = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase()

function contentMatch(q: MediaInfoQuery, n: MediaNode): boolean {
  if (lc(n.title) !== lc(q.title)) return false
  if (q.artist && n.artist && !trackInAlbumOf(n, q.artist) && lc(n.artist) !== lc(q.artist)) return false
  return true
}

export async function lookupMediaInfo(host: string | null, q: MediaInfoQuery): Promise<MediaInfoTarget | null> {
  const groups = pools()
  const withAlbum = (pool: (typeof groups)[number], node: MediaNode): MediaInfoTarget => ({
    node,
    tracks: node.isContainer ? albumTracksOf(node, pool) : undefined,
    serverName: pool.serverName
  })
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
  // 3. live, when we know exactly what to ask for
  if (host && q.serverUdn && q.objectId) {
    const node = await browseMetadataNode(host, q.serverUdn, q.objectId)
    if (node) return { node, serverName: null }
  }
  return null
}
