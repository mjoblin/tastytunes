import {
  Cog,
  Command,
  Disc3,
  HardDrive,
  Heart,
  History,
  Library,
  ListMusic,
  ListOrdered,
  PictureInPicture2,
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

/**
 * ORDER IS BY THE USER'S MENTAL MODEL, not by how the data is stored (user
 * call 2026-07-25). Four runs, no dividers — the grouping has to survive rows
 * being hidden, and visual sections stay an unspent lever for if the rail ever
 * gets long enough to need them:
 *
 *   playing now      Now Playing · Queue
 *   everything       Library
 *   set up for later Favorites · Playlists · Presets
 *   dipped into      Radio · Recently Played
 *   system           Device
 *
 * Presets sits with Playlists and Favorites — all three are "things I set up
 * so I can play them later", and that a preset lives in a device slot while a
 * playlist is a local file is OUR distinction, not the listener's. It closing
 * that group also lands it beside Radio, which is what most preset slots hold.
 * Radio and Recently Played sink on FREQUENCY rather than kind (Radio is a
 * browse surface like Library) — the rarely-opened belong near the bottom.
 *
 * KEYS ARE INDEPENDENT OF ORDER and must stay put when this list is
 * rearranged: muscle memory is the whole point of them.
 */
export const NAV_SCREENS: ScreenDef[] = [
  { id: 'now-playing', label: 'Now Playing', icon: Disc3, key: 'N' },
  { id: 'queue', label: 'Queue', icon: ListMusic, key: 'Q' },
  { id: 'library', label: 'Library', icon: Library, key: 'I' },
  // V as in faVorites (F belongs to display mode, H was left free for future
  // transport use) — must stay clear of J/L/K/space/M/F like every screen key
  { id: 'favorites', label: 'Favorites', icon: Heart, key: 'V' },
  // 'A' as in plAylists — S is the Search screen's, and P/L are long gone
  // (Presets, and L is a transport seek key). ListOrdered rather than
  // ListMusic: the queue owns that one, and a playlist IS a saved ordering.
  { id: 'playlists', label: 'Playlists', icon: ListOrdered, key: 'A' },
  { id: 'presets', label: 'Presets', icon: Radio, key: 'P' },
  // T as in Tuner — the classic hi-fi name for the radio section
  { id: 'radio', label: 'Radio', icon: RadioTower, key: 'T' },
  { id: 'recently-played', label: 'Recently Played', icon: History, key: 'R' },
  // Sources USED to be its own row (key 'C'); it's a section of the Device
  // screen now — both are "system, not music", and Sources is one rarely-used
  // action. 'C' is free again and deliberately not reused.
  { id: 'device', label: 'Device', icon: HardDrive, key: 'D' }
]
export const SETTINGS_SCREEN: ScreenDef = { id: 'settings', label: 'Settings', icon: Cog, key: 'E' }
export const SCREENS: ScreenDef[] = [...NAV_SCREENS, SETTINGS_SCREEN]

/**
 * Screens that can never be hidden from the nav (feature: hideable nav items).
 * 'settings' lives in the nav's pinned bottom cluster and stays locked — always
 * shown, no right-click hide menu — same as 'now-playing' up top.
 */
export const NAV_UNHIDEABLE: Screen[] = ['now-playing', 'settings']

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

/** Hideable nav-tool ids — the pinned bottom-cluster buttons, minus the locked ones. */
export type NavTool = 'commands' | 'mini-player'

/** A hideable nav tool. Mirrors ScreenDef's id/label/icon (no shortcut key). */
export interface NavToolDef {
  id: NavTool
  label: string
  icon: typeof Disc3
}

/**
 * THE nav-tools registry — the pinned bottom-cluster buttons (below the
 * screens) that can be hidden from the nav, same as screens. Owned here so the
 * Nav and the Settings "Sidebar" card agree on ids/labels/icons. Settings and
 * Collapse are deliberately absent: Settings stays locked, Collapse is the
 * nav's own control and is never hideable. Every hidden tool keeps an alternate
 * route (Commands: the palette shortcut; mini player: the palette + View menu).
 */
export const NAV_TOOLS: NavToolDef[] = [
  { id: 'commands', label: 'Commands', icon: Command },
  { id: 'mini-player', label: 'Mini player', icon: PictureInPicture2 }
]

/**
 * Sanitize a persisted nav-tool hide-set into real tool ids: drops anything
 * that isn't a NAV_TOOLS id and de-dupes. Mirrors sanitizeNavHidden; kept
 * separate because tool ids and screen ids are different id-spaces.
 */
export function sanitizeNavHiddenTools(raw: readonly string[] | null | undefined): NavTool[] {
  if (!Array.isArray(raw)) return []
  const known = new Set<string>(NAV_TOOLS.map((t) => t.id))
  const out: NavTool[] = []
  for (const id of raw) {
    if (known.has(id) && !out.includes(id as NavTool)) out.push(id as NavTool)
  }
  return out
}

/** Platform modifier label for shortcut chips ("⌘K" / "Ctrl+K"). */
export const MOD = /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+'
