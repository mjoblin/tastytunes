import { create } from 'zustand'
import type {
  AppSettings,
  ConnectionState,
  DiscoveredDevice,
  Favorite,
  FirmwareStatus,
  FrameEntry,
  LogEntry,
  McpStatus,
  MediaIndexStatus,
  MenuCommand,
  NetRequestEntry,
  PushMessage,
  UpdateState,
  RecentTrack,
  SleepTimer,
  Snapshot
} from '@shared/ipc'
import type {
  Presets,
  QueueList,
  QueueListItem,
  SystemDisplay,
  SystemDisplaySpec,
  SystemInfo,
  SystemPower,
  SystemPowerSpec,
  SystemSources,
  ZoneAudio,
  ZoneAudioSpec,
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
  | 'radio'
  | 'favorites'
  | 'recently-played'
  | 'sources'
  | 'device'
  | 'settings'

/** A Library destination planted by another screen (Favorites "open album"):
 *  the LibraryScreen consumes it on its next mount/reset and navigates there. */
export interface LibraryTarget {
  serverUdn: string
  objectId: string
  /** Breadcrumb titles from root INCLUDING the target's own title — feeds the
   *  browse re-walk when the stored objectId has rotted. */
  titlePath: string[]
  title: string
  /**
   * The libraryResetNonce this target belongs to. The consuming effect keys
   * on nonce EQUALITY instead of consume-and-clear: StrictMode double-runs
   * mount effects in dev, and a cleared target made the second run reset to
   * the source list (the "lands on top-level Library" bug). A stale nonce
   * just means "ordinary reset".
   */
  nonce: number
}

/** The station most recently streamed BY THIS APP this session — the only way
 *  Now Playing can heart a radio stream (play_state carries no URL). */
export interface LastStation {
  url: string
  name: string
  favicon: string | null
  radioBrowserUuid: string | null
}

const FRAME_RING = 300
const LOG_RING = 300

/**
 * The one transient-feedback slot (single toast, replace-don't-stack).
 * Reserved for actions whose effect isn't visible from the current screen
 * and for failed fire-and-forget streamer writes — continuous state (volume,
 * transport, connection) has its own live surfaces and never toasts.
 */
export interface ToastData {
  /** Monotonic nonce so an identical replacement still restarts the timer. */
  id: number
  kind: 'success' | 'error'
  text: string
  action?: { label: string; screen: Screen }
}
let toastNonce = 0

interface PlayheadSync {
  secs: number
  at: number // Date.now() when received — the UI interpolates from here
}

interface TTState {
  screen: Screen
  /** Bumped on every navigation TO the library — the screen resets to its
   *  source list (nav/palette/shortcut "Library" means the front door). */
  libraryResetNonce: number
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
  /** A wake-on-intent is in flight (playing something from standby). */
  waking: boolean
  /** Last standby_mode seen from ANY device this session — survives the
   *  disconnect blanking so the ConnectGate can suggest eco standby. */
  lastStandbyMode: SystemPower['standby_mode'] | null
  /** Read-only streamer firmware status (PASSIVE — shown, never acted on). */
  firmwareUpdate: FirmwareStatus | null
  sources: SystemSources | null
  /** Tone/EQ state, live-mirrored (the streamer pushes /zone/audio on change). */
  zoneAudio: ZoneAudio | null
  /** Tone/EQ capability spec (null = this streamer has no tone controls). */
  audioSpec: ZoneAudioSpec | null
  /** Front-panel display + power/standby state and capability specs (§10 controls). */
  systemDisplay: SystemDisplay | null
  displaySpec: SystemDisplaySpec | null
  powerSpec: SystemPowerSpec | null
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
  screenFilters: {
    queue: string
    presets: string
    library: string
    favorites: string
    'recently-played': string
  }
  /** True while the full-window ambient backdrop is showing — chrome goes transparent. */
  ambientWindowActive: boolean
  /** Mini window only: cursor is over the window (pushed from main). */
  miniHover: boolean
  /** Live sleep timer, mirrored from the main process (arm via tt.setSleep). */
  sleep: SleepTimer | null
  /** Local recently-played log, newest first (mirrored from the main process). */
  recents: RecentTrack[]
  /** Local favorites, newest-hearted first (mirrored from the main process). */
  favorites: Favorite[]
  /** See LibraryTarget — set by Favorites, consumed by LibraryScreen. */
  libraryTarget: LibraryTarget | null
  /** See LastStation — session-only, set by every in-app streamRadio play. */
  lastStation: LastStation | null
  /** MCP server state, mirrored from the main process. */
  mcpStatus: McpStatus
  /** Local media-index state per known server (Settings + Library UI). */
  mediaIndex: MediaIndexStatus[]
  /** Self-update consent-flow state, mirrored from the main process. */
  update: UpdateState | null
  /** One-shot deep link into a Settings tab (e.g. the nav update dot →
   *  Updates); SettingsScreen consumes and clears it. */
  settingsJump: string | null
  jumpToSettingsTab(tab: string): void
  clearSettingsJump(): void
  /** One-shot ask: open the Library ready to search (palette / ⌘F). Paired
   *  with the reset nonce it belongs to — the libraryTarget pattern, safe
   *  across fresh mounts and StrictMode double-runs. */
  librarySearchTarget: { nonce: number } | null
  requestLibrarySearch(): void

  toast: ToastData | null
  showToast(toast: Omit<ToastData, 'id'>): void
  dismissToast(): void
  /** In-app recall memory (see Snapshot.lastRecalledPresetId). */
  lastRecalledPresetId: number | null
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
    screen: 'queue' | 'presets' | 'library' | 'favorites' | 'recently-played',
    text: string
  ): void
  /** Navigate to the Library opened at a specific node (Favorites → album). */
  openInLibrary(target: Omit<LibraryTarget, 'nonce'>): void
  clearLibraryTarget(): void
  setLastStation(st: LastStation): void
  setAmbientWindowActive(on: boolean): void
  setSettings(settings: AppSettings): void
  /** THE settings write path: round-trip through main, adopt the result. */
  saveSettings(patch: Partial<AppSettings>): Promise<void>
  setQueueItems(items: QueueListItem[]): void
  init(snapshot: Snapshot): void
  applyPush(msg: PushMessage): void
  /** Application-menu clicks forwarded from the main process (main window only). */
  applyMenu(command: MenuCommand): void
}

