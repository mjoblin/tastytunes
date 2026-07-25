import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import {
  MAX_PLAYLISTS,
  MAX_PLAYLIST_ITEMS,
  type Playlist,
  type PlaylistItem
} from '@shared/ipc'

// Stored playlists, persisted beside settings.json and favorites.json — the
// same bounded-local-file pattern, no database. Newest-UPDATED first, because
// the thing you just edited is the thing you're most likely to want next.
//
// Entries key on CONTENT, not media ids (see PlaylistItem): a server re-index
// changes every objectId, and a playlist that can't survive that isn't worth
// storing. Ids ride along as a fast path and are healed on activation.

let cached: Playlist[] | null = null

function playlistsPath(): string {
  return join(app.getPath('userData'), 'playlists.json')
}

function sortNewest(list: Playlist[]): Playlist[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getPlaylists(): Playlist[] {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(playlistsPath(), 'utf-8'))
    cached = Array.isArray(parsed) ? sortNewest(parsed as Playlist[]) : []
  } catch {
    cached = []
  }
  return cached
}

function save(list: Playlist[]): Playlist[] {
  const next = sortNewest(list).slice(0, MAX_PLAYLISTS)
  cached = next
  try {
    const path = playlistsPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(next))
  } catch (err) {
    console.error('failed to persist playlists', err)
  }
  return next
}

/** Trim to the item ceiling — applied on every write path, not just create. */
function boundItems(items: PlaylistItem[]): PlaylistItem[] {
  return items.slice(0, MAX_PLAYLIST_ITEMS)
}

export function createPlaylist(name: string, items: PlaylistItem[]): Playlist[] {
  const now = Date.now()
  const playlist: Playlist = {
    id: randomUUID(),
    name: name.trim() || 'Untitled playlist',
    createdAt: now,
    updatedAt: now,
    items: boundItems(items)
  }
  return save([playlist, ...getPlaylists()])
}

/**
 * `touch` bumps updatedAt, which also re-sorts the list. USER edits touch;
 * system writes (id healing) must not — otherwise activating a playlist
 * silently reshuffles the user's collection.
 */
function patch(id: string, fn: (p: Playlist) => Playlist, touch = true): Playlist[] {
  return save(
    getPlaylists().map((p) => (p.id === id ? { ...fn(p), ...(touch ? { updatedAt: Date.now() } : {}) } : p))
  )
}

export function renamePlaylist(id: string, name: string): Playlist[] {
  return patch(id, (p) => ({ ...p, name: name.trim() || p.name }))
}

export function deletePlaylist(id: string): Playlist[] {
  return save(getPlaylists().filter((p) => p.id !== id))
}

/** Reorder and remove both land here — the renderer owns the resulting order. */
export function setPlaylistItems(id: string, items: PlaylistItem[]): Playlist[] {
  return patch(id, (p) => ({ ...p, items: boundItems(items) }))
}

/** Append. Duplicates are allowed: a playlist is an ordered list, not a set. */
export function appendToPlaylist(id: string, items: PlaylistItem[]): Playlist[] {
  return patch(id, (p) => ({ ...p, items: boundItems([...p.items, ...items]) }))
}

/**
 * Stamp an activation: when it ran and what it couldn't find. A SYSTEM write —
 * no updatedAt bump, so playing a playlist doesn't reshuffle a collection
 * sorted by recent edits.
 */
export function markPlaylistPlayed(id: string, missing: string[]): Playlist[] {
  return patch(id, (p) => ({ ...p, lastPlayedAt: Date.now(), lastMissing: missing }), false)
}

/**
 * Heal one entry's stale server/object id in place after a content re-resolve
 * — the favorites `updateFavorite` move, applied per playlist entry. Indexed
 * rather than keyed by content because a playlist may legitimately hold the
 * same track twice.
 */
export function healPlaylistItem(
  id: string,
  index: number,
  hint: Pick<PlaylistItem, 'serverUdn' | 'serverName' | 'objectId'>
): Playlist[] {
  return patch(
    id,
    (p) => ({ ...p, items: p.items.map((it, i) => (i === index ? { ...it, ...hint } : it)) }),
    false // system write — must not reorder the user's collection
  )
}
