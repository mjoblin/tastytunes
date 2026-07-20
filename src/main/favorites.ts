import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import { favoriteKey, type Favorite } from '@shared/ipc'

// The local favorites collection (stations, albums, tracks), persisted beside
// settings.json — the recents.ts pattern. User-curated and unbounded (it's a
// small JSON of things someone deliberately hearted, not a churning log).
// Newest-hearted first; identity = favoriteKey (content, not object ids).

let cached: Favorite[] | null = null

function favoritesPath(): string {
  return join(app.getPath('userData'), 'favorites.json')
}

export function getFavorites(): Favorite[] {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(favoritesPath(), 'utf-8'))
    cached = Array.isArray(parsed) ? (parsed as Favorite[]) : []
  } catch {
    cached = []
  }
  return cached
}

function save(list: Favorite[]): Favorite[] {
  cached = list
  try {
    const path = favoritesPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(list))
  } catch (err) {
    console.error('failed to persist favorites', err)
  }
  return list
}

/** Add (or re-add) a favorite: any same-key entry is replaced, newest first. */
export function addFavorite(fav: Favorite): Favorite[] {
  const key = favoriteKey(fav)
  return save([fav, ...getFavorites().filter((f) => favoriteKey(f) !== key)])
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
