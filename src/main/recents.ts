import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import type { RecentTrack } from '@shared/ipc'

// A bounded ring of recently-played tracks, persisted beside settings.json.
// Kept out of settings.json on purpose: it's a churning log, cleared on its own,
// and shouldn't bloat the settings file the user might inspect or sync.

const MAX_RECENTS = 200

let cached: RecentTrack[] | null = null

function recentsPath(): string {
  return join(app.getPath('userData'), 'recents.json')
}

/** Identity used to collapse the same track repeating back-to-back. */
function recentKey(e: RecentTrack): string {
  return e.isRadio
    ? `r:${e.station ?? ''}:${e.title ?? ''}`
    : `t:${e.title ?? ''}:${e.artist ?? ''}`
}

export function getRecents(): RecentTrack[] {
  if (cached) return cached
  try {
    const raw = JSON.parse(readFileSync(recentsPath(), 'utf-8'))
    cached = Array.isArray(raw) ? (raw as RecentTrack[]) : []
  } catch {
    cached = []
  }
  return cached
}

function save(list: RecentTrack[]): void {
  cached = list
  try {
    const path = recentsPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(list))
  } catch (err) {
    console.error('failed to persist recents', err)
  }
}

/**
 * Record a played track. Consecutive-dedupes against the newest entry (so a
 * pause/resume or a metadata refinement on the same track doesn't add a row),
 * merging in fields — album art especially — that arrive after the first push.
 * Returns the updated list plus whether anything actually changed, so the caller
 * can skip a redundant push.
 */
export function recordRecent(entry: RecentTrack): { list: RecentTrack[]; changed: boolean } {
  const list = getRecents()
  const head = list[0]
  if (head && recentKey(head) === recentKey(entry)) {
    const merged: RecentTrack = {
      ...head,
      title: head.title ?? entry.title,
      artist: head.artist ?? entry.artist,
      album: head.album ?? entry.album,
      station: head.station ?? entry.station,
      artUrl: head.artUrl ?? entry.artUrl,
      source: head.source ?? entry.source
    }
    const changed =
      merged.artist !== head.artist ||
      merged.album !== head.album ||
      merged.artUrl !== head.artUrl ||
      merged.source !== head.source
    if (changed) {
      list[0] = merged
      save(list)
    }
    return { list, changed }
  }
  const next = [entry, ...list]
  if (next.length > MAX_RECENTS) next.length = MAX_RECENTS
  save(next)
  return { list: next, changed: true }
}

export function clearRecents(): RecentTrack[] {
  save([])
  return cached!
}
