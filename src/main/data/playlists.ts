import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app } from "electron";
import { jsonFileStore } from "./jsonStore";
import {
  MAX_PLAYLISTS,
  MAX_PLAYLIST_ITEMS,
  playlistItemKey,
  type Playlist,
  type PlaylistItem,
} from "@shared/model";

// Stored playlists, persisted beside settings.json and favorites.json — the
// same bounded-local-file pattern, no database. Newest-UPDATED first, because
// the thing you just edited is the thing you're most likely to want next.
//
// Entries key on CONTENT, not media ids (see PlaylistItem): a server re-index
// changes every objectId, and a playlist that can't survive that isn't worth
// storing. Ids ride along as a fast path and are healed on activation.

function sortNewest(list: Playlist[]): Playlist[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

const store = jsonFileStore<Playlist[]>({
  pathOf: () => join(app.getPath("userData"), "playlists.json"),
  scope: "playlists",
  load: (parsed) => (Array.isArray(parsed) ? sortNewest(parsed as Playlist[]) : []),
});

export function getPlaylists(): Playlist[] {
  return store.get();
}

function save(list: Playlist[]): Playlist[] {
  return store.set(sortNewest(list).slice(0, MAX_PLAYLISTS));
}

/** Trim to the item ceiling — applied on every write path, not just create. */
function boundItems(items: PlaylistItem[]): PlaylistItem[] {
  return items.slice(0, MAX_PLAYLIST_ITEMS);
}

/**
 * Make a name unique within the collection. Auto-names carry a timestamp, but
 * two saves inside the same minute still collide — and two rows reading
 * "Queue — Jul 24, 7:49 PM" are indistinguishable to the person who made them.
 */
function uniqueName(base: string, existing: Playlist[]): string {
  const taken = new Set(existing.map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/**
 * Returns the created playlist alongside the list: the stored name may have
 * been uniquified away from what the caller asked for, so anything reporting
 * the outcome (a toast, an MCP reply with the id) must read it back rather
 * than assume — finding it by the requested name would land on the OLD
 * playlist that forced the rename.
 */
export function createPlaylist(
  name: string,
  items: PlaylistItem[],
): { list: Playlist[]; created: Playlist } {
  const now = Date.now();
  const playlist: Playlist = {
    id: randomUUID(),
    name: uniqueName(name.trim() || "Untitled playlist", getPlaylists()),
    createdAt: now,
    updatedAt: now,
    items: boundItems(items),
  };
  return { list: save([playlist, ...getPlaylists()]), created: playlist };
}

/**
 * `touch` bumps updatedAt, which also re-sorts the list. USER edits touch;
 * system writes (id healing) must not — otherwise activating a playlist
 * silently reshuffles the user's collection.
 */
function patch(id: string, fn: (p: Playlist) => Playlist, touch = true): Playlist[] {
  return save(
    getPlaylists().map((p) =>
      p.id === id ? { ...fn(p), ...(touch ? { updatedAt: Date.now() } : {}) } : p,
    ),
  );
}

export function renamePlaylist(id: string, name: string): Playlist[] {
  return patch(id, (p) => ({ ...p, name: name.trim() || p.name }));
}

export function deletePlaylist(id: string): Playlist[] {
  return save(getPlaylists().filter((p) => p.id !== id));
}

/**
 * Put a deleted playlist back VERBATIM — undo, not a fresh create.
 * createPlaylist is the wrong verb here on three counts: it mints a new id, it
 * uniquifies the name (a restore would come back as "Mixtape (2)"), and it
 * stamps new timestamps, losing createdAt / lastPlayedAt / lastMissing. Keeping
 * the original updatedAt also matters — save() sorts newest-first, so a
 * verbatim restore lands back in its old place in the collection instead of
 * jumping to the top.
 *
 * Idempotent: restoring something that already exists (a double-fired undo)
 * replaces rather than duplicates.
 */
export function restorePlaylist(playlist: Playlist): Playlist[] {
  return save([...getPlaylists().filter((p) => p.id !== playlist.id), playlist]);
}

/** Reorder and remove both land here — the renderer owns the resulting order. */
export function setPlaylistItems(id: string, items: PlaylistItem[]): Playlist[] {
  return patch(id, (p) => ({ ...p, items: boundItems(items) }));
}

/** Append. Duplicates are allowed: a playlist is an ordered list, not a set. */
export function appendToPlaylist(id: string, items: PlaylistItem[]): Playlist[] {
  return patch(id, (p) => ({ ...p, items: boundItems([...p.items, ...items]) }));
}

/**
 * Stamp an activation: when it ran and what it couldn't find. A SYSTEM write —
 * no updatedAt bump, so playing a playlist doesn't reshuffle a collection
 * sorted by recent edits.
 */
export function markPlaylistPlayed(id: string, missing: string[]): Playlist[] {
  return patch(id, (p) => ({ ...p, lastPlayedAt: Date.now(), lastMissing: missing }), false);
}

/**
 * Heal one entry's stale server/object id in place after a content re-resolve
 * — the favorites `updateFavorite` move, applied per playlist entry. Indexed
 * rather than keyed by content because a playlist may legitimately hold the
 * same track twice; but activation iterates a SNAPSHOT while the user can
 * still reorder or remove entries, so the index is only trusted when the
 * entry there still IS the track that was resolved. On a mismatch the heal is
 * skipped — the id was a hint, and the next activation re-resolves it anyway.
 */
export function healPlaylistItem(
  id: string,
  index: number,
  item: PlaylistItem,
  hint: Pick<PlaylistItem, "serverUdn" | "serverName" | "objectId">,
): Playlist[] {
  const expected = playlistItemKey(item);
  return patch(
    id,
    (p) => ({
      ...p,
      items: p.items.map((it, i) =>
        i === index && playlistItemKey(it) === expected ? { ...it, ...hint } : it,
      ),
    }),
    false, // system write — must not reorder the user's collection
  );
}
