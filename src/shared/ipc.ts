// The typed contract between main, preload, and renderer: what may be said,
// on which channel, in which direction.
//
// Two neighbours split out of here 2026-07-26, when this file had grown to
// ~1,600 lines and a contract change meant reading past a 490-line tool
// catalogue to find it:
//   · model.ts      — the app's own domain (recents, favorites, playlists) and
//                     the content-identity helpers. This file imports FROM it;
//                     it must never import back, so the contract stays free of
//                     domain churn.
//   · mcpCatalog.ts — the MCP tool catalogue. It imports McpSettings from here
//                     (a type-only edge, erased at build), which is the one
//                     place the arrow points the other way.
// smoip.ts is a different axis entirely — the STREAMER's wire types, which all
// three of these read and none of them own.

import type {
  Presets,
  QueueList,
  SmoipFrame,
  SystemInfo,
  SystemPower,
  SystemSources,
  SystemDisplay,
  SystemDisplaySpec,
  SystemPowerSpec,
  ZoneAudio,
  ZoneAudioSpec,
  ZoneNowPlaying,
  ZonePlayState,
  ZonePosition,
  ZoneState
} from './smoip'
import type {
  ContentRef,
  Favorite,
  Playlist,
  PlaylistActivation,
  PlaylistItem,
  QueueRestoreResult,
  RecentTrack
} from './model'

/** The one copy of the project URL — user agents, Help menu, release pages. */
export const REPO_URL = 'https://github.com/mjoblin/tastytunes'

// ------------------------------------------------------------------- connection

export type ConnectionState =
  | { phase: 'idle' }
  | { phase: 'connecting'; host: string; attempt: number; demo?: boolean }
  | { phase: 'connected'; host: string; demo?: boolean }
  | { phase: 'disconnected'; host: string; reason: string; reconnecting: boolean; demo?: boolean }

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

// The recently-played log, favorites and playlists — the app's own domain —
// moved to model.ts (2026-07-26). They are named all over this contract; they
// are just no longer DEFINED here.

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
  | { kind: 'firmwareUpdate'; data: FirmwareStatus }
  | { kind: 'sources'; data: SystemSources }
  | { kind: 'zoneAudio'; data: ZoneAudio | null }
  | { kind: 'audioSpec'; data: ZoneAudioSpec | null }
  | { kind: 'systemDisplay'; data: SystemDisplay | null }
  | { kind: 'displaySpec'; data: SystemDisplaySpec | null }
  | { kind: 'powerSpec'; data: SystemPowerSpec | null }
  | { kind: 'favorites'; data: Favorite[] }
  | { kind: 'playlists'; data: Playlist[] }
  | { kind: 'playlistActivation'; state: PlaylistActivation | null }
  | { kind: 'frame'; entry: FrameEntry }
  | { kind: 'log'; entry: LogEntry }
  | { kind: 'recents'; data: RecentTrack[] }
  /** Settings changed OUTSIDE the renderer (e.g. an MCP tool created a schedule). */
  | { kind: 'settings'; settings: AppSettings }
  /** Wake-on-intent in flight: a play-shaped command is waking the streamer. */
  | { kind: 'waking'; waking: boolean }
  /** Cursor is over the mini window (CSS :hover can't fire over drag regions). */
  | { kind: 'miniHover'; hovered: boolean }
  | { kind: 'sleep'; sleep: SleepTimer | null }
  | { kind: 'recalledPreset'; id: number | null }
  | { kind: 'mcpStatus'; status: McpStatus }
  | { kind: 'mediaIndex'; statuses: MediaIndexStatus[] }
  | { kind: 'menu'; command: MenuCommand }
  | { kind: 'updateState'; state: UpdateState }
  /** Sent when a request starts (pending) and again when it settles — upsert by id. */
  | { kind: 'netRequest'; entry: NetRequestEntry }

/** A newer GitHub release than the running version (stage-1 update awareness). */
export interface UpdateInfo {
  /** Bare version, no leading v. */
  version: string
  /** Release page to open in the browser. */
  url: string
}

