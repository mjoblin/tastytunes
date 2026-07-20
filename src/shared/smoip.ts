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

/**
 * Radio-ness of play-state metadata — THE copy, shared by recents recording
 * (deviceManager), the scrobbler's filter, and recents live-matching
 * (recentMatchesPlayState). These used to be three hand-mirrored expressions
 * held in sync by comments alone; a drift breaks recents or scrobbling
 * silently.
 */
export const isRadioMetadata = (
  md: Pick<ZonePlayStateMetadata, 'class' | 'station'> | null | undefined
): boolean => md != null && (/radio/i.test(md.class ?? '') || md.station != null)

/**
 * A radio "title" that's absent or merely echoes the station's own name back
 * carries no real track — normalize it to null (case/whitespace-insensitive,
 * matching how recents entries are recorded AND matched).
 */
export const radioTrackTitle = (
  md: Pick<ZonePlayStateMetadata, 'title' | 'station'>
): string | null => {
  const title = md.title ?? null
  const station = md.station ?? null
  if (title == null) return null
  if (station != null && title.trim().toLowerCase() === station.trim().toLowerCase()) return null
  return title
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

// -------------------------------------------------------------------- /zone/audio

/**
 * The DSP/tone chain (7-band EQ, tilt, balance) — per-MODEL: newer streamers
 * (Evo 150, CXN100) expose it, older ones may not. Everything here is
 * feature-detected via /zone/audio/spec at connect (see audioCaps below);
 * never gate by model name.
 *
 * READ shape (captured live off the Evo 2026-07-19). The WRITE schema is
 * different: `user_eq` and `tilt_eq` are booleans on write (`tilt_intensity`
 * is its own write param), and bands write as the string param
 * `user_eq_bands="<idx>,<freq>,<filter>,<gain>,<q>"` (blank = keep,
 * multiple bands pipe-delimited). Writes are ATOMIC — one bad field rejects
 * the whole frame — so every logical control sends its own frame.
 */
export interface ZoneAudioBand {
  index: number
  filter: string // LOWSHELF / PEAKING / HIGHSHELF / … (see spec filters enum)
  freq: number
  gain: number
  q: number
}

export interface ZoneAudio {
  volume_limit_percent: number | null
  tilt_eq: { enabled: boolean; intensity: number } | null
  user_eq: { enabled: boolean; bands: ZoneAudioBand[] } | null
  balance: number | null
  /** Observed "DSP" on the Evo; semantics unconfirmed — read-only for us. */
  pipeline: string | null
}

// --------------------------------------------------------------- /zone/audio/spec

export interface AudioSpecRange {
  minimum?: number
  maximum?: number
  readonly?: boolean
}

export interface ZoneAudioSpec {
  volume_limit_percent?: AudioSpecRange
  pipeline?: { readonly?: boolean }
  tilt_eq?: AudioSpecRange
  user_eq?: {
    bands?: number
    filters?: { enum?: string[] }
    readonly?: boolean
    always_on?: boolean
  }
  balance?: AudioSpecRange
}

/**
 * What the connected streamer's tone controls actually support — derived from
 * the spec, shown-only-when-writable. {endpoint absent, field missing,
 * readonly:true, fetch error} all collapse to "not supported" (the exact
 * negative shape on non-EQ hardware is unobserved — treat everything
 * non-positive as absence).
 */
export interface AudioCaps {
  userEq: boolean
  tilt: boolean
  balance: boolean
  /** From the spec when it publishes a range; UI fallback −15..15. */
  tiltRange: { min: number; max: number }
  balanceRange: { min: number; max: number }
}

/**
 * The band-gain range is the ONE range the spec does NOT publish. −6..+3 dB is
 * the official app's client-side clamp (probed live: the firmware itself
 * stores out-of-range gains verbatim) — matching it keeps both apps' sliders
 * telling the same story, and Cambridge's boost ceiling reflects DSP headroom.
 */
export const EQ_GAIN_MIN = -6
export const EQ_GAIN_MAX = 3

export function audioCaps(spec: ZoneAudioSpec | null | undefined): AudioCaps | null {
  if (spec == null) return null
  const range = (r: AudioSpecRange | undefined, fallbackMin: number, fallbackMax: number) => ({
    min: r?.minimum ?? fallbackMin,
    max: r?.maximum ?? fallbackMax
  })
  const caps: AudioCaps = {
    userEq: spec.user_eq != null && spec.user_eq.readonly !== true,
    tilt: spec.tilt_eq != null && spec.tilt_eq.readonly !== true,
    balance: spec.balance != null && spec.balance.readonly !== true,
    tiltRange: range(spec.tilt_eq, -15, 15),
    balanceRange: range(spec.balance, -15, 15)
  }
  return caps.userEq || caps.tilt || caps.balance ? caps : null
}

/**
 * Control-bus amp mode: the streamer drives an external Cambridge amp/receiver
 * over the Control Bus and can only send RELATIVE volume nudges
 * (volume_step_change) — never an absolute level. An ALLOWLIST of cbus values,
 * matching the two field-tested references (punytunes `isCbusAmpModeEnabled`,
 * vibin `streammagic.py`), NOT an "anything not off/none" denylist.
 */
export const isCbusMode = (z: Pick<ZoneState, 'cbus'> | null | undefined): boolean =>
  z?.cbus === 'amplifier' || z?.cbus === 'receiver'

/**
 * Pre-amp mode: the streamer holds an absolute volume it can set. Requires
 * pre_amp_mode AND pre_amp_state === "on" — matching punytunes
 * (`isPreAmpModeEnabled`); a mode-enabled-but-not-"on" pre-amp can't take an
 * absolute level. (Live-confirmed safe on the user's Evo 150: pre_amp_mode
 * true, pre_amp_state "on".)
 */
export const isPreAmpMode = (
  z: Pick<ZoneState, 'pre_amp_mode' | 'pre_amp_state'> | null | undefined
): boolean => z?.pre_amp_mode === true && z.pre_amp_state === 'on'

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

/**
 * Order-sensitive content hash of a queue's tracks (title/artist/album per
 * item — durations and art URLs can drift between a save and a later
 * recall). Recorded when a queue is saved to a device preset, then matched
 * against the live queue to recognize that preset's exact queue coming back
 * — including recalls made from other controllers, and at startup.
 */
export function queueContentHash(items: QueueListItem[]): string {
  let h = 0x811c9dc5
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  for (const it of items) {
    const md = it.metadata
    mix(`${md?.title ?? ''}\x00${md?.artist ?? ''}\x00${md?.album ?? ''}\x01`)
  }
  return `${items.length}:${h.toString(16)}`
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
  /** MediaQueue presets (saved queues) carry one art per distinct album. */
  art_urls?: string[] | null
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
  /** Which standby the unit drops into (ECO_MODE = deep, NETWORK = instant-on). */
  standby_mode?: string | null
  /** Idle seconds before auto power-down; 0 = never. (Evo range 0..7200.) */
  auto_power_down?: number | null
}

// ---------------------------------------------------------------- /system/display

/** Front-panel display brightness (off | dim | bright). */
export interface SystemDisplay {
  brightness: string
}

// --------------------------------------------------- /system/display + power specs

export interface SystemDisplaySpec {
  brightness?: { enum?: string[]; readonly?: boolean }
}

export interface SystemPowerSpec {
  power?: { enum?: string[]; readonly?: boolean }
  standby_mode?: { enum?: string[]; readonly?: boolean }
  auto_power_down?: { minimum?: number; maximum?: number; readonly?: boolean }
}

/**
 * Feature-detection for the §10 device controls — present-and-writable only,
 * mirroring audioCaps. A headless streamer has no /system/display; readonly
 * fields (or an absent spec) collapse to "not supported" and the control hides.
 */
export const brightnessOptions = (spec: SystemDisplaySpec | null | undefined): string[] | null => {
  const b = spec?.brightness
  return b?.enum?.length && b.readonly !== true ? b.enum : null
}
export const standbyModeOptions = (spec: SystemPowerSpec | null | undefined): string[] | null => {
  const s = spec?.standby_mode
  return s?.enum?.length && s.readonly !== true ? s.enum : null
}
export const autoPowerDownRange = (
  spec: SystemPowerSpec | null | undefined
): { min: number; max: number } | null => {
  const r = spec?.auto_power_down
  return r && r.readonly !== true && r.minimum != null && r.maximum != null
    ? { min: r.minimum, max: r.maximum }
    : null
}

// ----------------------------------------------------------------- /system/update

/**
 * Firmware self-check status the streamer PUSHES to subscribers (it runs its
 * own availability check and reports the result). READ-ONLY here — TastyTunes
 * subscribes but never sends action=CHECK/action=UPDATE; see FirmwareStatus in
 * ipc.ts and the PASSIVE-ONLY guard in deviceManager.
 */
export interface SystemUpdate {
  early_update: boolean
  update_available: boolean
  updating: boolean
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
