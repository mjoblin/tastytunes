// The typed contract between main, preload, and renderer.

import type {
  Presets,
  QueueList,
  SmoipFrame,
  SystemInfo,
  SystemPower,
  SystemSources,
  ZoneNowPlaying,
  ZonePlayState,
  ZonePosition,
  ZoneState
} from './smoip'

// ------------------------------------------------------------------- connection

export type ConnectionState =
  | { phase: 'idle' }
  | { phase: 'connecting'; host: string; attempt: number }
  | { phase: 'connected'; host: string }
  | { phase: 'disconnected'; host: string; reason: string; reconnecting: boolean }

export interface DiscoveredDevice {
  host: string
  friendlyName: string
  model: string
  udn: string
  descriptionUrl: string
}

// ------------------------------------------------------------------ diagnostics

export interface LogEntry {
  at: number
  level: 'info' | 'warn' | 'error'
  scope: string
  text: string
}

export interface FrameEntry {
  at: number
  dir: 'in' | 'out'
  frame: SmoipFrame
}

// -------------------------------------------------------- main -> renderer push

export type PushMessage =
  | { kind: 'connection'; state: ConnectionState }
  | { kind: 'devices'; devices: DiscoveredDevice[]; discovering: boolean }
  | { kind: 'playState'; data: ZonePlayState }
  | { kind: 'position'; data: ZonePosition }
  | { kind: 'nowPlaying'; data: ZoneNowPlaying }
  | { kind: 'zoneState'; data: ZoneState }
  | { kind: 'queue'; data: QueueList }
  | { kind: 'presets'; data: Presets }
  | { kind: 'systemInfo'; data: SystemInfo }
  | { kind: 'systemPower'; data: SystemPower }
  | { kind: 'sources'; data: SystemSources }
  | { kind: 'frame'; entry: FrameEntry }
  | { kind: 'log'; entry: LogEntry }
  /** Cursor is over the mini window (CSS :hover can't fire over drag regions). */
  | { kind: 'miniHover'; hovered: boolean }

// ------------------------------------------------------ renderer -> main actions

export type StreamerCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'togglePlayback' }
  | { type: 'nextTrack' }
  | { type: 'previousTrack' }
  | { type: 'seek'; positionSecs: number }
  | { type: 'playQueueId'; queueId: number }
  | { type: 'setRepeat'; mode: 'all' | 'off' }
  | { type: 'setShuffle'; mode: 'all' | 'off' }
  | { type: 'recallPreset'; presetId: number }
  | { type: 'power'; power: 'ON' | 'NETWORK' | 'toggle' }
  | { type: 'setMute'; mute: boolean }
  | { type: 'setSource'; sourceId: string }
  | { type: 'setVolumeStep'; step: number }
  | { type: 'setVolumePercent'; percent: number }
  | { type: 'volumeStepChange'; delta: number }
  | { type: 'queueDelete'; id: number }
  | { type: 'queueMove'; id: number; from: number; to: number }
  | { type: 'presetDelete'; presetId: number }
  | { type: 'presetMove'; from: number; to: number }

// ---------------------------------------------------------------------- settings

export type Theme = 'dark' | 'light'
export type AmbientArtMode = 'off' | 'now-playing' | 'all'
export type AmbientCoverage = 'main' | 'window'
export type AlignH = 'left' | 'center' | 'right'
export type AlignV = 'top' | 'center' | 'bottom'

export interface AppSettings {
  lastHost: string | null
  mediaKeys: boolean
  volumeLimitPercent: number | null
  notifications: boolean
  theme: Theme
  /** Blurred album-art backdrop. */
  ambientArt: AmbientArtMode
  /** Backdrop extent: the main content area, or the whole window (nav + bar too). */
  ambientCoverage: AmbientCoverage
  vignette: boolean
  accentFollowsArt: boolean
  /** Preset grid: base card width in px. */
  presetCardSize: number
  /** Preset grid: gap between cards in px. */
  presetGap: number
  /** Preset grid: stretch cards to fill each row (true) or keep them exact-size (false). */
  presetFillRows: boolean
  /** Now Playing content placement. */
  nowPlayingAlignH: AlignH
  nowPlayingAlignV: AlignV
  /** Left nav reduced to icons only. */
  navCollapsed: boolean
  /** Auto-scroll to the current queue row / playing preset. */
  followQueue: boolean
  followPresets: boolean
  /** Remembered mini-player window position. */
  miniBounds: { x: number; y: number } | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  lastHost: null,
  mediaKeys: true,
  volumeLimitPercent: null,
  notifications: true,
  theme: 'dark',
  ambientArt: 'now-playing',
  ambientCoverage: 'window',
  vignette: true,
  accentFollowsArt: true,
  presetCardSize: 160,
  presetGap: 12,
  presetFillRows: true,
  nowPlayingAlignH: 'left',
  nowPlayingAlignV: 'center',
  navCollapsed: false,
  followQueue: true,
  followPresets: false,
  miniBounds: null
}

// -------------------------------------------------------------- boot-time snapshot

export interface Snapshot {
  connection: ConnectionState
  devices: DiscoveredDevice[]
  discovering: boolean
  settings: AppSettings
  playState: ZonePlayState | null
  position: ZonePosition | null
  nowPlaying: ZoneNowPlaying | null
  zoneState: ZoneState | null
  queue: QueueList | null
  presets: Presets | null
  systemInfo: SystemInfo | null
  systemPower: SystemPower | null
  sources: SystemSources | null
  frames: FrameEntry[]
  logs: LogEntry[]
}

// ------------------------------------------------------------------- preload API

export interface TastyTunesApi {
  getSnapshot(): Promise<Snapshot>
  discover(): Promise<DiscoveredDevice[]>
  connect(host: string): Promise<void>
  disconnect(): Promise<void>
  command(cmd: StreamerCommand): Promise<void>
  openExternal(url: string): Promise<void>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** Fetch album art via the main process (bypasses CORS) as a data URL. */
  fetchArt(url: string): Promise<{ dataUrl: string } | null>
  /** Open/close the mini player window. */
  toggleMini(): Promise<void>
  /** Show and focus the main window. */
  showMain(): Promise<void>
  onPush(cb: (msg: PushMessage) => void): () => void
}

export const IPC = {
  getSnapshot: 'tt:getSnapshot',
  discover: 'tt:discover',
  connect: 'tt:connect',
  disconnect: 'tt:disconnect',
  command: 'tt:command',
  openExternal: 'tt:openExternal',
  getSettings: 'tt:getSettings',
  setSettings: 'tt:setSettings',
  fetchArt: 'tt:fetchArt',
  toggleMini: 'tt:toggleMini',
  showMain: 'tt:showMain',
  push: 'tt:push'
} as const
