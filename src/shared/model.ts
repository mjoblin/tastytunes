// The app's own DOMAIN — the things TastyTunes stores and reasons about,
// independent of how they travel.
//
// Split out of ipc.ts 2026-07-26. The rule for what lives here: a type belongs
// in this file if it would still mean something with the IPC layer deleted —
// the local recently-played log, favorites, playlists, and the content-identity
// helpers that make all three survive a media server re-indexing. Message
// shapes, channel names and the preload API stay in ipc.ts, which imports FROM
// here; nothing in this file may import from ipc.ts, and that one-way edge is
// what keeps the contract free of domain churn.
//
// smoip.ts is the other direction entirely — the STREAMER's wire types. This
// file may read from it (a recent entry is matched against a play_state, a
// playlist hashes with the same core a live queue does); it never writes to it.

import type { SmoipFrame, ZonePlayState } from './smoip'
import { contentRowsHash, isRadioMetadata, radioTrackTitle } from './smoip'

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
 * reports? Mirrors the recording normalization in main/data/recents.ts (title-keyed;
 * a radio "song" that's absent or just echoes the station name is null), so the
 * Recently Played screen can mark its head entry live without drifting from how
 * entries were written.
 */
export function recentMatchesPlayState(e: RecentTrack, ps: ZonePlayState | null): boolean {
  const md = ps?.metadata
  if (!md) return false
  const eq = (a: string | null | undefined, b: string | null | undefined): boolean =>
    (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
  const isRadio = isRadioMetadata(md)
  if (e.isRadio !== isRadio) return false
  if (isRadio) {
    return eq(e.station, md.station) && eq(e.title, radioTrackTitle(md))
  }
  return e.title != null && eq(e.title, md.title)
}

// -------------------------------------------------------------------- favorites

/**
 * A favorited radio station. The stream URL is the identity — playing needs
 * no resolution at all (streamRadio with the stored url+name). The
 * radio-browser uuid is a recovery hint for URL rot: an on-demand re-lookup,
 * user-initiated only (never a click-ping — the privacy stance holds).
 */
export interface FavoriteStation {
  kind: 'station'
  addedAt: number
  name: string
  url: string
  favicon: string | null
  radioBrowserUuid: string | null
}

/**
 * A favorited album or track, keyed on CONTENT identity (title/artist/album)
 * — UPnP object ids rot, so `objectId` is only a fast-path hint and playing
 * falls back to a scoped library search. `serverUdn` is where it was hearted
 * (null for content-only entries from the Now Playing heart); `titlePath` is
 * the breadcrumb trail at heart time, feeding the browse re-walk.
 */
export interface FavoriteMedia {
  kind: 'album' | 'track'
  addedAt: number
  title: string
  artist: string | null
  /** Tracks only — the album the track belongs to. */
  album: string | null
  artUrl: string | null
  serverUdn: string | null
  serverName: string | null
  objectId: string | null
  titlePath: string[] | null
  /** Track length in seconds, captured at heart time (tracks; null when the
   *  source had none — favorites hearted before this field show blank). */
  durationSecs?: number | null
}

export type Favorite = FavoriteStation | FavoriteMedia

/**
 * Content identity — dedupe and heart-lit checks. Stations key on the URL;
 * media keys on lowercased content fields, deliberately WITHOUT the server
 * (the same album on two servers is the same music).
 */
export function favoriteKey(f: Favorite): string {
  const lc = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()
  if (f.kind === 'station') return `station:${f.url}`
  if (f.kind === 'album') return `album:${lc(f.title)}:${lc(f.artist)}`
  return `track:${lc(f.title)}:${lc(f.artist)}:${lc(f.album)}`
}

// -------------------------------------------------------------------- playlists

/**
 * One track in a stored playlist.
 *
 * IDENTITY DISCIPLINE (the thing that makes playlists survivable): the CONTENT
 * — title/artist/album — is the durable key, and serverUdn/objectId are a fast
 * path that gets HEALED when a media server re-indexes. vibin stored bare media
 * ids and matched on id equality, which is why its playlist activation needs a
 * "skipped, not found on media server" counter. We already solved this twice
 * (favoriteKey + objectId healing, queueContentHash); this is the same answer.
 */
export interface PlaylistItem {
  title: string
  artist: string | null
  album: string | null
  artUrl: string | null
  serverUdn: string | null
  serverName: string | null
  /** Fast path only — may be stale, and is re-resolved from content on a miss. */
  objectId: string | null
  durationSecs?: number | null
}

/**
 * A track identified by CONTENT alone — the one currency both content-resolve
 * callers speak (a playlist entry whose objectId rotted, a removed queue row
 * that never had one). Defined once here so the two can't drift apart.
 */
export interface ContentRef {
  title: string
  artist?: string | null
  album?: string | null
}

/**
 * Queue undo is a re-resolve, not a rollback, so it reports which happened:
 * 'not-found' = the track couldn't be found on any server (say so — the user
 * is looking at a queue it didn't reappear in), 'failed' = the streamer or the
 * connection refused, 'ok' = it's back (possibly not in its old slot; see
 * queueRestore).
 */
export type QueueRestoreResult = 'ok' | 'not-found' | 'failed'

/** A stored, ordered collection of tracks. Bounded local JSON, no database. */
export interface Playlist {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** Last time this playlist was activated. Optional: playlists stored before
   *  this field existed simply have no last-played date to show. */
  lastPlayedAt?: number | null
  /** Titles the last activation couldn't find on any server. Kept so the gap
   *  is visible later, not just in the banner you dismissed at the time. */
  lastMissing?: string[]
  items: PlaylistItem[]
}

/**
 * Live progress of a playlist activation. Activation is inherently SLOW —
 * entries can only be added to the streamer's queue one at a time, and each
 * needs its media server's metadata first, so it is ~2 round-trips per track.
 * The renderer shows this; `missed` names what couldn't be found rather than
 * failing the whole run (partial activation is a normal outcome, not an error).
 */
export interface PlaylistActivation {
  playlistId: string
  name: string
  total: number
  done: number
  added: number
  missed: string[]
  cancelled: boolean
  finished: boolean
}

/**
 * Bounds that keep "a bounded local file" honest (favorites are unbounded
 * because they're small and deliberate; a playlist collection is neither).
 */
export const MAX_PLAYLISTS = 100
export const MAX_PLAYLIST_ITEMS = 500

/**
 * A playlist's content hash in the SAME shape queueContentHash produces for a
 * live queue, so the two can be compared directly. That comparison is how a
 * playlist knows it's the thing currently queued — content-based, so it also
 * recognises a queue loaded before the app started, or by another controller,
 * exactly like the playing-preset match.
 */
export function playlistContentHash(items: PlaylistItem[]): string {
  // Delegates to the ONE hash core queueContentHash uses — these two are
  // compared for equality, so a fork here would silently kill the marker.
  return contentRowsHash(items)
}

/**
 * Content identity for a playlist entry — deliberately the same shape as
 * favoriteKey's track form, so an item and a hearted track resolve the same
 * way and the healing path can be shared.
 */
export function playlistItemKey(i: PlaylistItem): string {
  const lc = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()
  return `track:${lc(i.title)}:${lc(i.artist)}:${lc(i.album)}`
}

// ===========================================================================
// Second pass (2026-07-26): everything below moved from ipc.ts under the
// rule stated in this file's header — each of these would still mean
// something with the IPC layer deleted. Connection and MCP status are
// runtime DOMAIN state (the manager tracks them regardless of transport);
// settings are the persisted domain par excellence; the media-browser,
// radio, schedule, lyrics, artist, sleep, update and diagnostics shapes are
// what the app reasons about, not how it talks about them.
// ===========================================================================

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

/**
 * A wake schedule that came due while the computer was asleep, offered rather
 * than fired (see main/app/scheduler.ts). Held in the main process, mirrored to the
 * renderer so the Schedules tab can show it too — the OS notification is the
 * loud surface, this is the one that survives Do Not Disturb.
 *
 * Ephemeral by design: it dies with the app, like the countdown and lastFired.
 * A missed alarm is only interesting for as long as acting on it still makes
 * sense.
 */
export interface MissedSchedule {
  scheduleId: string
  /** When it was due — the UI says so, because "missed" without a time is noise. */
  dueAt: number
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
  /**
   * A TastyTunes icon in the system tray / menu bar, with a context menu that
   * reaches the streamer without opening a window. Companion to the main
   * window, never a replacement — see main/app/tray.ts.
   *
   * Default OFF, and deliberately a knob rather than a heuristic (the usual
   * "a better default beats a new knob" rule was checked): a permanent icon in
   * someone's menu bar has no defensible default and, unlike a toast, can't be
   * discovered and dismissed.
   */
  tray: boolean
  /**
   * The "TastyTunes is still running" notice has been shown once. Internal
   * one-shot state, not a preference — there is no UI for it. Closing the last
   * window with a tray icon present leaves the app alive, and silently
   * surviving a close is how apps earn a reputation for being un-quittable.
   */
  trayCloseNoticeShown: boolean
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
  /**
   * The user's own nav-rail order — screen ids, top to bottom. `[]` means the
   * registry's curated default, which is what almost everyone keeps.
   *
   * An ORDER, unlike navHidden's hide-set, can't default-by-omission, so the
   * sanitizer carries the rule instead: an id missing from a stored order is
   * inserted at its REGISTRY position, never appended. That is what stops a
   * screen added in a future version from landing below Device for everyone
   * who has ever touched this list. Hidden screens keep their slot here —
   * hidden means decluttered, not deleted, and unhiding restores position.
   *
   * Nav-rail screens only: the pinned bottom cluster (Commands, Mini player,
   * Settings) is fixed. KEYS DO NOT TRAVEL WITH POSITION — see the registry
   * header in lib/screens.ts.
   */
  navOrder: string[]
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
  tray: false,
  trayCloseNoticeShown: false,
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
  nowPlayingAlignV: 'top',
  navCollapsed: false,
  navHidden: [],
  navHiddenTools: [],
  navOrder: [],
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
