import { create } from 'zustand'
import type {
  AppSettings,
  ConnectionState,
  DiscoveredDevice,
  FrameEntry,
  LogEntry,
  McpStatus,
  MenuCommand,
  PushMessage,
  RecentTrack,
  SleepAction,
  SleepTimer,
  Snapshot
} from '@shared/ipc'
import type {
  Presets,
  QueueList,
  QueueListItem,
  SystemInfo,
  SystemPower,
  SystemSources,
  ZoneNowPlaying,
  ZonePlayState,
  ZoneState
} from '@shared/smoip'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { tt } from './api'

export type Screen =
  | 'now-playing'
  | 'queue'
  | 'presets'
  | 'recently-played'
  | 'sources'
  | 'device'
  | 'settings'

const FRAME_RING = 300
const LOG_RING = 300

interface PlayheadSync {
  secs: number
  at: number // Date.now() when received — the UI interpolates from here
}

interface TTState {
  screen: Screen
  connection: ConnectionState
  devices: DiscoveredDevice[]
  discovering: boolean
  settings: AppSettings

  playState: ZonePlayState | null
  nowPlaying: ZoneNowPlaying | null
  zoneState: ZoneState | null
  queue: QueueList | null
  presets: Presets | null
  systemInfo: SystemInfo | null
  systemPower: SystemPower | null
  sources: SystemSources | null
  playhead: PlayheadSync | null

  frames: FrameEntry[]
  logs: LogEntry[]

  diagnosticsOpen: boolean
  shortcutsOpen: boolean
  infoOpen: boolean
  paletteOpen: boolean
  displayMode: boolean
  /** True while the full-window ambient backdrop is showing — chrome goes transparent. */
  ambientWindowActive: boolean
  /** Mini window only: cursor is over the window (pushed from main). */
  miniHover: boolean
  /** Live sleep timer, mirrored from the main process (arm via tt.setSleep). */
  sleep: SleepTimer | null
  /** Local recently-played log, newest first (mirrored from the main process). */
  recents: RecentTrack[]
  /** MCP server state, mirrored from the main process. */
  mcpStatus: McpStatus

  setScreen(screen: Screen): void
  setDiagnosticsOpen(open: boolean): void
  setShortcutsOpen(open: boolean): void
  setInfoOpen(open: boolean): void
  setPaletteOpen(open: boolean): void
  setDisplayMode(on: boolean): void
  setAmbientWindowActive(on: boolean): void
  setSleepAction(action: SleepAction): void
  setSettings(settings: AppSettings): void
  setQueueItems(items: QueueListItem[]): void
  init(snapshot: Snapshot): void
  applyPush(msg: PushMessage): void
  /** Application-menu clicks forwarded from the main process (main window only). */
  applyMenu(command: MenuCommand): void
}

export const useStore = create<TTState>((set, get) => ({
  screen: 'now-playing',
  connection: { phase: 'idle' },
  devices: [],
  discovering: false,
  settings: DEFAULT_SETTINGS,

  playState: null,
  nowPlaying: null,
  zoneState: null,
  queue: null,
  presets: null,
  systemInfo: null,
  systemPower: null,
  sources: null,
  playhead: null,

  frames: [],
  logs: [],

  diagnosticsOpen: false,
  shortcutsOpen: false,
  infoOpen: false,
  paletteOpen: false,
  displayMode: false,
  ambientWindowActive: false,
  miniHover: false,
  sleep: null,
  recents: [],
  mcpStatus: { running: false, url: null, error: null },

  setScreen: (screen) => set({ screen }),
  setDiagnosticsOpen: (diagnosticsOpen) => set({ diagnosticsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setInfoOpen: (infoOpen) => set({ infoOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setDisplayMode: (displayMode) => set({ displayMode }),
  setAmbientWindowActive: (ambientWindowActive) => set({ ambientWindowActive }),
  // Local settings echo only — an armed timer's action is updated via
  // tt.setSleep, and the main process pushes the change back.
  setSleepAction: (action) =>
    set((s) => ({ settings: { ...s.settings, sleepAction: action } })),
  setSettings: (settings) => set({ settings }),
  setQueueItems: (items) =>
    set((s) => (s.queue ? { queue: { ...s.queue, items } } : {})),

  init: (snap) =>
    set({
      connection: snap.connection,
      devices: snap.devices,
      discovering: snap.discovering,
      settings: snap.settings,
      playState: snap.playState,
      nowPlaying: snap.nowPlaying,
      zoneState: snap.zoneState,
      queue: snap.queue,
      presets: snap.presets,
      systemInfo: snap.systemInfo,
      systemPower: snap.systemPower,
      sources: snap.sources,
      sleep: snap.sleep,
      recents: snap.recents,
      mcpStatus: snap.mcpStatus,
      playhead: snap.position ? { secs: snap.position.position, at: Date.now() } : null,
      frames: snap.frames,
      logs: snap.logs
    }),

  applyPush: (msg) =>
    set((s) => {
      switch (msg.kind) {
        case 'connection': {
          // Blank stale streamer state when a connection drops or restarts.
          if (msg.state.phase !== 'connected') return { connection: msg.state }
          return { connection: msg.state }
        }
        case 'devices':
          return { devices: msg.devices, discovering: msg.discovering }
        case 'playState':
          return {
            playState: msg.data,
            playhead:
              msg.data.position != null ? { secs: msg.data.position, at: Date.now() } : s.playhead
          }
        case 'position':
          return { playhead: { secs: msg.data.position, at: Date.now() } }
        case 'nowPlaying':
          return { nowPlaying: msg.data }
        case 'zoneState':
          return { zoneState: msg.data }
        case 'queue':
          return { queue: msg.data }
        case 'presets':
          return { presets: msg.data }
        case 'systemInfo':
          return { systemInfo: msg.data }
        case 'systemPower':
          return { systemPower: msg.data }
        case 'sources':
          return { sources: msg.data }
        case 'frame': {
          const frames = [...s.frames, msg.entry]
          if (frames.length > FRAME_RING) frames.splice(0, frames.length - FRAME_RING)
          return { frames }
        }
        case 'log': {
          const logs = [...s.logs, msg.entry]
          if (logs.length > LOG_RING) logs.splice(0, logs.length - LOG_RING)
          return { logs }
        }
        case 'miniHover':
          return { miniHover: msg.hovered }
        case 'sleep':
          return { sleep: msg.sleep }
        case 'recents':
          return { recents: msg.data }
        case 'mcpStatus':
          return { mcpStatus: msg.status }
        case 'menu':
          return {} // routed to applyMenu in main.tsx; nothing to merge here
      }
    }),

  applyMenu: (command) => {
    const s = get()
    switch (command.id) {
      case 'about':
        s.setInfoOpen(true)
        break
      case 'palette':
        s.setPaletteOpen(!s.paletteOpen)
        break
      case 'shortcuts':
        s.setShortcutsOpen(!s.shortcutsOpen)
        break
      case 'displayMode':
        s.setDisplayMode(!s.displayMode)
        break
      case 'toggleNav':
        // Same round-trip as Nav's collapse button: persist, then adopt.
        void tt
          .setSettings({ navCollapsed: !s.settings.navCollapsed })
          .then((next) => get().setSettings(next))
        break
      case 'screen':
        s.setScreen(command.screen as Screen)
        break
    }
  }
}))
