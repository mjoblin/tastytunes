import { join } from 'node:path'
import { app } from 'electron'
import { favoriteKey, type Favorite } from '@shared/ipc'
import { jsonFileStore } from './jsonStore'

// The local favorites collection (stations, albums, tracks), persisted beside
// settings.json. User-curated and unbounded (it's a small JSON of things
// someone deliberately hearted, not a churning log). Newest-hearted first;
// identity = favoriteKey (content, not object ids). Load/save (cached,
// atomic) live in jsonStore; only the domain verbs live here.

const store = jsonFileStore<Favorite[]>({
  pathOf: () => join(app.getPath('userData'), 'favorites.json'),
  scope: 'favorites',
  load: (parsed) => (Array.isArray(parsed) ? (parsed as Favorite[]) : [])
})

export function getFavorites(): Favorite[] {
  return store.get()
}

const save = (list: Favorite[]): Favorite[] => store.set(list)

/**
 * Add (or re-add) a favorite: any same-key entry is replaced, and the list
 * stays newest-first.
 *
 * Placed BY ITS addedAt rather than simply prepended. For a genuine heart
 * (addedAt = now) that's the head either way, so nothing changes; it matters
 * for a RE-heart undoing an accidental unheart, which carries the original
 * stamp and belongs back in its old slot, not at the top. Prepending made the
 * "newest first" ordering a side effect of call order — this makes it the rule.
 */
export function addFavorite(fav: Favorite): Favorite[] {
  const key = favoriteKey(fav)
  const rest = getFavorites().filter((f) => favoriteKey(f) !== key)
  const at = rest.findIndex((f) => f.addedAt < fav.addedAt)
  const idx = at === -1 ? rest.length : at
  return save([...rest.slice(0, idx), fav, ...rest.slice(idx)])
}

export function removeFavorite(key: string): Favorite[] {
  return save(getFavorites().filter((f) => favoriteKey(f) !== key))
}

/** Patch a favorite in place (e.g. objectId healing after a search resolve). */
export function updateFavorite(key: string, patch: Partial<Favorite>): Favorite[] {
  return save(
    getFavorites().map((f) => (favoriteKey(f) === key ? ({ ...f, ...patch } as Favorite) : f))
  )
}
