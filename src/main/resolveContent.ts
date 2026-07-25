import { searchAllIndexes, searchServer as librarySearch } from './mediaIndex'
import { refreshServers } from './upnpBrowser'
import type { ContentRef, MediaNode } from '@shared/ipc'

/**
 * Finding a track that is known only by its CONTENT.
 *
 * Two callers need this and used to disagree: playlist activation (a stored
 * entry whose objectId has rotted) and queue undo (a removed row, which never
 * had an objectId at all — QueueListItem carries only id/position/metadata).
 *
 * INDEX FIRST, and that ordering is the point rather than a speed trick.
 * Activation's own version asked `refreshServers(host).filter(s => s.searchable)`,
 * which quietly excluded every Browse-only server — the user's USB drive — so a
 * stale entry living there could never heal, even though the media index knows
 * that content perfectly well. Asking the indexes first covers those servers,
 * costs no network, and leaves the live ContentDirectory search as the fallback
 * for anything not indexed yet.
 */
export interface ResolvedContent {
  serverUdn: string
  serverName: string
  objectId: string
}

const lc = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase()

/**
 * Title must match; artist must match only when BOTH sides claim one. That
 * asymmetry is deliberate and matches favoriteMatchesNode: a server that
 * reports no artist shouldn't veto a title we're confident about.
 */
function matches(ref: ContentRef, n: MediaNode): boolean {
  if (n.isContainer) return false
  if (lc(n.title) !== lc(ref.title)) return false
  if (ref.artist != null && n.artist != null && lc(n.artist) !== lc(ref.artist)) return false
  return true
}

/** Prefer a candidate from the same album — the tie-break for a title that a
 *  library holds several times (a single, an album cut, a compilation). */
function best(ref: ContentRef, items: MediaNode[]): MediaNode | null {
  const hits = items.filter((n) => matches(ref, n))
  if (hits.length === 0) return null
  if (ref.album == null) return hits[0]
  return hits.find((n) => n.album != null && lc(n.album) === lc(ref.album)) ?? hits[0]
}

export async function resolveContent(host: string, ref: ContentRef): Promise<ResolvedContent | null> {
  if (!ref.title.trim()) return null

  // 1. Every ready index at once — including the Browse-only servers a live
  //    search can't reach (their ContentDirectory Search 500s).
  for (const group of searchAllIndexes(ref.title)) {
    const hit = best(ref, group.items)
    if (hit) return { serverUdn: group.udn, serverName: group.serverName, objectId: hit.id }
  }

  // 2. Live search for anything not indexed yet. searchServer is itself
  //    index-first, so an indexed server reached here simply answers again.
  let servers
  try {
    servers = (await refreshServers(host)).filter((s) => s.searchable)
  } catch {
    return null
  }
  for (const server of servers) {
    try {
      const { items } = await librarySearch(host, server.udn, ref.title)
      const hit = best(ref, items)
      if (hit) return { serverUdn: server.udn, serverName: server.name, objectId: hit.id }
    } catch {
      continue // a server that can't answer isn't a failure — try the next
    }
  }
  return null
}