export const useStore = create<TTState>((set, get) => ({
  screen: 'now-playing',
  libraryResetNonce: 0,
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
  waking: false,
  lastStandbyMode: null,
  firmwareUpdate: null,
  sources: null,
  zoneAudio: null,
  audioSpec: null,
  systemDisplay: null,
  displaySpec: null,
  powerSpec: null,
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
  screenFilters: { queue: '', presets: '', library: '', favorites: '', 'recently-played': '' },
  ambientWindowActive: false,
  miniHover: false,
  sleep: null,
  recents: [],
  favorites: [],
  libraryTarget: null,
  lastStation: null,
  mcpStatus: { running: false, url: null, error: null },
  mediaIndex: [],
  update: null,
  settingsJump: null,
  jumpToSettingsTab: (tab) => {
    get().setScreen('settings')
    set({ settingsJump: tab })
  },
  clearSettingsJump: () => set({ settingsJump: null }),
  librarySearchTarget: null,
  requestLibrarySearch: () => {
    get().setScreen('library') // bumps libraryResetNonce
    set({ librarySearchTarget: { nonce: get().libraryResetNonce } })
  },

  toast: null,
  showToast: (toast) => set({ toast: { ...toast, id: ++toastNonce } }),
  dismissToast: () => set({ toast: null }),
  lastRecalledPresetId: null,
  setScreen: (screen) =>
    set((s) =>
      screen === 'library' ? { screen, libraryResetNonce: s.libraryResetNonce + 1 } : { screen }
    ),
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
  // The target is stamped with the nonce it belongs to — the consuming
  // effect matches on it (idempotent; see LibraryTarget.nonce).
  openInLibrary: (target) =>
    set((s) => ({
      libraryTarget: { ...target, nonce: s.libraryResetNonce + 1 },
      screen: 'library',
      libraryResetNonce: s.libraryResetNonce + 1
    })),
  clearLibraryTarget: () => set({ libraryTarget: null }),
  setLastStation: (lastStation) => set({ lastStation }),
  setAmbientWindowActive: (ambientWindowActive) => set({ ambientWindowActive }),
  setSettings: (settings) => set({ settings }),
  saveSettings: async (patch) => {
    const settings = await tt.setSettings(patch)
    set({ settings })
  },
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
      lastRecalledPresetId: snap.lastRecalledPresetId,
      queue: snap.queue,
      presets: snap.presets,
      systemInfo: snap.systemInfo,
      systemPower: snap.systemPower,
      // The eco hint needs the standby mode even when systemPower arrives via
      // the boot snapshot rather than a push (fresh launches).
      ...(snap.systemPower?.standby_mode != null
        ? { lastStandbyMode: snap.systemPower.standby_mode }
        : {}),
      firmwareUpdate: snap.firmwareUpdate,
      sources: snap.sources,
      zoneAudio: snap.zoneAudio,
      audioSpec: snap.audioSpec,
      systemDisplay: snap.systemDisplay,
      displaySpec: snap.displaySpec,
      powerSpec: snap.powerSpec,
      sleep: snap.sleep,
      recents: snap.recents,
      favorites: snap.favorites,
      mcpStatus: snap.mcpStatus,
      mediaIndex: snap.mediaIndex,
      playhead: snap.position ? { secs: snap.position.position, at: Date.now() } : null,
      frames: snap.frames,
      logs: snap.logs,
      netRequests: snap.netRequests
    }),

  applyPush: (msg) =>
    set((s) => {
      switch (msg.kind) {
        case 'connection': {
          // Connecting to a DIFFERENT device blanks the previous streamer's
          // state — its queue/presets otherwise linger until the new device's
          // pushes land. Same-host reconnects keep state: brief drops must
          // not flash the UI empty, and fresh pushes overwrite anyway.
          const prevHost = 'host' in s.connection ? s.connection.host : null
          const nextHost = 'host' in msg.state ? msg.state.host : null
          if (msg.state.phase === 'connecting' && prevHost != null && nextHost !== prevHost) {
            return {
              connection: msg.state,
              playState: null,
              nowPlaying: null,
              zoneState: null,
              queue: null,
              presets: null,
              systemInfo: null,
              systemPower: null,
              firmwareUpdate: null,
              sources: null,
              zoneAudio: null,
              audioSpec: null,
              systemDisplay: null,
              displaySpec: null,
              powerSpec: null,
              sleep: null,
              playhead: null
            }
          }
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
          return { systemPower: msg.data, lastStandbyMode: msg.data?.standby_mode ?? s.lastStandbyMode }
        case 'waking':
          return { waking: msg.waking }
        case 'firmwareUpdate':
          return { firmwareUpdate: msg.data }
        case 'sources':
          return { sources: msg.data }
        case 'zoneAudio':
          return { zoneAudio: msg.data }
        case 'audioSpec':
          return { audioSpec: msg.data }
        case 'systemDisplay':
          return { systemDisplay: msg.data }
        case 'displaySpec':
          return { displaySpec: msg.data }
        case 'powerSpec':
          return { powerSpec: msg.data }
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
        case 'recalledPreset':
          return { lastRecalledPresetId: msg.id }
        case 'recents':
          return { recents: msg.data }
        case 'favorites':
          return { favorites: msg.data }
        case 'mcpStatus':
          return { mcpStatus: msg.status }
        case 'mediaIndex':
          return { mediaIndex: msg.statuses }
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
        case 'settings':
          // settings changed outside the renderer (an MCP tool edited
          // schedules) — adopt wholesale, same as a snapshot would
          return { settings: msg.settings }
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