/**
 * The self-update consent flow (Sparkle-style). Nothing downloads or installs
 * without an explicit user action at each step:
 * idle → available —[user: Download]→ downloading → downloaded —[user: Restart
 * now, or silently on next quit]→ installed. `canDownload` is false in
 * unpackaged/dev builds, where "available" only offers the release page.
 */
export interface UpdateState {
  phase: 'idle' | 'available' | 'downloading' | 'downloaded' | 'error'
  /** Version on offer (bare, no leading v); null while idle. */
  version: string | null
  /** Download progress 0–100 while downloading. */
  percent: number | null
  /** In-app download/install possible (packaged build with a release feed). */
  canDownload: boolean
  /** Release page — always available as the manual path. */
  url: string
  /** Human-readable failure when phase === 'error'. */
  error: string | null
}

/**
 * Outcome of a user-initiated release check (the Updates tab's Check now
 * button). 'update' also lands through the normal updateState push — the
 * result exists so the UI can say "nothing new" or show the failure.
 */
export type UpdateCheckResult =
  | { status: 'update'; version: string }
  | { status: 'none' }
  | { status: 'error'; error: string }

/**
 * Streamer FIRMWARE status, camelCased from the read-only /system/update push
 * (raw SystemUpdate in smoip.ts). Distinct from UpdateState above, which is the
 * APP's own self-update flow. PASSIVE ONLY — the streamer reports its own
 * self-check; TastyTunes surfaces it but never triggers a check or an install
 * (that stays the user's job via the Cambridge Audio app or the streamer's web
 * admin). There is deliberately no command to change any of this.
 */
export interface FirmwareStatus {
  updateAvailable: boolean
  updating: boolean
  earlyUpdate: boolean
}

// ------------------------------------------------------------ requests console

/** One outbound HTTP request from the main process, for the diagnostics drawer. */
export interface NetRequestEntry {
  id: number
  at: number
  /** Short service tag: lrclib, musicbrainz, wikidata, wikipedia, listenbrainz, github, art. */
  service: string
  method: string
  url: string
  /** HTTP status once a response arrived; null while pending. */
  status: number | null
  /** Round-trip ms once settled; null while pending. */
  ms: number | null
  /** Transport failure — no response at all (DNS, timeout, refused). */
  error: boolean
}

// ----------------------------------------------------------- scheduled actions

/**
 * A BluOS-style alarm, executed by the main process while the app runs:
 * wake (power ON, optionally recall a preset and set a volume) or standby.
 */
export interface Schedule {
  id: string
  enabled: boolean
  /** Local 24h "HH:MM". */
  time: string
  /** Days it fires: 0 = Sunday … 6 = Saturday. Empty = never. */
  days: number[]
  action: 'on' | 'standby'
  /** Wake only: preset to recall after powering on. */
  presetId: number | null
  /** Wake only: volume to set after the preset settles. */
  volumePercent: number | null
}

/** Cache key for a preset volume override — device-scoped so ids don't collide. */
export function presetVolumeKey(udn: string | null | undefined, presetId: number): string {
  return `${udn ?? 'device'}|${presetId}`
}

// ------------------------------------------------------------- artist context

export interface ArtistInfo {
  /** MusicBrainz's canonical name for the matched artist. */
  name: string
  /** Wikipedia summary extract, when the chain resolved one. */
  summary: string | null
  wikipediaUrl: string | null
  musicbrainzUrl: string | null
}

