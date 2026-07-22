// The typed contract between main, preload, and renderer.

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
import { isRadioMetadata, radioTrackTitle } from './smoip'

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
  | { kind: 'frame'; entry: FrameEntry }
  | { kind: 'log'; entry: LogEntry }
  | { kind: 'recents'; data: RecentTrack[] }
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
  /** Settings-UI grouping: read = look-never-touch, control = transient
   *  actions, write = persists changes (queue order, preset slots). */
  group: 'read' | 'control' | 'write'
  /** Off until the user explicitly enables it (mcp.enabledClusters) — for
   *  clusters whose tools change saved things. */
  optIn?: boolean
  tools: McpToolInfo[]
}

/** Effective cluster gate — shared by the server and the Settings screen.
 *  Opt-in clusters require an explicit enable; everything else is on unless
 *  disabled. */
export function mcpClusterEnabled(c: McpClusterInfo, mcp: McpSettings): boolean {
  return c.optIn === true
    ? (mcp.enabledClusters ?? []).includes(c.id)
    : !mcp.disabledClusters.includes(c.id)
}

/**
 * Everything the MCP server can expose — shared so the Settings screen and the
 * server agree exactly. Schemas and handlers live in main (mcpServer.ts);
 * enable/disable state lives in settings.mcp.
 */
