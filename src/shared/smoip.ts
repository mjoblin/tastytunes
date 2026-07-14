// SMOIP ("StreamMagic over IP") wire types, ported from PunyTunes' ts-rs-generated
// definitions (punytunes/src/types/generated/streammagic_payloads/). u64 fields that
// ts-rs mapped to bigint are plain numbers here — everything arrives via JSON.parse.

/** Every frame the streamer sends over ws://<host>:80/smoip. */
export interface SmoipFrame {
  path: string
  type?: string
  result?: number
  message?: string
  params?: {
    zone?: string
    data?: unknown
    [key: string]: unknown
  }
}

// ---------------------------------------------------------------- /zone/play_state

export type ZonePlayStateState =
  | 'buffering'
  | 'connecting'
  | 'no_signal'
  | 'not_ready'
  | 'pause'
  | 'play'
  | 'ready'
  | 'stop'

export interface ZonePlayStateMetadata {
  class: string | null
  source: string | null
  name: string | null
  playback_source: string | null
  track_number: number | null
  duration: number | null
  album: string | null
  artist: string | null
  title: string | null
  art_url: string | null
  sample_format: string | null
  mqa: string | null
  codec: string | null
  lossless: boolean | null
  sample_rate: number | null
  bit_depth: number | null
  encoding: string | null
  station: string | null
  bitrate: number | null
  radio_id: number | null
}

export interface ZonePlayState {
  state: ZonePlayStateState | null
  position: number | null
  presettable: boolean | null
  queue_index: number | null
  queue_length: number | null
  queue_id: number | null
  mode_repeat: string | null
  mode_shuffle: string | null
  metadata: ZonePlayStateMetadata | null
}

// ------------------------------------------------------- /zone/play_state/position

export interface ZonePosition {
  position: number
}

// --------------------------------------------------------------- /zone/now_playing

export interface ZoneNowPlayingProgress {
  position: number | null
  duration: number | null
}

export interface ZoneNowPlayingDisplay {
  line1: string | null
  line2: string | null
  line3: string | null
  format: string | null
  mqa: string | null
  playback_source: string | null
  class: string | null
  art_url: string | null
  art_file: string | null
  progress: ZoneNowPlayingProgress | null
  context: string | null
}

export interface ZoneNowPlayingQueue {
  length: number | null
  position: number | null
  shuffle: string | null
  repeat: string | null
}

export interface ZoneNowPlayingSource {
  id: string | null
  name: string | null
}

export interface ZoneNowPlaying {
  state: string | null
  source: ZoneNowPlayingSource | null
  display: ZoneNowPlayingDisplay | null
  queue: ZoneNowPlayingQueue | null
  controls: string[] | null
}

// -------------------------------------------------------------------- /zone/state

export interface ZoneState {
  source: string | null
  power: boolean | null
  pre_amp_mode: boolean | null
  pre_amp_state: string | null
  mute: boolean | null
  volume_step: number | null
  volume_percent: number | null
  volume_db: number | null
  cbus: string | null
}

// -------------------------------------------------------------------- /queue/list

export interface QueueListItemMetadata {
  class: string | null
  source: string | null
  name: string | null
  title: string | null
  art_url: string | null
  track_number: number | null
  duration: number | null
  genre: string | null
  album: string | null
  artist: string | null
}

export interface QueueListItem {
  id: number | null
  position: number | null
  metadata: QueueListItemMetadata | null
}

export interface QueueList {
  start: number | null
  count: number | null
  total: number | null
  play_postition: number | null // sic — the streamer's own spelling
  play_id: number | null
  items: QueueListItem[] | null
}

// ------------------------------------------------------------------ /presets/list

export interface PresetItem {
  id: number | null
  name: string | null
  type: string | null
  class: string | null
  state: string | null
  is_playing: boolean | null
  art_url: string | null
  airable_radio_id: number | null
}

export interface Presets {
  start: number | null
  end: number | null
  max_presets: number | null
  presettable: boolean | null
  presets: PresetItem[] | null
}

// ------------------------------------------------------------------- /system/info

export interface SystemInfoVersion {
  component: string | null
  version: string | null
}

export interface SystemInfo {
  name: string | null
  timezone: string | null
  locale: string | null
  usage_reports: boolean | null
  setup: boolean | null
  sources_setup: boolean | null
  versions: SystemInfoVersion[] | null
  udn: string | null
  hcv: number | null
  model: string | null
  unit_id: string | null
  max_http_body_size: number | null
  api: string | null
}

// ------------------------------------------------------------------ /system/power

export interface SystemPower {
  power: string // "ON" | "NETWORK" (network standby)
}

// ---------------------------------------------------------------- /system/sources

export interface Source {
  id: string
  name: string
  default_name: string
  class: string
  nameable: boolean
  ui_selectable: boolean
  description: string
  description_locale: string
  preferred_order: number
}

export interface SystemSources {
  sources: Source[]
}