export interface AlbumInfo {
  /** MusicBrainz's canonical title for the matched release group. */
  title: string
  /** Year of first release, e.g. "2011". */
  year: string | null
  /** Release-group primary type, e.g. "Album", "EP". */
  type: string | null
  /** Label of the earliest release, when known. */
  label: string | null
  /** MusicBrainz genre tags, most-voted first. */
  genres: string[]
  /** Release-level relationship credits (producer etc.), when MB has them. */
  credits: Array<{ role: string; name: string }>
  /** Wikipedia summary extract, when the chain resolved one. */
  summary: string | null
  wikipediaUrl: string | null
  musicbrainzUrl: string | null
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
  /** skipVolume: a schedule bringing its own volume mutes the preset's override. */
  | { type: 'recallPreset'; presetId: number; skipVolume?: boolean }
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
  /** Rename an existing preset (lets album saves carry a custom name). */
  | { type: 'presetRename'; slot: number; name: string }
  /** Play an internet-radio stream by direct URL (/stream/radio — url+name both required). */
  | { type: 'streamRadio'; url: string; name: string }
  /** Save the CURRENT playback to a preset slot (/zone/save_preset — the
   *  "save what's playing" verb; track-level for media, the natural verb for radio). */
  | { type: 'zoneSavePreset'; slot: number }
  /** Snapshot the current queue into a device preset (type MediaQueue).
   *  null slot = firmware picks the next free one; null name = firmware default. */
  | { type: 'queueSavePreset'; slot: number | null; name: string | null }
  // ---- /zone/audio tone controls (feature-detected via audioCaps; writes are
  // ---- ATOMIC on the firmware, so each command is exactly one logical control)
  /** Master EQ enable — boolean ON WRITE (the read returns an object). */
  | { type: 'setUserEq'; enabled: boolean }
  /** One band's gain, dB (clamped to EQ_GAIN_MIN..MAX) — a slider release. */
  | { type: 'setEqBandGain'; index: number; gain: number }
  /** All 7 gains in one frame — the "Flat" reset (official-app preset shape). */
  | { type: 'setEqBands'; gains: number[] }
  | { type: 'setTiltEq'; enabled: boolean }
  | { type: 'setTiltIntensity'; intensity: number }
  | { type: 'setBalance'; balance: number }
  // ---- §10 device controls (feature-detected via the /spec probes)
  /** Front-panel brightness: off | dim | bright. */
  | { type: 'setBrightness'; brightness: string }
  /** Standby the unit drops into: ECO_MODE | NETWORK. */
  | { type: 'setStandbyMode'; mode: string }
  /** Idle seconds before auto power-down; 0 = never. */
  | { type: 'setAutoPowerDown'; seconds: number }

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
  /** Opt-in cluster ids the user explicitly enabled (write-capable clusters
   *  are OFF until they appear here). */
  enabledClusters: string[]
  /** Individual tool names switched off. */
  disabledTools: string[]
}

export interface McpStatus {
  running: boolean
  /** Reachable endpoint while running, e.g. http://192.168.1.20:8555/mcp. */
  url: string | null
  error: string | null
}

// The CATALOG — MCP_CLUSTERS, McpClusterInfo, McpToolInfo, mcpClusterEnabled —
// lives in mcpCatalog.ts (2026-07-26). What the server is configured WITH stays
// here (it is part of AppSettings); what it OFFERS is the catalog's business.

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

/** The display face ("money font") — a curated, bundled set. The array is the
 *  single source of truth for valid ids (persist.ts coerces unknown values to
 *  the default; the renderer builds its labelled picker from the same ids). */
