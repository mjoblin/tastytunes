import { create } from 'zustand'
import type {
  AppSettings,
  ConnectionState,
  DiscoveredDevice,
  FrameEntry,
  LogEntry,
  McpStatus,
  MenuCommand,
  NetRequestEntry,
  PushMessage,
  UpdateState,
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
  | 'library'
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
  /** Outbound HTTP requests from the main process (diagnostics Requests tab). */
  netRequests: NetRequestEntry[]

  diagnosticsOpen: boolean
  shortcutsOpen: boolean
  infoOpen: boolean
  paletteOpen: boolean
  displayMode: boolean
  /** Lyrics drawer on the Now Playing screen (ephemeral, not persisted). */
  lyricsOpen: boolean
  /** Artist-context drawer on Now Playing (mutually exclusive with lyrics). */
  artistOpen: boolean
  /** Active tab in the context drawer — remembered for the session only. */
  contextTab: 'artist' | 'album'
  /** Per-screen list filters — session only; always visible in the screen's header box. */
  screenFilters: { queue: string; presets: string; library: string; 'recently-played': string }
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
  /** Self-update consent-flow state, mirrored from the main process. */
  update: UpdateState | null

  setScreen(screen: Screen): void
  setDiagnosticsOpen(open: boolean): void
  setShortcutsOpen(open: boolean): void
  setInfoOpen(open: boolean): void
  setPaletteOpen(open: boolean): void
  setDisplayMode(on: boolean): void
  setLyricsOpen(open: boolean): void
  setArtistOpen(open: boolean): void
  setContextTab(tab: 'artist' | 'album'): void
  setScreenFilter(
    screen: 'queue' | 'presets' | 'library' | 'recently-played',
    text: string
  ): void
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
  netRequests: [],

  diagnosticsOpen: false,
  shortcutsOpen: false,
  infoOpen: false,
  paletteOpen: false,
  displayMode: false,
  lyricsOpen: false,
  artistOpen: false,
  contextTab: 'artist',
  screenFilters: { queue: '', presets: '', library: '', 'recently-played': '' },
  ambientWindowActive: false,
  miniHover: false,
  sleep: null,
  recents: [],
  mcpStatus: { running: false, url: null, error: null },
  update: null,

  setScreen: (screen) => set({ screen }),
  setDiagnosticsOpen: (diagnosticsOpen) => set({ diagnosticsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setInfoOpen: (infoOpen) => set({ infoOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setDisplayMode: (displayMode) => set({ displayMode }),
  // The two Now Playing drawers are mutually exclusive — opening one closes
  // the other here, so every opener (header buttons, future palette entries)
  // inherits the rule.
  setLyricsOpen: (lyricsOpen) => set(lyricsOpen ? { lyricsOpen, artistOpen: false } : { lyricsOpen }),
  setArtistOpen: (artistOpen) => set(artistOpen ? { artistOpen, lyricsOpen: false } : { artistOpen }),
  setContextTab: (contextTab) => set({ contextTab }),
  setScreenFilter: (screen, text) =>
    set((s) => ({ screenFilters: { ...s.screenFilters, [screen]: text } })),
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
      logs: snap.logs,
      netRequests: snap.netRequests
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
        case 'updateState':
          return { update: msg.state.phase === 'idle' ? null : msg.state }
        case 'netRequest': {
          // start + settle arrive as separate pushes for the same id — upsert
          const idx = s.netRequests.findIndex((e) => e.id === msg.entry.id)
          const netRequests =
            idx >= 0
              ? s.netRequests.map((e, i) => (i === idx ? msg.entry : e))
              : [...s.netRequests, msg.entry]
          if (netRequests.length > 200) netRequests.splice(0, netRequests.length - 200)
          return { netRequests }
        }
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
