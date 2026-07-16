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

// --------------------------------------------------------------- recently played

/**
 * One entry in the local recently-played log. The streamer keeps no history, so
 * the main process records each track it sees pass through /zone/play_state.
 * A bounded convenience log — explicitly not a database.
 */
export interface RecentTrack {
  /** When the track first appeared (ms epoch). */
  at: number
  /** Song title. Null for a songless state (radio that emits no song, or echoes its own name). */
  title: string | null
  artist: string | null
  album: string | null
  /** Set for internet radio — the station name (title then carries the song). */
  station: string | null
  artUrl: string | null
  /** Human source label (e.g. "Media Library", "AirPlay"), best-effort. */
  source: string | null
  /** SMOIP source id (e.g. "AIRPLAY", "IR", "MEDIA_PLAYER") — lets a row re-activate the source. */
  sourceId: string | null
  /** Queue item id at record time — lets a local row replay the track if it's still queued. */
  queueId: number | null
  isRadio: boolean
  /** Airable radio id, if any — used to match a station back to a preset for re-tuning. */
  radioId: number | null
  /**
   * Grouping key for continuous sessions. `radio:<station>` or `src:<sourceId>` for
   * sources whose now-playing song changes over one continuous session; null for a
   * discrete queued track, which never groups. Optional so pre-upgrade logs still load.
   */
  session: string | null
}

/**
 * Does a recently-played entry describe what /zone/play_state currently
 * reports? Mirrors the recording normalization in main/recents.ts (title-keyed;
 * a radio "song" that's absent or just echoes the station name is null), so the
 * Recently Played screen can mark its head entry live without drifting from how
 * entries were written.
 */