export const DISPLAY_FONT_IDS = [
  'fraunces',
  'unbounded',
  'newsreader',
  'hanken',
  'instrument-serif',
  'schibsted',
  'instrument-sans'
] as const
export type DisplayFont = (typeof DISPLAY_FONT_IDS)[number]
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
  displayFont: DisplayFont
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
  /**
   * Screens hidden from the left nav. A hide-set (not a visible-list) so
   * screens added in future app versions default to visible. Persisted as
   * plain ids; the renderer sanitizes on use (drops unknown ids, never hides
   * 'now-playing'). Nav-only — hidden screens stay fully reachable via their
   * keyboard shortcut and the command palette.
   */
  navHidden: string[]
  /**
   * Nav tools hidden from the left nav's pinned bottom cluster (Commands,
   * Mini player). A hide-set (not a visible-list) so tools added in future app
   * versions default to visible. Persisted as plain ids; the renderer sanitizes
   * on use (drops unknown ids). Separate from navHidden — tool ids and screen
   * ids are different id-spaces. Nav-only: Commands stays on the palette
   * shortcut, the mini player stays in the palette and the View menu.
   */
  navHiddenTools: string[]
  /** Auto-scroll to the current queue row / playing preset. */
  followQueue: boolean
  followPresets: boolean
  /** Per-screen cards ⇄ rows layout. Card sizing shares the presetCard* settings. */
  queueLayout: ScreenLayout
  presetsLayout: ScreenLayout
  libraryLayout: ScreenLayout
  /** Album-grid sort in the Library (tracks always sort by track number). */
  librarySort: 'server' | 'title' | 'artist' | 'year'
  librarySortReversed: boolean
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
  /** Current synced line in full-screen display mode (toggled from its chrome). */
  displayLyrics: boolean
  /** Scrobble listens to ListenBrainz (needs a user token; radio is never scrobbled). */
  lbEnabled: boolean
  /** ListenBrainz user token, from listenbrainz.org/settings. Stored locally. */
  lbToken: string
  /** Artist bio panel on Now Playing (MusicBrainz + Wikipedia, on demand). */
  artistInfo: boolean
  /**
   * Look stations up in the radio-browser.info directory. OFF means the app
   * never contacts it — not from the Radio screen, not from unified search,
   * not from an agent. Favorited stations still play: a favorite carries its
   * own stream URL and needs no directory at all.
   */
  radioDirectory: boolean
  /** Scheduled actions (alarms) — fire only while the app is running. */
  schedules: Schedule[]
  /**
   * Per-preset volume overrides (feature 10): recalling the preset through
   * TastyTunes also sets this volume. Keyed via presetVolumeKey (device udn +
   * preset id) so multi-streamer homes never cross-apply.
   */
  presetVolumes: Record<string, number>
  /**
   * queueContentHash of the queue at save time for queue presets saved
   * through this app, keyed via presetVolumeKey(udn, slot). Lets the
   * Presets screen recognize a saved queue exactly (all tracks, in order)
   * even when the recall happened elsewhere or before this launch. Local to
   * this machine; presets saved by other controllers have no entry and fall
   * back to collage-fingerprint matching.
   */
  queueSignatures: Record<string, string>
  /** MCP server for local AI agents. */
  mcp: McpSettings
  /** Last-visited Settings tab (id from the Settings screen's tab rail). */
  /** Media indexes build/rebuild themselves (off = only from the Libraries buttons). */
  mediaIndexAuto: boolean
  settingsTab: string
  /** Last-selected diagnostics-drawer tab (smoip | requests). */
  diagnosticsTab: string
  /** Last-selected Device-screen tab (tabs appear only on tone-capable streamers). */
  deviceTab: 'streamer' | 'sources' | 'tone'
  /** Width (px) of the Now Playing drawers (lyrics/artist), drag-resizable. */
  panelWidth: number
  /** Remembered mini-player window position. */
  miniBounds: { x: number; y: number } | null
  /** Remembered main-window bounds — reopened at this size/position. */
  mainBounds: { x: number; y: number; width: number; height: number } | null
  /**
   * Artist per device preset, keyed by presetVolumeKey(udn, presetId) —
   * recorded when TastyTunes saves an album/track preset from the Library.
   * LOCAL-ONLY: /presets/list carries NO artist field and firmware-derived
   * names are just the album title, so this is what lets the Presets filter
   * match "iron" against an Iron Maiden album preset. Presets saved by other
   * controllers have no entry (nothing to record from). Same lifecycle trade
   * as presetVolumes: entries are keyed by slot and not remapped on
   * move/delete.
   */
  presetArtists: Record<string, string>
  /**
   * User-saved EQ gain-sets (7 gains, dB). LOCAL by design: the firmware has
   * no preset storage — the official app's EQ presets are client-side too
   * (confirmed on the wire: tapping/saving one produces zero device traffic),
   * so its presets and ours can't see each other. Applying = one multi-band
   * user_eq_bands frame.
   */
  eqPresets: Array<{ name: string; gains: number[] }>
}

