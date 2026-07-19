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

/** Platform modifier label for shortcut chips ("⌘K" / "Ctrl+K"). */
export const MOD = /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+'
