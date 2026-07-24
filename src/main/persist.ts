import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, DISPLAY_FONT_IDS, type AppSettings } from '@shared/ipc'

let cached: AppSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  if (cached) return cached
  let loaded: AppSettings
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
    loaded = { ...DEFAULT_SETTINGS, ...raw }
    // The merge above is shallow — backfill nested objects from older files.
    loaded.mcp = { ...DEFAULT_SETTINGS.mcp, ...loaded.mcp }
    // Heal a display font that was retired (e.g. an older file naming a face no
    // longer in the curated set) back to the default so the picker stays in sync.
    if (!DISPLAY_FONT_IDS.includes(loaded.displayFont)) {
      loaded.displayFont = DEFAULT_SETTINGS.displayFont
    }
  } catch {
    loaded = { ...DEFAULT_SETTINGS }
  }
  cached = loaded
  return loaded
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  cached = next
  try {
    const path = settingsPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(next, null, 2))
  } catch (err) {
    console.error('failed to persist settings', err)
  }
  return next
}