export const DEFAULT_SETTINGS: AppSettings = {
  lastHost: null,
  mediaKeys: true,
  volumeLimitPercent: null,
  notifications: true,
  theme: 'dark',
  displayFont: 'fraunces',
  ambientArt: 'all',
  ambientCoverage: 'window',
  vignette: true,
  accentFollowsArt: false,
  presetCardSize: 160,
  presetGap: 12,
  presetFillRows: true,
  nowPlayingAlignH: 'left',
  nowPlayingAlignV: 'center',
  navCollapsed: false,
  navHidden: [],
  navHiddenTools: [],
  followQueue: true,
  followPresets: false,
  queueLayout: 'rows',
  presetsLayout: 'cards',
  libraryLayout: 'cards',
  librarySort: 'server',
  librarySortReversed: false,
  sleepAction: 'standby',
  recentsGrouped: true,
  motion: 'system',
  updateCheck: true,
  lyrics: true,
  lyricsLine: true,
  displayLyrics: true,
  lbEnabled: false,
  lbToken: '',
  artistInfo: true,
  radioDirectory: true,
  schedules: [],
  presetVolumes: {},
  queueSignatures: {},
  mcp: {
    enabled: false,
    bind: 'localhost',
    port: 8555,
    disabledClusters: [],
    enabledClusters: [],
    disabledTools: []
  },
  mediaIndexAuto: true,
  settingsTab: 'appearance',
  diagnosticsTab: 'smoip',
  deviceTab: 'streamer',
  panelWidth: 400,
  miniBounds: null,
  mainBounds: null,
  presetArtists: {},
  eqPresets: []
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
  firmwareUpdate: FirmwareStatus | null
  sources: SystemSources | null
  /** Tone/EQ state (/zone/audio) — null when the streamer doesn't push it. */
  zoneAudio: ZoneAudio | null
  /** Tone/EQ capability spec, probed over HTTP at connect; null = no tone controls. */
  audioSpec: ZoneAudioSpec | null
  /** Front-panel display state (/system/display); null on headless models. */
  systemDisplay: SystemDisplay | null
  /** Display + power capability specs, probed at connect. */
  displaySpec: SystemDisplaySpec | null
  powerSpec: SystemPowerSpec | null
  sleep: SleepTimer | null
  /**
   * The preset most recently recalled THROUGH THIS APP (renderer, palette,
   * MCP, schedules) — the firmware keeps no recall state at all (verified
   * live), so this is the only "which preset did I pick" signal. Null on
   * startup and after device switches; consumers must content-check it
   * against what's actually playing before trusting it.
   */
  lastRecalledPresetId: number | null
  recents: RecentTrack[]
  /** Local favorites (stations, albums, tracks), newest-hearted first. */
  favorites: Favorite[]
  /** Stored playlists, newest-updated first. */
  playlists: Playlist[]
  /** An activation in flight, so a window opened or reloaded mid-run shows it
   *  rather than a stale idle button (the did-finish-load rule). */
  playlistActivation: PlaylistActivation | null
  mcpStatus: McpStatus
  /** Local media-index state per known server. */
  mediaIndex: MediaIndexStatus[]
  frames: FrameEntry[]
  logs: LogEntry[]
  netRequests: NetRequestEntry[]
}

// ------------------------------------------------------------------ media browser

export interface MediaServerInfo {
  udn: string
  name: string
  model: string | null
  /** True when this "server" is the connected streamer itself (USB storage). */
  isStreamer: boolean
  /** True when the server answers ContentDirectory Search (non-empty SearchCaps). */
  searchable: boolean
}

