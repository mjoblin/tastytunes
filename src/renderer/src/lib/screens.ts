import {
  Cable,
  Cog,
  Disc3,
  HardDrive,
  History,
  Library,
  ListMusic,
  Radio,
  RadioTower
} from 'lucide-react'
import type { Screen } from '@/store'

/**
 * THE screen registry — the single source for every surface that lists
 * screens: the nav, the command palette, the keyboard shortcuts, and the
 * shortcuts overlay. It used to live in three hand-synced copies, which is
 * exactly how the L-shortcut collision happened (a screen key silently
 * shadowing a transport key). Keys must never collide with the transport
 * shortcuts in useShortcuts (J/L seek, K/space, M mute, arrows).
 */
export interface ScreenDef {
  id: Screen
  label: string
  icon: typeof Disc3
  key: string
}

export const NAV_SCREENS: ScreenDef[] = [
  { id: 'now-playing', label: 'Now Playing', icon: Disc3, key: 'N' },
  { id: 'queue', label: 'Queue', icon: ListMusic, key: 'Q' },
  { id: 'presets', label: 'Presets', icon: Radio, key: 'P' },
  { id: 'library', label: 'Library', icon: Library, key: 'I' },
  // T as in Tuner — the classic hi-fi name for the radio section
  { id: 'radio', label: 'Radio', icon: RadioTower, key: 'T' },
  { id: 'recently-played', label: 'Recently Played', icon: History, key: 'R' },
  { id: 'sources', label: 'Sources', icon: Cable, key: 'S' },
  { id: 'device', label: 'Device', icon: HardDrive, key: 'D' }
]
export const SETTINGS_SCREEN: ScreenDef = { id: 'settings', label: 'Settings', icon: Cog, key: 'E' }
export const SCREENS: ScreenDef[] = [...NAV_SCREENS, SETTINGS_SCREEN]

/** Screens that can never be hidden from the nav (feature: hideable nav items). */
export const NAV_UNHIDEABLE: Screen[] = ['now-playing']

/**
 * Sanitize a persisted nav hide-set into real, hideable registry ids: drops
 * anything that isn't a NAV_SCREENS id, strips the unhideable screens
 * ('now-playing'), and de-dupes. Owned by the registry so the nav, the
 * Settings card, and the palette all agree on what "hidden" means.
 */
export function sanitizeNavHidden(raw: readonly string[] | null | undefined): Screen[] {
  if (!Array.isArray(raw)) return []
  const hideable = new Set<string>(NAV_SCREENS.map((s) => s.id).filter((id) => !NAV_UNHIDEABLE.includes(id)))
  const out: Screen[] = []
  for (const id of raw) {
    if (hideable.has(id) && !out.includes(id as Screen)) out.push(id as Screen)
  }
  return out
}

/** Platform modifier label for shortcut chips ("⌘K" / "Ctrl+K"). */
export const MOD = /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+'