export const MCP_CLUSTERS: McpClusterInfo[] = [
  {
    id: 'status',
    group: 'read',
    title: 'Status & lists',
    description: "Read-only: what's playing, the queue, presets, sources, devices, history.",
    readOnly: true,
    tools: [
      {
        name: 'get_status',
        title: 'Get status',
        description:
          "One combined snapshot: connection and device, power state, active source, what's playing (title/artist/album/station, format, position/duration), volume and mute, shuffle/repeat, queue position, and any armed sleep timer. Call this first."
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
    group: 'control',
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
    group: 'control',
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
    group: 'control',
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
    group: 'control',
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
    group: 'control',
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
    group: 'control',
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
    group: 'control',
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
  },
  {
    id: 'library',
    title: 'Library',
    group: 'control',
    description: 'Search the media servers and play albums or tracks.',
    tools: [
      {
        name: 'list_media_servers',
        title: 'List media servers',
        description:
          'UPnP media servers the streamer can play from: name, udn, and whether the server answers searches.'
      },
      {
        name: 'search_library',
        title: 'Search library',
        description:
          'Search for albums, artists, and tracks across every searchable or index-ready media server at once (or one server_udn). Returns object ids for play_media.'
      },
      {
        name: 'play_media',
        title: 'Play media',
        description:
          "Play an album or track by server_udn + object id (from search_library). mode 'play_now' (default) keeps the queue, 'play_next'/'append' insert into it; 'replace' CLEARS the queue first — only use replace when asked to."
      }
    ]
  },
  {
    id: 'radio',
    title: 'Radio',
    group: 'control',
    description:
      'Search internet radio (the keyless radio-browser.info directory) and play stations. No listening data is ever reported back.',
    tools: [
      {
        name: 'search_radio',
        title: 'Search radio',
        description:
          'Search internet-radio stations by name, genre, or country: returns name, stream URL, country, codec, bitrate, tags.'
      },
      {
        name: 'play_radio',
        title: 'Play radio',
        description:
          'Play an internet-radio stream by URL and display name (from search_radio or a station favorite).'
      }
    ]
  },
  {
    id: 'favorites',
    title: 'Favorites',
    group: 'control',
    description: "List, play, and add to the user's favorites (stations, albums, tracks).",
    tools: [
      {
        name: 'list_favorites',
        title: 'List favorites',
        description: "The user's favorites with the keys play_favorite needs."
      },
      {
        name: 'play_favorite',
        title: 'Play favorite',
        description:
          'Play a favorite by its key (see list_favorites). Albums and tracks are found by content — a stale library id heals via search.'
      },
      {
        name: 'add_favorite',
        title: 'Add favorite',
        description:
          'With no arguments, favorite the currently playing track. For an internet-radio station, pass station_url + station_name (e.g. from search_radio).'
      }
    ]
  },
  {
    id: 'audio',
    title: 'Tone & EQ',
    group: 'control',
    description:
      'Read and shape the sound: 7-band EQ, tone tilt, balance. Only offered on streamers whose firmware has tone controls; every change is a device setting the user can see and undo on the Device screen.',
    tools: [
      {
        name: 'get_audio_settings',
        title: 'Get audio settings',
        description:
          'Current EQ band gains, tilt, and balance, plus the allowed ranges. Errors on streamers without tone controls.'
      },
      {
        name: 'set_eq_band',
        title: 'Set EQ band',
        description:
          'Set one EQ band gain in dB (band index 0–6, low to high frequency; gains clamp to −6..+3). Enables the user EQ when needed.'
      },
      {
        name: 'set_tilt',
        title: 'Set tone tilt',
        description:
          'Set the tone-tilt intensity (negative = warmer/darker, positive = brighter; range from get_audio_settings). Enables tilt when needed.'
      },
      {
        name: 'set_balance',
        title: 'Set balance',
        description: 'Left/right balance (negative = left, positive = right; range from get_audio_settings).'
      },
      {
        name: 'apply_eq_preset',
        title: 'Apply EQ preset',
        description: "Apply one of the user's saved EQ presets by name (get_audio_settings lists them)."
      },
      {
        name: 'reset_eq',
        title: 'Reset EQ',
        description: 'Set all 7 EQ bands back to 0 dB — the same as the Flat button in the app.'
      }
    ]
  },
  {
    id: 'display',
    title: 'Display',
    group: 'control',
    description: "The streamer's front-panel display brightness (models that have a display).",
    tools: [
      {
        name: 'set_display_brightness',
        title: 'Set display brightness',
        description: "Front-panel brightness: 'off', 'dim', or 'bright'. Errors on headless models."
      }
    ]
  },
  {
    id: 'lookups',
    title: 'Lookups',
    group: 'read',
    readOnly: true,
    description:
      "Lyrics and artist context for what's playing. These call the same services as the app's own panels and obey the Connections toggles — while a toggle is off, the matching tool refuses (off means no requests, ever).",
    tools: [
      {
        name: 'get_lyrics',
        title: 'Get lyrics',
        description:
          "Lyrics for the currently playing track via LRCLIB. Refuses when the user has lyrics disabled in Settings → Connections."
      },
      {
        name: 'get_artist_info',
        title: 'Get artist info',
        description:
          'Artist bio via MusicBrainz + Wikipedia — the current artist by default, or a named one. Refuses when the user has artist context disabled in Settings → Connections.'
      }
    ]
  },
  {
    id: 'queueedit',
    title: 'Queue editing',
    group: 'write',
    optIn: true,
    description:
      'Remove or reorder tracks in the play queue. Removals are immediate and there is no undo — off unless you turn it on.',
    tools: [
      {
        name: 'remove_queue_item',
        title: 'Remove queue item',
        description: 'Remove one track from the queue by its id (see list_queue). No undo.'
      },
      {
        name: 'move_queue_item',
        title: 'Move queue item',
        description: 'Move a queue track (by id) to a new position (0-based; see list_queue).'
      }
    ]
  },
  {
    id: 'presetsave',
    title: 'Preset saving',
    group: 'write',
    optIn: true,
    description:
      'Save the queue or the current playback into numbered preset slots. A slot that already holds a preset is only replaced when the tool call says overwrite explicitly — off unless you turn it on.',
    tools: [
      {
        name: 'save_queue_as_preset',
        title: 'Save queue as preset',
        description:
          'Snapshot the whole queue into a preset slot (1–99) with a name. If the slot is occupied the call fails unless overwrite is true — always check list_presets first.'
      },
      {
        name: 'save_playing_to_preset',
        title: 'Save playing to preset',
        description:
          'Save the CURRENT playback (a station, or a single track) to a preset slot (1–99); optional name. Occupied slots need overwrite: true. For whole albums or queues use save_queue_as_preset.'
      }
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

/** The display face ("money font") — a curated, bundled set. */
export type DisplayFont = 'bricolage' | 'fraunces' | 'space-grotesk' | 'sora' | 'unbounded'
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
  deviceTab: 'streamer' | 'tone'
  /** Width (px) of the Now Playing drawers (lyrics/artist), drag-resizable. */
  panelWidth: number
  /** Remembered mini-player window position. */
  miniBounds: { x: number; y: number } | null
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
  displayFont: 'bricolage',
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
  /** Add a favorite (replaces any same-key entry); resolves to the new list. */
  favoriteAdd(fav: Favorite): Promise<Favorite[]>
  /** Remove a favorite by its favoriteKey; resolves to the new list. */
  favoriteRemove(key: string): Promise<Favorite[]>
  /** Patch a favorite in place (objectId healing after a search resolve). */
  favoriteUpdate(key: string, patch: Partial<Favorite>): Promise<Favorite[]>
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
  favoriteAdd: 'tt:favoriteAdd',
  favoriteRemove: 'tt:favoriteRemove',
  favoriteUpdate: 'tt:favoriteUpdate',
  lookupCacheStats: 'tt:lookupCacheStats',
  clearLookupCaches: 'tt:clearLookupCaches',
  mediaServers: 'tt:mediaServers',
  mediaBrowse: 'tt:mediaBrowse',
  mediaSearch: 'tt:mediaSearch',
  mediaSearchAll: 'tt:mediaSearchAll',
  mediaIndexPools: 'tt:mediaIndexPools',
  mediaQueueAdd: 'tt:mediaQueueAdd',
  mediaPresetSave: 'tt:mediaPresetSave',
  mediaIndexRebuild: 'tt:mediaIndexRebuild',
  radioSearch: 'tt:radioSearch',
  radioTop: 'tt:radioTop',
  radioByTags: 'tt:radioByTags',
  push: 'tt:push'
} as const