/**
 * Per-server state of the local media index — a REBUILDABLE CACHE of server
 * metadata (never user data): built by crawling ContentDirectory, invalidated
 * wholesale when the server's SystemUpdateID moves (or a TTL passes), gone
 * without loss if deleted. Searchable servers crawl via paged Search
 * (seconds); Browse-only servers build on demand by walking containers.
 */
export interface MediaIndexStatus {
  udn: string
  serverName: string
  state: 'none' | 'building' | 'ready'
  strategy: 'search' | 'browse' | null
  tracks: number
  albums: number
  artists: number
  builtAt: number | null
  updateId: number | null
}

export interface MediaNode {
  id: string
  parentId: string | null
  title: string
  upnpClass: string
  isContainer: boolean
  artUrl: string | null
  artist: string | null
  album: string | null
  /** Release year, when the server sends dc:date (Asset does; the USB server doesn't). */
  year: string | null
  trackNumber: number | null
  durationSecs: number | null
  /**
   * upnp:genre values, when the server sends any (multi-valued — real tags
   * repeat the element). Raw tagger data: case-normalize before faceting.
   * Absent (not empty) when the server offers none.
   */
  genre?: string[]
  /**
   * Which server this node came from — stamped ONLY on cross-server search
   * results, where nodes from several servers share a listing. Everywhere
   * else the screen's own server context applies and these stay absent.
   */
  serverUdn?: string
  serverName?: string
}

/** One server's slice of a cross-server (all ready indexes) search. */
export interface MediaSearchAllGroup {
  udn: string
  serverName: string
  /** Matches, each stamped with serverUdn/serverName. */
  items: MediaNode[]
  total: number
}

/** One READY index's full pools, nodes stamped — the library lenses' feedstock. */
export interface MediaIndexPools {
  udn: string
  serverName: string
  albums: MediaNode[]
  artists: MediaNode[]
  tracks: MediaNode[]
}

/** Queue-write verbs of /smoip/queue/add (semantics per vibin's reverse-engineering). */
export type MediaQueueAction = 'REPLACE' | 'APPEND' | 'PLAY_NEXT' | 'PLAY_NOW' | 'PLAY_FROM_HERE'

// ------------------------------------------------------------------ internet radio

/** A station from the radio-browser.info community directory (main-process lookup). */
export interface RadioStation {
  uuid: string
  name: string
  /** The playable stream URL (radio-browser's url_resolved — playlists unwrapped). */
  url: string
  favicon: string | null
  homepage: string | null
  /** Comma-separated tag list as the directory provides it. */
  tags: string
  country: string
  codec: string
  /** kbps; 0 = unknown. */
  bitrate: number
}

// ------------------------------------------------------------------- preload API