export function recentMatchesPlayState(e: RecentTrack, ps: ZonePlayState | null): boolean {
  const md = ps?.metadata
  if (!md) return false
  const eq = (a: string | null | undefined, b: string | null | undefined): boolean =>
    (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
  const isRadio = /radio/i.test(md.class ?? '') || md.station != null
  if (e.isRadio !== isRadio) return false
  if (isRadio) {
    const title = md.title != null && md.station != null && eq(md.title, md.station) ? null : (md.title ?? null)
    return eq(e.station, md.station) && eq(e.title, title)
  }
  return e.title != null && eq(e.title, md.title)
}

// -------------------------------------------------------- main -> renderer push

/**
 * An application-menu click that must run in the renderer. Sent to the main
 * window only (never the mini player); `screen` values are renderer Screen ids.
 */
export type MenuCommand =
  | { id: 'about' }
  | { id: 'palette' }
  | { id: 'shortcuts' }
  | { id: 'displayMode' }
  | { id: 'toggleNav' }
  | { id: 'screen'; screen: string }

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
  | { kind: 'recents'; data: RecentTrack[] }
  /** Cursor is over the mini window (CSS :hover can't fire over drag regions). */
  | { kind: 'miniHover'; hovered: boolean }
  | { kind: 'sleep'; sleep: SleepTimer | null }
  | { kind: 'mcpStatus'; status: McpStatus }
  | { kind: 'menu'; command: MenuCommand }
  | { kind: 'update'; update: UpdateInfo }

/** A newer GitHub release than the running version (stage-1 update awareness). */
export interface UpdateInfo {
  /** Bare version, no leading v. */
  version: string
  /** Release page to open in the browser. */
  url: string
}

// ------------------------------------------------------------------- lyrics

export interface LyricsQuery {
  artist: string
  title: string
  album: string | null
  /** Track length in seconds, if known — LRCLIB uses it for exact matching. */
  duration: number | null
}

export interface LyricsResult {
  plain: string | null
  /** LRC-format synced lyrics ("[mm:ss.xx] line"), when the record has them. */
  synced: string | null
  instrumental: boolean
}

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

// ------------------------------------------------------------------- MCP server

/** Which interface the MCP server binds to. */
export type McpBind = 'localhost' | 'lan'

export interface McpSettings {
  /** Master switch — the server only exists while this is on. */
  enabled: boolean
  /** localhost = this computer only; lan = any machine on the network. */
  bind: McpBind
  port: number
  /** Cluster ids switched off (everything is on by default). */
  disabledClusters: string[]
  /** Individual tool names switched off. */
  disabledTools: string[]
}

export interface McpStatus {
  running: boolean
  /** Reachable endpoint while running, e.g. http://192.168.1.20:8555/mcp. */
  url: string | null
  error: string | null
}

export interface McpToolInfo {
  name: string
  title: string
  /** Written for the agent reading tools/list — precise beats promotional. */
  description: string
}

export interface McpClusterInfo {
  id: string
  title: string
  /** Written for the human toggling clusters in Settings. */
  description: string
  readOnly?: boolean
  tools: McpToolInfo[]
}

/**
 * Everything the MCP server can expose — shared so the Settings screen and the
 * server agree exactly. Schemas and handlers live in main (mcpServer.ts);
 * enable/disable state lives in settings.mcp.
 */
export const MCP_CLUSTERS: McpClusterInfo[] = [
  {
    id: 'status',
    title: 'Status & lists',
    description: 'Read-only: what is playing, the queue, presets, sources, devices, history.',
    readOnly: true,
    tools: [
      {
        name: 'get_status',
        title: 'Get status',
        description:
          'One combined snapshot: connection and device, power state, active source, what is playing (title/artist/album/station, format, position/duration), volume and mute, shuffle/repeat, queue position, and any armed sleep timer. Call this first.'
      },
      {
        name: 'list_queue',
        title: 'List queue',
        description:
          'The play queue: id, position, title, artist, album, and duration per track, plus which id is current.'
      },
      {
        name: 'list_presets',
        title: 'List presets',
        description:
          'The device presets (numbered slots for stations and albums): id, name, kind, and whether one is currently playing.'
      },
      {
        name: 'list_sources',
        title: 'List sources',
        description: 'Audio sources (media player, internet radio, USB, Bluetooth, …) and which is active.'
      },
      {
        name: 'list_devices',
        title: 'List devices',
        description: 'StreamMagic streamers known on the network and which one is connected.'
      },
      {
        name: 'list_recently_played',
        title: 'List recently played',
        description: 'Local history of tracks and stations that have played, newest first.'
      }
    ]
  },
  {
    id: 'transport',
    title: 'Transport',
    description: 'Play, pause, skip, seek, queue jumps, shuffle and repeat.',
    tools: [
      { name: 'play', title: 'Play', description: 'Start or resume playback.' },
      { name: 'pause', title: 'Pause', description: 'Pause playback.' },
      { name: 'stop', title: 'Stop', description: 'Stop playback (mainly internet radio).' },
      { name: 'next_track', title: 'Next track', description: 'Skip to the next track.' },
      { name: 'previous_track', title: 'Previous track', description: 'Go back to the previous track.' },
      {
        name: 'seek',
        title: 'Seek',
        description: 'Jump to a position (seconds) in the current track.'
      },
      {
        name: 'play_queue_item',
        title: 'Play queue item',
        description: 'Jump to a specific track in the queue by its id (see list_queue).'
      },
      { name: 'set_shuffle', title: 'Set shuffle', description: 'Turn shuffle on or off.' },
      { name: 'set_repeat', title: 'Set repeat', description: 'Turn repeat-all on or off.' }
    ]
  },
  {
    id: 'volume',
    title: 'Volume',
    description: 'Absolute volume, relative nudges, and mute.',
    tools: [
      {
        name: 'set_volume',
        title: 'Set volume',
        description:
          'Set volume to an absolute percent (0–100). Respects the volume limit configured in the app.'
      },
      {
        name: 'change_volume',
        title: 'Change volume',
        description: 'Nudge volume up or down by a number of steps (positive or negative).'
      },
      { name: 'set_mute', title: 'Set mute', description: 'Mute or unmute.' }
    ]
  },
  {
    id: 'presets',
    title: 'Presets',
    description: 'Recall a numbered preset (station or album).',
    tools: [
      {
        name: 'recall_preset',
        title: 'Recall preset',
        description: 'Recall a preset by its id (see list_presets for names).'
      }
    ]
  },
  {
    id: 'sources',
    title: 'Sources',
    description: 'Switch the active audio source.',
    tools: [
      {
        name: 'set_source',
        title: 'Set source',
        description: 'Switch to a source by its id (see list_sources).'
      }
    ]
  },
  {
    id: 'power',
    title: 'Power',
    description: 'Wake the streamer or send it to network standby.',
    tools: [
      {
        name: 'set_power',
        title: 'Set power',
        description:
          "'on' wakes the streamer; 'standby' stops playback and puts it into network standby (it stays reachable)."
      }
    ]
  },
  {
    id: 'devices',
    title: 'Devices',
    description: 'Switch which streamer the app controls.',
    tools: [
      {
        name: 'connect_device',
        title: 'Connect device',
        description: 'Connect to a different streamer by host/IP (see list_devices).'
      }
    ]
  },
  {
    id: 'sleep',
    title: 'Sleep timer',
    description: 'Arm or cancel the sleep timer.',
    tools: [
      {
        name: 'set_sleep_timer',
        title: 'Set sleep timer',
        description:
          "Arm the sleep timer: either minutes from now, or at the end of the current track. Action is 'pause' or 'standby' (defaults to the user's configured choice)."
      },
      { name: 'cancel_sleep_timer', title: 'Cancel sleep timer', description: 'Clear any armed sleep timer.' }
    ]
  }
]

// ------------------------------------------------------------------- sleep timer

/** What the sleep timer does when it expires. */
export type SleepAction = 'pause' | 'standby'

/**
 * A live sleep timer. Ephemeral by design — a countdown shouldn't survive a
 * restart. Owned by the main process (so it outlives the window on macOS);
 * renderers arm/disarm via setSleep and mirror state from pushes.
 * `minutes: null` means "end of the current track", in which case `trackKey`
 * is the armed track's identity and `firesAt` is unused.
 */
export interface SleepTimer {
  action: SleepAction
  minutes: number | null
  firesAt: number | null
  trackKey: string | null
}

/**
 * Identity of the currently-playing track, used to detect the boundary for an
 * "end of track" sleep timer. Queue playback gives a stable per-item id; other
 * sources (AirPlay, USB) fall back to title/artist. Null when nothing
 * identifiable is playing. Shared so the arming renderer and the firing main
 * process can never disagree.
 */
export function sleepTrackKey(ps: ZonePlayState | null): string | null {
  if (!ps) return null
  if (ps.queue_id != null) return `q${ps.queue_id}`
  const md = ps.metadata
  if (md?.title) return `t:${md.title}:${md.artist ?? ''}`
  return null
}

// ---------------------------------------------------------------------- settings

export type Theme = 'dark' | 'light'
/** Stored preference: an explicit theme, or follow the OS. */
export type ThemePreference = Theme | 'system'
/** How a collection screen lays out its items. */
export type ScreenLayout = 'rows' | 'cards'
/** Motion effects: follow the OS Reduce Motion setting, or force on/off. */
export type MotionMode = 'system' | 'on' | 'off'
export type AmbientArtMode = 'off' | 'now-playing' | 'all'
export type AmbientCoverage = 'main' | 'window'
export type AlignH = 'left' | 'center' | 'right'
export type AlignV = 'top' | 'center' | 'bottom'

export interface AppSettings {
  lastHost: string | null
  mediaKeys: boolean
  volumeLimitPercent: number | null
  notifications: boolean
  theme: ThemePreference
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
  /** Per-screen cards ⇄ rows layout. Card sizing shares the presetCard* settings. */
  queueLayout: ScreenLayout
  presetsLayout: ScreenLayout
  /** Remembered sleep-timer action (pause vs standby). The countdown itself is not persisted. */
  sleepAction: SleepAction
  /** Recently Played: collapse continuous sessions (radio/AirPlay/…) to one row, vs a row per song. */
  recentsGrouped: boolean
  /** Motion effects (hover growth, eqbars, smooth scrolling). */
  motion: MotionMode
  /** Check GitHub releases for a newer version on launch and every few hours. */
  updateCheck: boolean
  /** Lyrics panel on Now Playing — fetches from LRCLIB on demand when opened. */
  lyrics: boolean
  /** Inline flavor: current synced line under the Now Playing track details. */
  lyricsLine: boolean
  /** MCP server for local AI agents. */
  mcp: McpSettings
  /** Last-visited Settings tab (id from the Settings screen's tab rail). */
  settingsTab: string
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
  accentFollowsArt: false,
  presetCardSize: 160,
  presetGap: 12,
  presetFillRows: true,
  nowPlayingAlignH: 'left',
  nowPlayingAlignV: 'center',
  navCollapsed: false,
  followQueue: true,
  followPresets: false,
  queueLayout: 'rows',
  presetsLayout: 'cards',
  sleepAction: 'standby',
  recentsGrouped: true,
  motion: 'system',
  updateCheck: true,
  lyrics: false,
  lyricsLine: true,
  mcp: { enabled: false, bind: 'localhost', port: 8555, disabledClusters: [], disabledTools: [] },
  settingsTab: 'appearance',
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
  sleep: SleepTimer | null
  recents: RecentTrack[]
  mcpStatus: McpStatus
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
  /** Look up lyrics via LRCLIB (main process, in-memory cached; null = not found). */
  fetchLyrics(query: LyricsQuery): Promise<LyricsResult | null>
  /** Open/close the mini player window. */
  toggleMini(): Promise<void>
  /** Show and focus the main window. */
  showMain(): Promise<void>
  /** Arm or clear the sleep timer (lives in the main process). */
  setSleep(sleep: SleepTimer | null): Promise<void>
  /** The local recently-played log, newest first. */
  getRecents(): Promise<RecentTrack[]>
  /** Wipe the recently-played log. */
  clearRecents(): Promise<void>
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
  fetchLyrics: 'tt:fetchLyrics',
  toggleMini: 'tt:toggleMini',
  showMain: 'tt:showMain',
  setSleep: 'tt:setSleep',
  getRecents: 'tt:getRecents',
  clearRecents: 'tt:clearRecents',
  push: 'tt:push'
} as const
