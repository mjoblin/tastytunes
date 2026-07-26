import { favoriteKey, type Favorite } from '@shared/ipc'
import { useStore, type SearchBack } from '@/store'
import { toggleFavorite } from '@/lib/favorites'
import { refToFavorite, type MediaRef } from '@/lib/mediaRef'

/**
 * THE menu contents for a piece of media — what RowMenu did for the menu
 * SHELL, done for what's inside it.
 *
 * Every surface used to hand-write its own item list, which is why the same
 * track offered five verbs in the Library, three in Favorites and none in
 * Search. A surface now composes its menu from these builders plus its own
 * local verbs (`extra` — Remove from queue, Remove from playlist…), so a
 * track's menu is the same menu everywhere BY CONSTRUCTION, and a future verb
 * added here lands on every screen at once.
 *
 * Universal verbs live inside the builders: the HEART (derived from the live
 * favorites list via content identity; `heart` cap overrides for surfaces
 * that store richer favorites, e.g. the Library's titlePath) and the SEARCH
 * PIVOT (artists pivot on their own name, albums/tracks on their artist).
 * Surface-dependent verbs arrive as capabilities and are simply omitted when
 * a surface can't offer them.
 */
export interface MediaMenuItem {
  label: string
  run(): void
}

export interface MediaMenuCaps {
  playNow?(): void
  playNext?(): void
  append?(): void
  replaceQueue?(): void
  /** Inserted after the queue verbs — the Library's "Play album from here". */
  extraQueueVerbs?: MediaMenuItem[]
  /** Open the entity's home in the Library (favorites, search results). */
  openInLibrary?(): void
  goToAlbum?(): void
  goToArtist?(): void
  saveToPreset?(): void
  addToPlaylist?(): void
  /** Override the derived heart (the Library stores richer favorites). */
  heart?: { active: boolean; toggle(): void }
  /** Where the search pivot should record it left, for ⌘← back. */
  searchFrom?: SearchBack
  /** Local verbs, appended last — Remove from queue, delete, unheart… */
  extra?: MediaMenuItem[]
}

const pivotEntity = (ref: MediaRef): string =>
  ref.kind === 'artist' ? ref.title : (ref.artist ?? ref.title)

function pivotItem(ref: MediaRef, caps: MediaMenuCaps): MediaMenuItem[] {
  const entity = pivotEntity(ref).trim()
  if (!entity) return []
  return [
    {
      label: `Search everywhere for “${entity}”`,
      run: () => useStore.getState().requestSearch(entity, caps.searchFrom)
    }
  ]
}

function heartItem(ref: MediaRef, caps: MediaMenuCaps): MediaMenuItem[] {
  if (caps.heart) {
    return [
      {
        label: caps.heart.active ? 'Remove from favorites' : 'Add to favorites',
        run: caps.heart.toggle
      }
    ]
  }
  const fav = refToFavorite(ref)
  if (!fav) return []
  const key = favoriteKey(fav as Favorite)
  const active = useStore.getState().favorites.some((f) => favoriteKey(f) === key)
  return [
    {
      label: active ? 'Remove from favorites' : 'Add to favorites',
      run: () => void toggleFavorite(fav)
    }
  ]
}

const cap = (label: string, run?: () => void): MediaMenuItem[] => (run ? [{ label, run }] : [])

/** Order everywhere: play verbs · navigate (go-to / open / pivot) · write
 *  verbs (preset, playlist) · heart · local extras. */
export function trackMenuItems(ref: MediaRef, caps: MediaMenuCaps = {}): MediaMenuItem[] {
  return [
    ...cap('Play now', caps.playNow),
    ...cap('Play next', caps.playNext),
    ...cap('Add to end of queue', caps.append),
    ...cap('Replace queue', caps.replaceQueue),
    ...(caps.extraQueueVerbs ?? []),
    ...cap('Go to album', caps.goToAlbum),
    ...cap('Go to artist', caps.goToArtist),
    ...cap('Open in Library', caps.openInLibrary),
    ...pivotItem(ref, caps),
    ...cap('Save to preset…', caps.saveToPreset),
    ...cap('Add to playlist…', caps.addToPlaylist),
    ...heartItem(ref, caps),
    ...(caps.extra ?? [])
  ]
}

export function albumMenuItems(ref: MediaRef, caps: MediaMenuCaps = {}): MediaMenuItem[] {
  return [
    ...cap('Play', caps.playNow),
    ...cap('Play next', caps.playNext),
    ...cap('Add to end of queue', caps.append),
    ...cap('Replace queue', caps.replaceQueue),
    ...(caps.extraQueueVerbs ?? []),
    ...cap('Open in Library', caps.openInLibrary),
    ...pivotItem(ref, caps),
    ...cap('Save to preset…', caps.saveToPreset),
    ...cap('Add to playlist…', caps.addToPlaylist),
    ...heartItem(ref, caps),
    ...(caps.extra ?? [])
  ]
}

/** An artist's menu is the pivot (plus local extras) — the queue verbs don't
 *  apply ("queue a whole artist" is undecided) and favorites key on
 *  album/track identity. Thin, but it's the one cross-collection question an
 *  artist can answer, and any future artist verb has a home here. */
export function artistMenuItems(ref: MediaRef, caps: MediaMenuCaps = {}): MediaMenuItem[] {
  return [...pivotItem(ref, caps), ...(caps.extra ?? [])]
}