export interface TastyTunesApi {
  getSnapshot(): Promise<Snapshot>
  discover(): Promise<DiscoveredDevice[]>
  connect(host: string): Promise<void>
  disconnect(): Promise<void>
  /** Start the built-in demo device and connect to it ("Try without a streamer"). */
  demoStart(): Promise<void>
  command(cmd: StreamerCommand): Promise<void>
  openExternal(url: string): Promise<void>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** Fetch album art via the main process (bypasses CORS) as a data URL. */
  fetchArt(url: string): Promise<{ dataUrl: string } | null>
  /** Look up lyrics via LRCLIB (main process, in-memory cached; null = not found).
   *  `force` bypasses the cache read — the user-driven refresh. */
  fetchLyrics(query: LyricsQuery, force?: boolean): Promise<LyricsResult | null>
  /** Check the saved ListenBrainz token (null = network failure, not a verdict). */
  lbValidate(): Promise<{ valid: boolean; userName: string | null } | null>
  /** Consent step 1: start downloading the offered update. */
  updateDownload(): Promise<void>
  /** Consent step 2: restart into the downloaded update now. */
  updateInstall(): Promise<void>
  /** User-initiated release check (works with automatic checks off). */
  updateCheckNow(): Promise<UpdateCheckResult>
  /** Artist bio via MusicBrainz + Wikipedia (main process, cached; null = no match).
   *  `force` bypasses the cache read — the user-driven refresh. */
  fetchArtistInfo(artist: string, force?: boolean): Promise<ArtistInfo | null>
  /** Album details via MusicBrainz + Wikipedia (main process, cached; null = no match).
   *  `force` bypasses the cache read — the user-driven refresh. */
  fetchAlbumInfo(artist: string, album: string, force?: boolean): Promise<AlbumInfo | null>
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
  /** Undo a clear: merges the snapshot back under anything logged since. */
  recentsRestore(list: RecentTrack[]): Promise<void>
  /** Add a favorite (replaces any same-key entry); resolves to the new list. */
  favoriteAdd(fav: Favorite): Promise<Favorite[]>
  /** Remove a favorite by its favoriteKey; resolves to the new list. */
  favoriteRemove(key: string): Promise<Favorite[]>
  /** Patch a favorite in place (objectId healing after a search resolve). */
  favoriteUpdate(key: string, patch: Partial<Favorite>): Promise<Favorite[]>
  /** Stored playlists. Writes return the whole list, like the favorites verbs —
   *  except create, which returns the CREATED playlist: its stored name may
   *  have been uniquified, so reporting the outcome (toast text, an MCP reply
   *  with the id) must read the result, not echo the request. */
  playlistCreate(name: string, items: PlaylistItem[]): Promise<Playlist>
  playlistRename(id: string, name: string): Promise<Playlist[]>
  playlistDelete(id: string): Promise<Playlist[]>
  /** Undo a delete: puts the playlist back verbatim — same id, name, timestamps
   *  and place in the collection. NOT a create (see restorePlaylist). */
  playlistRestore(playlist: Playlist): Promise<Playlist[]>
  /** Undo a queue removal: re-resolve the track by content, re-add it, and move
   *  it back to `position`. Best-effort — see QueueRestoreResult. */
  queueRestore(ref: ContentRef, position: number): Promise<QueueRestoreResult>
  /** Replace a playlist's items wholesale — reorder and remove both land here. */
  playlistSetItems(id: string, items: PlaylistItem[]): Promise<Playlist[]>
  /** Append to a playlist (duplicates allowed — an ordered list, not a set). */
  playlistAppend(id: string, items: PlaylistItem[]): Promise<Playlist[]>
  /** Replace the streamer's queue with a playlist. Resolves when the run ends. */
  playlistActivate(id: string): Promise<PlaylistActivation>
  /** Stop an in-flight activation; the queue keeps whatever landed. */
  playlistActivateCancel(): Promise<void>
  /** UPnP media servers known to the streamer (its own USB storage included). */
  mediaServers(): Promise<MediaServerInfo[]>
  /** Browse a ContentDirectory container (objectId null = root). `titlePath` is
   *  the breadcrumb titles from root — used to re-resolve stale ids after the
   *  streamer's USB ids rot across a standby cycle. */
  mediaBrowse(serverUdn: string, objectId: string | null, titlePath: string[]): Promise<MediaNode[]>
  /** Whole-library search on a searchable server (title/artist/album contains). */
  mediaSearch(serverUdn: string, query: string): Promise<{ items: MediaNode[]; total: number }>
  /** Cross-server search: every READY index at once, grouped by server.
   *  Index-only by design — live fallback stays per-server (no SOAP fan-out). */
  mediaSearchAll(query: string): Promise<MediaSearchAllGroup[]>
  /** Every ready index's full pools — feeds the Artists/Albums lenses. */
  mediaIndexPools(): Promise<MediaIndexPools[]>
  /** Queue a browsed item on the streamer (DIDL stays in the main process). */
  mediaQueueAdd(
    serverUdn: string,
    objectId: string,
    action: MediaQueueAction,
    playFromId?: string
  ): Promise<void>
  /** Save a browsed item to a preset slot (1-99). */
  mediaPresetSave(serverUdn: string, objectId: string, slot: number): Promise<void>
  /** Find a track by CONTENT on any server (index first, live fallback) —
   *  the renderer-facing face of main's resolveContent. Null when nothing
   *  matches or the device is disconnected. */
  contentResolve(
    ref: ContentRef
  ): Promise<{ serverUdn: string; serverName: string; objectId: string } | null>
  /** Station search against radio-browser.info (main process; name contains, by popularity). */
  /** Force a media-index (re)build for one server (also the only way to
   *  build one for a Browse-only server). */
  mediaIndexRebuild(serverUdn: string): Promise<void>
  radioSearch(query: string): Promise<RadioStation[]>
  /** The directory's most-listened stations — the Radio screen's default rail. */
  radioTop(): Promise<RadioStation[]>
  /** Stations for a curated category: any-of the given tags, popularity-ranked. */
  radioByTags(tags: string[]): Promise<RadioStation[]>
  /** Combined size of the on-disk lookup caches (lyrics, artist context). */
  lookupCacheStats(): Promise<{ entries: number; bytes: number }>
  /** Wipe the lookup caches (memory + disk); resolves to the fresh stats. */
  clearLookupCaches(): Promise<{ entries: number; bytes: number }>
  onPush(cb: (msg: PushMessage) => void): () => void
}

export const IPC = {
  getSnapshot: 'tt:getSnapshot',
  discover: 'tt:discover',
  connect: 'tt:connect',
  disconnect: 'tt:disconnect',
  demoStart: 'tt:demoStart',
  command: 'tt:command',
  openExternal: 'tt:openExternal',
  getSettings: 'tt:getSettings',
  setSettings: 'tt:setSettings',
  fetchArt: 'tt:fetchArt',
  fetchLyrics: 'tt:fetchLyrics',
  lbValidate: 'tt:lbValidate',
  updateDownload: 'tt:updateDownload',
  updateInstall: 'tt:updateInstall',
  updateCheckNow: 'tt:updateCheckNow',
  fetchArtistInfo: 'tt:fetchArtistInfo',
  fetchAlbumInfo: 'tt:fetchAlbumInfo',
  toggleMini: 'tt:toggleMini',
  showMain: 'tt:showMain',
  setSleep: 'tt:setSleep',
  getRecents: 'tt:getRecents',
  clearRecents: 'tt:clearRecents',
  recentsRestore: 'tt:recentsRestore',
  favoriteAdd: 'tt:favoriteAdd',
  favoriteRemove: 'tt:favoriteRemove',
  favoriteUpdate: 'tt:favoriteUpdate',
  playlistCreate: 'tt:playlistCreate',
  playlistRename: 'tt:playlistRename',
  playlistDelete: 'tt:playlistDelete',
  playlistRestore: 'tt:playlistRestore',
  queueRestore: 'tt:queueRestore',
  playlistSetItems: 'tt:playlistSetItems',
  playlistAppend: 'tt:playlistAppend',
  playlistActivate: 'tt:playlistActivate',
  playlistActivateCancel: 'tt:playlistActivateCancel',
  lookupCacheStats: 'tt:lookupCacheStats',
  clearLookupCaches: 'tt:clearLookupCaches',
  mediaServers: 'tt:mediaServers',
  mediaBrowse: 'tt:mediaBrowse',
  mediaSearch: 'tt:mediaSearch',
  mediaSearchAll: 'tt:mediaSearchAll',
  mediaIndexPools: 'tt:mediaIndexPools',
  mediaQueueAdd: 'tt:mediaQueueAdd',
  mediaPresetSave: 'tt:mediaPresetSave',
  contentResolve: 'tt:contentResolve',
  mediaIndexRebuild: 'tt:mediaIndexRebuild',
  radioSearch: 'tt:radioSearch',
  radioTop: 'tt:radioTop',
  radioByTags: 'tt:radioByTags',
  push: 'tt:push'
} as const
