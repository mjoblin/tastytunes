// Orchestrates discovery, the SMOIP socket, command dispatch, and the push relay
// to renderer windows. Mirrors PunyTunes' StreamMagicManager, translated to Node.

import { BrowserWindow, Notification, nativeImage, webContents } from 'electron'
import {
  presetVolumeKey,
  sleepTrackKey,
  type ConnectionState,
  type ContentRef,
  type DiscoveredDevice,
  type FirmwareStatus,
  type FrameEntry,
  type LogEntry,
  type McpStatus,
  type MediaIndexStatus,
  type MediaQueueAction,
  type Playlist,
  type PlaylistActivation,
  type PushMessage,
  type QueueRestoreResult,
  type RecentTrack,
  type SleepTimer,
  type Snapshot,
  type StreamerCommand
} from '@shared/ipc'
import type {
  Presets,
  QueueList,
  SmoipFrame,
  SystemInfo,
  SystemPower,
  SystemDisplay,
  SystemDisplaySpec,
  SystemPowerSpec,
  SystemSources,
  SystemUpdate,
  ZoneAudio,
  ZoneAudioSpec,
  ZoneNowPlaying,
  ZonePlayState,
  ZonePosition,
  ZoneState
} from '@shared/smoip'
import { EQ_GAIN_MAX, EQ_GAIN_MIN, isRadioMetadata, radioTrackTitle } from '@shared/smoip'
import { discoverStreamers } from './discovery'
import { SmoipSocket } from './smoipSocket'
import * as smoipHttp from './smoipHttp'
import { getSettings, updateSettings } from './persist'
import { clearRecents, getRecents, recordRecent, restoreRecents } from './recents'
import { addFavorite, getFavorites, removeFavorite, updateFavorite } from './favorites'
import {
  appendToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylists,
  healPlaylistItem,
  markPlaylistPlayed,
  renamePlaylist,
  restorePlaylist,
  setPlaylistItems
} from './playlists'
import { queueAdd } from './upnpBrowser'
import { resolveContent, type ResolvedContent } from './resolveContent'
import { scrobbler } from './scrobbler'
import { getNetRequests, loggedFetch } from './netlog'

const FRAME_RING_SIZE = 300
const LOG_RING_SIZE = 300

/**
 * The user_eq_bands write string: "<idx>,<freq>,<filter>,<gain>,<q>", blank
 * fields = keep, bands pipe-delimited. Gain-only writes, exactly like the
 * official app ("0,,,3.0,|1,,,1.2,|…"); gains clamp to the official client's
 * −6..+3 dB envelope (the firmware itself stores anything — probed live).
 */
const bandString = (bands: [number, number][]): string =>
  bands
    .map(([i, g]) => `${i},,,${Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, g)).toFixed(1)},`)
    .join('|')

interface Cache {
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
  zoneAudio: ZoneAudio | null
  audioSpec: ZoneAudioSpec | null
  systemDisplay: SystemDisplay | null
  displaySpec: SystemDisplaySpec | null
  powerSpec: SystemPowerSpec | null
}

const emptyCache = (): Cache => ({
  playState: null,
  position: null,
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
  powerSpec: null
})

export class DeviceManager {
  private socket: SmoipSocket | null = null
  private connection: ConnectionState = { phase: 'idle' }
  private devices: DiscoveredDevice[] = []
  private discovering = false
  private cache: Cache = emptyCache()
  private frames: FrameEntry[] = []
  private logs: LogEntry[] = []
  private lastHealthCheckAt = 0
  private currentTrackKey: string | null = null
  private lastSourceId: string | null = null
  private queuePresetsTimer: NodeJS.Timeout | null = null
  private sleep: SleepTimer | null = null
  private sleepTimeout: NodeJS.Timeout | null = null
  /** Connected to the in-process demo device (labels the connection in the UI). */
  private demo = false
  /** See Snapshot.lastRecalledPresetId — in-app recalls only, content-checked by consumers. */
  private lastRecalledPresetId: number | null = null
  private mcpStatus: McpStatus = { running: false, url: null, error: null }
  private mediaIndexStatuses: MediaIndexStatus[] = []

  // ------------------------------------------------------------------ lifecycle

  /** Reconnect to the last-used streamer immediately; discover in parallel. */
  async startup(): Promise<void> {
    const { lastHost } = getSettings()
    if (lastHost) this.connect(lastHost)
    await this.discover()
  }

  async discover(): Promise<DiscoveredDevice[]> {
    if (this.discovering) return this.devices
    this.discovering = true
    this.pushDevices()
    try {
      this.devices = await discoverStreamers()
      this.log('info', 'discovery', `found ${this.devices.length} streamer(s)`)
    } catch (err) {
      this.log('error', 'discovery', `discovery failed: ${(err as Error).message}`)
    } finally {
      this.discovering = false
      this.pushDevices()
    }
    // Never-connected + idle + something found -> just connect. Lives here
    // (not only in startup) so the connect gate's auto-retry sweeps get the
    // same courtesy — a streamer that boots a minute after the app does is
    // picked up hands-free on a first run.
    if (!getSettings().lastHost && this.connection.phase === 'idle' && this.devices.length > 0) {
      this.connect(this.devices[0].host)
    }
    return this.devices
  }

  connect(host: string, opts?: { remember?: boolean; demo?: boolean }): void {
    // Renderer surfaces label the connection ("built-in demo") off this flag.
    this.demo = opts?.demo === true
    // A recall remembered from one device means nothing on another.
    this.setRecalledPreset(null)
    // A timer armed for one device must never act on another.
    if (this.sleep && this.socket && this.socket.host !== host) this.setSleep(null)
    this.socket?.close()
    this.cache = emptyCache()
    this.currentTrackKey = null
    this.lastSourceId = null
    // The demo device passes remember:false — its ephemeral loopback port
    // must never become the reconnect target of the next launch.
    if (opts?.remember !== false) updateSettings({ lastHost: host })

    // Callbacks from a replaced socket must be ignored: its async close event
    // would otherwise stomp the new connection's state.
    const isCurrent = (socket: SmoipSocket): boolean => this.socket === socket

    const socket: SmoipSocket = new SmoipSocket(host, {
      onFrame: (frame) => {
        if (isCurrent(socket)) this.handleFrame(frame)
      },
      onOutgoing: (frame) => {
        if (isCurrent(socket)) this.recordFrame('out', frame)
      },
      onConnecting: (attempt) => {
        if (isCurrent(socket)) this.setConnection({ phase: 'connecting', host, attempt })
      },
      onConnected: () => {
        if (isCurrent(socket)) {
          this.setConnection({ phase: 'connected', host })
          // Capability probes — refreshed every (re)connect. The /spec
          // endpoints aren't proven over the WS, so they ride HTTP like presets.
          void this.probeAudioSpec(socket)
          void this.probeSystemSpecs(socket)
        }
      },
      onDisconnected: (reason, reconnecting) => {
        if (isCurrent(socket)) this.setConnection({ phase: 'disconnected', host, reason, reconnecting })
      },
      onLog: (level, text) => {
        if (isCurrent(socket)) this.log(level, 'socket', text)
      }
    })
    this.socket = socket
    socket.connect()
  }

  disconnect(): void {
    if (this.sleep) this.setSleep(null)
    this.socket?.close()
    this.socket = null
    this.cache = emptyCache()
    this.demo = false
    this.setRecalledPreset(null)
    this.setConnection({ phase: 'idle' })
  }

  /** Rate-limited liveness probe, run on window focus and system resume. */
  healthCheck(): void {
    const now = Date.now()
    if (now - this.lastHealthCheckAt < 5000) return
    this.lastHealthCheckAt = now
    void this.socket?.healthCheck()
  }

  shutdown(): void {
    if (this.sleepTimeout) clearTimeout(this.sleepTimeout)
    this.socket?.close()
    this.socket = null
  }

  // ---------------------------------------------------------------- sleep timer

  /**
   * Arm or clear the sleep timer. Lives here (not in a renderer) so it
   * survives the window closing on macOS. Node timers stall during system
   * sleep, so checkSleepTimer() re-evaluates the absolute deadline on resume.
   */
  setSleep(sleep: SleepTimer | null): void {
    this.sleep = sleep
    if (this.sleepTimeout) {
      clearTimeout(this.sleepTimeout)
      this.sleepTimeout = null
    }
    if (sleep) {
      this.log('info', 'sleep', sleep.minutes != null ? `armed: ${sleep.action} in ${sleep.minutes} min` : `armed: ${sleep.action} at end of track`)
    }
    if (sleep?.firesAt != null) {
      const ms = sleep.firesAt - Date.now()
      if (ms <= 0) {
        this.fireSleep()
        return
      }
      this.sleepTimeout = setTimeout(() => this.fireSleep(), ms)
    }
    this.push({ kind: 'sleep', sleep: this.sleep })
  }

  /** Fire a countdown that came due while the system was asleep (on resume). */
  checkSleepTimer(): void {
    if (this.sleep?.firesAt != null && Date.now() >= this.sleep.firesAt) this.fireSleep()
  }

  private fireSleep(): void {
    const action = this.sleep?.action
    this.sleep = null
    if (this.sleepTimeout) {
      clearTimeout(this.sleepTimeout)
      this.sleepTimeout = null
    }
    this.push({ kind: 'sleep', sleep: null })
    // Only touch the streamer while connected — a timer that expires after a
    // dropout should quietly clear, never pause on reconnect.
    if (action && this.connection.phase === 'connected') {
      this.log('info', 'sleep', `fired: ${action}`)
      void this.command(action === 'standby' ? { type: 'power', power: 'NETWORK' } : { type: 'pause' })
    }
  }

  /** End-of-track sleep: fire when the armed track gives way or playback ends. */
  private sleepBoundaryCheck(ps: ZonePlayState): void {
    const sleep = this.sleep
    if (!sleep || sleep.minutes != null) return
    const key = sleepTrackKey(ps)
    const advanced = sleep.trackKey != null && key != null && key !== sleep.trackKey
    const ended = ps.state === 'stop' || ps.state === 'no_signal'
    if (advanced || ended) this.fireSleep()
  }

  // ------------------------------------------------------------------- commands

  /** Play-shaped commands that should wake a standby streamer first. */
  private static readonly WAKE_COMMANDS = new Set<StreamerCommand['type']>([
    'play',
    'togglePlayback',
    'playQueueId',
    'recallPreset',
    'streamRadio',
    'setSource'
  ])
  private wakePromise: Promise<void> | null = null

  /**
   * Wake-on-intent: bring a NETWORK-standby streamer to ON and wait for the
   * zone to be usable. Single-flight — concurrent intents share one wake.
   * FIRMWARE TRUTH (live-probed 2026-07-23): play verbs do NOT auto-wake;
   * standby refuses them with code 114, so the app must sequence ON → act.
   * The 2.5s settle is the scheduler's proven runway before recalls.
   */
  async ensureAwake(): Promise<void> {
    if (this.cache.systemPower == null || this.cache.systemPower.power === 'ON') return
    if (this.wakePromise) return this.wakePromise
    this.wakePromise = (async () => {
      this.push({ kind: 'waking', waking: true })
      try {
        await this.command({ type: 'power', power: 'ON' })
        // Event-driven readiness: the power push flips the cache; the timed
        // fallback covers a lost push. Then the settle for the zone/source.
        const deadline = Date.now() + 8000
        while (this.cache.systemPower?.power !== 'ON' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200))
        }
        await new Promise((r) => setTimeout(r, 2500))
      } finally {
        this.push({ kind: 'waking', waking: false })
        this.wakePromise = null
      }
    })()
    return this.wakePromise
  }

  async command(cmd: StreamerCommand): Promise<void> {
    const socket = this.socket
    const host = socket?.host
    if (!socket || !host) {
      this.log('warn', 'command', `ignored ${cmd.type} — not connected`)
      return
    }
    // A half-dead socket (closed or mid-reconnect) used to swallow commands
    // silently — the user clicks a preset, the card marks, nothing plays.
    // Fail loudly instead so the renderer's central catch can toast it.
    if (!socket.isOpen()) {
      this.log('warn', 'command', `dropped ${cmd.type} — socket not open`)
      throw new Error(`streamer socket not open (${cmd.type})`)
    }
    if (
      DeviceManager.WAKE_COMMANDS.has(cmd.type) &&
      this.cache.systemPower != null &&
      this.cache.systemPower.power !== 'ON'
    ) {
      await this.ensureAwake()
    }

    // PASSIVE-ONLY firmware policy (explicit user decision): there is NO command
    // that sends /system/update with an `action` param. TastyTunes only ever
    // SUBSCRIBES to /system/update (read-only, see smoipSocket SUBSCRIBED_PATHS)
    // to SHOW whether an update is available; it never sends action=CHECK
    // (refresh availability) or action=UPDATE (install). Updating the streamer's
    // firmware stays the user's job via the Cambridge Audio app or the
    // streamer's own web admin. Do not add a firmware check/install command here.
    switch (cmd.type) {
      // Cast-style sources (AirPlay live-proven 2026-07-20) advertise ONLY the
      // toggle verb — now_playing controls say play_pause, never play/pause —
      // and the firmware SILENTLY IGNORES the explicit verbs there. Honor the
      // device's own controls contract: translate to toggle when the explicit
      // verb isn't offered, guarded by current state so pause never resumes.
      case 'play': {
        const controls = this.cache.nowPlaying?.controls ?? []
        if (!controls.includes('play') && controls.includes('play_pause')) {
          if (this.cache.playState?.state === 'play') return
          return socket.send('/zone/play_control', { action: 'toggle' })
        }
        return socket.send('/zone/play_control', { action: 'play' })
      }
      case 'pause': {
        const controls = this.cache.nowPlaying?.controls ?? []
        if (!controls.includes('pause') && controls.includes('play_pause')) {
          if (this.cache.playState?.state !== 'play') return
          return socket.send('/zone/play_control', { action: 'toggle' })
        }
        return socket.send('/zone/play_control', { action: 'pause' })
      }
      case 'stop':
        return socket.send('/zone/play_control', { action: 'stop' })
      case 'togglePlayback':
        return socket.send('/zone/play_control', { action: 'toggle' })
      case 'nextTrack':
        return socket.send('/zone/play_control', { skip_track: 1 })
      case 'previousTrack':
        return socket.send('/zone/play_control', { skip_track: -1 })
      case 'seek':
        return socket.send('/zone/play_control', { position: Math.max(0, Math.round(cmd.positionSecs)) })
      case 'playQueueId':
        return socket.send('/zone/play_control', { queue_id: cmd.queueId })
      case 'setRepeat':
        return socket.send('/zone/play_control', { mode_repeat: cmd.mode })
      case 'setShuffle':
        return socket.send('/zone/play_control', { mode_shuffle: cmd.mode })
      case 'recallPreset': {
        this.setRecalledPreset(cmd.presetId)
        socket.send('/zone/recall_preset', { preset: cmd.presetId })
        // Feature 10: the preset's local volume override rides along on every
        // recall through the app — after a beat for the source switch — unless
        // the caller (a schedule with its own volume) opts out.
        if (!cmd.skipVolume) {
          const level =
            getSettings().presetVolumes[presetVolumeKey(this.cache.systemInfo?.udn, cmd.presetId)]
          if (level != null) {
            setTimeout(() => void this.command({ type: 'setVolumePercent', percent: level }), 1200)
          }
        }
        // The device updates is_playing internally but doesn't reliably push
        // /presets/list (vibin's observation, esp. for UPnP presets). Refetch
        // once quickly (radio) and once late (album recalls switch source and
        // load a queue first); source- and queue-change refetches fire between.
        for (const delay of [800, 2800]) {
          setTimeout(() => void this.refreshPresets(socket), delay)
        }
        return
      }
      case 'power':
        // Re-sending ON to a powered-on streamer reboots it (PunyTunes' hard-won guard).
        if (cmd.power === 'ON' && this.cache.systemPower?.power === 'ON') return
        return socket.send('/system/power', { power: cmd.power })
      case 'setMute':
        return socket.send('/zone/state', { mute: cmd.mute })
      case 'setSource':
        return socket.send('/zone/state', { source: cmd.sourceId })
      case 'setVolumeStep':
        return socket.send('/zone/state', { volume_step: cmd.step })
      case 'setVolumePercent':
        return socket.send('/zone/state', { volume_percent: this.clampVolume(cmd.percent) })
      case 'volumeStepChange': {
        const limit = getSettings().volumeLimitPercent
        const current = this.cache.zoneState?.volume_percent
        if (cmd.delta > 0 && limit != null && current != null && current >= limit) return
        return socket.send('/zone/state', { volume_step_change: cmd.delta })
      }
      case 'queueDelete':
        return smoipHttp.queueDelete(host, cmd.id)
      case 'queueMove':
        return smoipHttp.queueMove(host, cmd.id, cmd.from, cmd.to)
      case 'presetDelete':
        await smoipHttp.presetDelete(host, cmd.presetId)
        return this.refreshPresets(socket)
      case 'presetRename':
        await smoipHttp.presetRename(host, cmd.slot, cmd.name)
        return this.refreshPresets(socket)
      case 'queueSavePreset':
        await smoipHttp.queueSavePreset(host, cmd.slot, cmd.name)
        return this.refreshPresets(socket)
      case 'streamRadio':
        return smoipHttp.streamRadio(host, cmd.url, cmd.name)
      // ---- /zone/audio tone controls. One frame per logical control: writes
      // are ATOMIC on the firmware (one bad field rejects the whole frame —
      // the stranded-balance lesson from the 2026-07-19 probe). WS params are
      // JSON, so the '+'-literal query-encoding trap doesn't apply here.
      case 'setUserEq':
        // Boolean ON WRITE — the read returns {enabled, bands}; writing the
        // object shape 400s with code 112.
        return socket.send('/zone/audio', { zone: 'ZONE1', user_eq: cmd.enabled })
      case 'setEqBandGain':
        return socket.send('/zone/audio', {
          zone: 'ZONE1',
          user_eq_bands: bandString([[cmd.index, cmd.gain]])
        })
      case 'setEqBands':
        return socket.send('/zone/audio', {
          zone: 'ZONE1',
          user_eq_bands: bandString(cmd.gains.map((g, i) => [i, g]))
        })
      case 'setTiltEq':
        return socket.send('/zone/audio', { zone: 'ZONE1', tilt_eq: cmd.enabled })
      case 'setTiltIntensity':
        return socket.send('/zone/audio', {
          zone: 'ZONE1',
          tilt_intensity: this.clampSpec(cmd.intensity, this.cache.audioSpec?.tilt_eq)
        })
      case 'setBalance':
        return socket.send('/zone/audio', {
          zone: 'ZONE1',
          balance: this.clampSpec(cmd.balance, this.cache.audioSpec?.balance)
        })
      // ---- §10 device controls (writes over the WS like the power command;
      // ---- standby fields are partial writes to /system/power, so they never
      // ---- carry `power` and can't trip the re-send-ON reboot guard)
      case 'setBrightness':
        return socket.send('/system/display', { brightness: cmd.brightness })
      case 'setStandbyMode':
        return socket.send('/system/power', { standby_mode: cmd.mode })
      case 'setAutoPowerDown': {
        // Clamp to the probed spec range like balance/tilt — the UI only
        // offers in-range presets, but the boundary shouldn't rely on that.
        const r = this.cache.powerSpec?.auto_power_down
        const secs = Math.max(0, Math.round(cmd.seconds))
        return socket.send('/system/power', {
          auto_power_down:
            r?.minimum != null && r?.maximum != null
              ? Math.max(r.minimum, Math.min(r.maximum, secs))
              : secs
        })
      }
      case 'zoneSavePreset':
        await smoipHttp.zoneSavePreset(host, cmd.slot)
        return this.refreshPresets(socket)
      case 'presetMove':
        await smoipHttp.presetMove(host, cmd.from, cmd.to)
        return this.refreshPresets(socket)
    }
  }

  /**
   * Called when the volume limit setting changes: if the streamer is currently
   * louder than the new limit, pull it down to the limit right away.
   */
  enforceVolumeLimit(): void {
    const limit = getSettings().volumeLimitPercent
    const current = this.cache.zoneState?.volume_percent
    if (limit != null && current != null && current > limit) {
      void this.command({ type: 'setVolumePercent', percent: limit })
    }
  }

  private clampVolume(percent: number): number {
    const limit = getSettings().volumeLimitPercent
    const capped = limit != null ? Math.min(percent, limit) : percent
    return Math.max(0, Math.min(100, Math.round(capped)))
  }

  /** Clamp an integer tone value to the spec's published range (fallback ±15). */
  private clampSpec(value: number, range?: { minimum?: number; maximum?: number }): number {
    return Math.max(range?.minimum ?? -15, Math.min(range?.maximum ?? 15, Math.round(value)))
  }

  /**
   * Probe /zone/audio/spec after connect: the tone-controls capability
   * document. Every non-positive outcome (404, timeout, junk) lands as null =
   * "this streamer has no tone controls" and the UI section stays hidden.
   */
  private async probeAudioSpec(socket: SmoipSocket): Promise<void> {
    const spec = (await smoipHttp.getAudioSpec(socket.host)) as ZoneAudioSpec | null
    if (this.socket !== socket) return
    this.cache.audioSpec = spec
    this.push({ kind: 'audioSpec', data: spec })
    if (spec) this.log('info', 'audio', 'tone/EQ spec present — controls enabled where writable')
  }

  /**
   * Probe /system/display/spec + /system/power/spec after connect — the §10
   * brightness/standby capability docs. Every non-positive outcome lands as
   * null (headless unit, timeout) and the matching control stays hidden.
   */
  private async probeSystemSpecs(socket: SmoipSocket): Promise<void> {
    const [display, power] = await Promise.all([
      smoipHttp.getDisplaySpec(socket.host) as Promise<SystemDisplaySpec | null>,
      smoipHttp.getPowerSpec(socket.host) as Promise<SystemPowerSpec | null>
    ])
    if (this.socket !== socket) return
    this.cache.displaySpec = display
    this.cache.powerSpec = power
    this.push({ kind: 'displaySpec', data: display })
    this.push({ kind: 'powerSpec', data: power })
  }

  // ------------------------------------------------------------ incoming frames

  private handleFrame(frame: SmoipFrame): void {
    this.recordFrame('in', frame)
    const data = frame.params?.data
    if (data === undefined) return

    switch (frame.path) {
      case '/zone/play_state':
        this.cache.playState = data as ZonePlayState
        this.trackChangeNotification(this.cache.playState)
        this.recordRecentlyPlayed(this.cache.playState)
        this.sleepBoundaryCheck(this.cache.playState)
        scrobbler.onPlayState(this.cache.playState)
        return this.push({ kind: 'playState', data: this.cache.playState })
      case '/zone/play_state/position':
        this.cache.position = data as ZonePosition
        return this.push({ kind: 'position', data: this.cache.position })
      case '/zone/now_playing':
        this.cache.nowPlaying = data as ZoneNowPlaying
        this.sourceChanged((data as ZoneNowPlaying).source?.id)
        return this.push({ kind: 'nowPlaying', data: this.cache.nowPlaying })
      case '/zone/state':
        this.cache.zoneState = data as ZoneState
        this.sourceChanged((data as ZoneState).source)
        return this.push({ kind: 'zoneState', data: this.cache.zoneState })
      case '/queue/list':
        this.cache.queue = data as QueueList
        // Mid-batch (playlist activation) the cache stays current but the
        // renderer hears nothing — one authoritative push lands at the end.
        if (this.queueBatch) return
        return this.push({ kind: 'queue', data: this.cache.queue })
      case '/presets/list':
        this.cache.presets = data as Presets
        return this.push({ kind: 'presets', data: this.cache.presets })
      case '/system/info':
        this.cache.systemInfo = data as SystemInfo
        return this.push({ kind: 'systemInfo', data: this.cache.systemInfo })
      case '/system/power': {
        const prev = this.cache.systemPower?.power
        this.cache.systemPower = data as SystemPower
        // Waking from standby: re-request the queue — it may have CHANGED
        // shape across the cycle (live-probed 2026-07-23: server queues
        // survive standby, USB queues are dropped; USB remount also lags,
        // hence the second, late refetch).
        if (prev != null && prev !== 'ON' && this.cache.systemPower.power === 'ON') {
          for (const delay of [2500, 10000]) {
            setTimeout(() => this.socket?.isOpen() && this.socket.send('/queue/list'), delay)
          }
        }
        return this.push({ kind: 'systemPower', data: this.cache.systemPower })
      }
      case '/system/update': {
        // Read-only firmware self-check the streamer pushes to subscribers.
        // Camelcase the wire shape into the clean FirmwareStatus the UI reads.
        // We NEVER act on this — see the PASSIVE-ONLY guard in command().
        const u = data as SystemUpdate
        this.cache.firmwareUpdate = {
          updateAvailable: u.update_available === true,
          updating: u.updating === true,
          earlyUpdate: u.early_update === true
        }
        return this.push({ kind: 'firmwareUpdate', data: this.cache.firmwareUpdate })
      }
      case '/system/sources':
        this.cache.sources = data as SystemSources
        return this.push({ kind: 'sources', data: this.cache.sources })
      case '/zone/audio':
        // Pushed on every tone/EQ change, ours or another controller's
        // (confirmed live 2026-07-19) — the UI mirrors external tweaks free.
        this.cache.zoneAudio = data as ZoneAudio
        return this.push({ kind: 'zoneAudio', data: this.cache.zoneAudio })
      case '/system/display':
        this.cache.systemDisplay = data as SystemDisplay
        return this.push({ kind: 'systemDisplay', data: this.cache.systemDisplay })
      case '/queue/info': {
        // The socket already refetches /queue/list. A queue change is also the
        // only observable signal of an album->album preset recall (same source,
        // no /presets/list push) — refresh presets too, debounced.
        if (this.queuePresetsTimer) clearTimeout(this.queuePresetsTimer)
        const socket = this.socket
        this.queuePresetsTimer = setTimeout(() => {
          this.queuePresetsTimer = null
          void this.refreshPresets(socket)
        }, 1000)
        return
      }
      default:
        // Command echoes (/zone/play_control etc.) are visible in the frame log.
        return
    }
  }

  /**
   * Fetch fresh presets over HTTP and push them — vibin's approach. The device
   * doesn't push /presets/list for local-media (UPnP) recalls, and a bare WS
   * request for it isn't proven against real hardware; HTTP GET is.
   */
  private async refreshPresets(socket: SmoipSocket | null): Promise<void> {
    if (!socket || this.socket !== socket) return
    try {
      const data = await smoipHttp.getPresets(socket.host)
      if (data == null || this.socket !== socket) return
      this.cache.presets = data as Presets
      this.push({ kind: 'presets', data: this.cache.presets })
    } catch (err) {
      this.log('warn', 'presets', `refresh failed: ${(err as Error).message}`)
    }
  }

  /**
   * Refetch presets whenever the active audio source changes — vibin's trick.
   * The device updates preset is_playing flags internally on recall but only
   * pushes /presets/list for radio presets; an album (UPnP) recall announces
   * itself as a source switch to MEDIA_PLAYER instead. The first source report
   * after connect is initial state, not a change.
   */
  private sourceChanged(sourceId: string | null | undefined): void {
    if (!sourceId || sourceId === this.lastSourceId) return
    const isInitial = this.lastSourceId === null
    this.lastSourceId = sourceId
    if (isInitial) return
    const socket = this.socket
    setTimeout(() => void this.refreshPresets(socket), 500)
  }

  /**
   * OS notification when the track changes while the app is unfocused. The first
   * play_state after a connect only seeds the key — no notification for it.
   */
  private trackChangeNotification(playState: ZonePlayState): void {
    const md = playState.metadata
    const title = md?.title ?? md?.station ?? null
    if (!title) return
    const key = `${title}|${md?.artist ?? ''}`
    if (key === this.currentTrackKey) return
    const previous = this.currentTrackKey
    this.currentTrackKey = key
    if (previous === null) return

    if (!getSettings().notifications) return
    if (!Notification.isSupported()) return
    if (BrowserWindow.getAllWindows().some((w) => w.isFocused())) return

    const body = [md?.artist, md?.album].filter(Boolean).join(' — ')
    void (async () => {
      let icon
      try {
        if (md?.art_url) {
          const res = await loggedFetch('art', md.art_url, { signal: AbortSignal.timeout(2000) })
          if (res.ok) icon = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()))
        }
      } catch {
        // art is optional
      }
      new Notification({ title, body, silent: true, ...(icon && !icon.isEmpty() ? { icon } : {}) }).show()
    })()
  }

  // ------------------------------------------------------------------ MCP status

  /** Status pushed by the MCP bridge (null = log only, keep current status). */
  setMediaIndex(statuses: MediaIndexStatus[]): void {
    this.mediaIndexStatuses = statuses
    this.push({ kind: 'mediaIndex', statuses })
  }

  setMcpStatus(status: McpStatus | null, logText: string, level: LogEntry['level'] = 'info'): void {
    this.log(level, 'mcp', logText)
    if (status) {
      this.mcpStatus = status
      this.push({ kind: 'mcpStatus', status })
    }
  }

  // ------------------------------------------------------------- recently played

  /**
   * Log each track that plays. recordRecent() collapses consecutive repeats and
   * merges in late-arriving art, so this can fire on every play_state push.
   */
  private recordRecentlyPlayed(ps: ZonePlayState): void {
    // Only log active playback: on connect (or wake) the device re-announces a
    // paused/stopped track's metadata, which must not become a phantom row.
    if (ps.state !== 'play' && ps.state !== 'buffering') return
    const md = ps.metadata
    if (!md) return
    const isRadio = isRadioMetadata(md)
    const station = md.station ?? null
    // Radio titles normalize through the shared helper (absent / station-echo
    // "songs" become null) so recording and matching can never drift.
    const title = isRadio ? radioTrackTitle(md) : (md.title ?? null)
    if (!title && !station) return // nothing identifiable to log

    const sourceId = md.source ?? this.cache.nowPlaying?.source?.id ?? null
    // Continuous sources (radio, AirPlay, Spotify, …) group into one session; a
    // queued local track has a queue_id and stays a discrete row of its own.
    const session =
      ps.queue_id != null
        ? null
        : isRadio
          ? `radio:${station ?? sourceId ?? ''}`
          : `src:${sourceId ?? 'stream'}`

    const entry: RecentTrack = {
      at: Date.now(),
      title,
      artist: md.artist ?? null,
      album: md.album ?? null,
      station,
      artUrl: md.art_url ?? null,
      source: this.cache.nowPlaying?.source?.name ?? md.source ?? null,
      sourceId,
      queueId: ps.queue_id ?? null,
      isRadio,
      radioId: md.radio_id ?? null,
      session
    }
    const { list, changed } = recordRecent(entry)
    if (changed) this.push({ kind: 'recents', data: list })
  }

  clearRecents(): void {
    this.push({ kind: 'recents', data: clearRecents() })
  }

  recentsRestore(list: Parameters<typeof restoreRecents>[0]): void {
    this.push({ kind: 'recents', data: restoreRecents(list) })
  }

  // ------------------------------------------------------------------ favorites

  /** Favorites mutations live here so every window sees the push. */
  favoriteAdd(fav: Parameters<typeof addFavorite>[0]): ReturnType<typeof getFavorites> {
    const list = addFavorite(fav)
    this.push({ kind: 'favorites', data: list })
    return list
  }

  private queueBatch = false
  private activation: PlaylistActivation | null = null
  private activationCancelled = false

  /** Live activation state, for the boot snapshot. */
  get playlistActivation(): PlaylistActivation | null {
    return this.activation
  }

  cancelPlaylistActivation(): void {
    if (this.activation && !this.activation.finished) this.activationCancelled = true
  }

  /**
   * Replace the streamer's queue with a stored playlist.
   *
   * Shape dictated by the firmware (confirmed against vibin, which solved this
   * first): entries go in ONE AT A TIME and each needs its media server's DIDL,
   * so this is ~2 round-trips per track and genuinely slow — hence progress and
   * cancellation. Every add also emits /queue/info, which normally refetches the
   * whole list; the batch suppresses that at the wire AND at the push, then
   * fetches once at the end. vibin used a bare boolean that cleared before the
   * adds had settled; the single reconciling fetch is what makes ours safe.
   *
   * A stale objectId is not a failure: ids are hints, content is identity, so a
   * miss re-resolves by search and HEALS the stored entry (the favorites move).
   * Anything genuinely gone is reported, not silently dropped.
   */
  async playlistActivate(id: string): Promise<PlaylistActivation> {
    const playlist = getPlaylists().find((p) => p.id === id)
    if (!playlist) throw new Error('No such playlist')
    const host = this.connection.phase === 'connected' ? this.connection.host : null
    if (!host) throw new Error('Not connected')
    // ONE run at a time. The UI greys its Play buttons during a run, but MCP's
    // play_playlist has no such gate — two interleaved runs would fight over
    // REPLACE/APPEND, the batch flags, and this.activation itself. The claim
    // below is synchronous with this check: no await between them.
    if (this.activation && !this.activation.finished) {
      throw new Error(`Already loading "${this.activation.name}" — cancel that run first`)
    }

    this.activationCancelled = false
    this.activation = {
      playlistId: id,
      name: playlist.name,
      total: playlist.items.length,
      done: 0,
      added: 0,
      missed: [],
      cancelled: false,
      finished: false
    }
    const announce = (): void => this.push({ kind: 'playlistActivation', state: this.activation })
    announce()

    // Nothing has touched the queue until this flips — a run that dies waking
    // the device must not stamp lastPlayedAt on a playlist it never loaded.
    let batchStarted = false

    // The FIRST successful add REPLACEs (clearing what was there); everything
    // after appends. Keyed off success, not index — if entry one can't be
    // resolved, entry two must still be the one that clears the old queue.
    let replaced = false
    try {
      await this.ensureAwake() // activating is a play-shaped intent

      this.queueBatch = true
      batchStarted = true
      if (this.socket) this.socket.suppressQueueRefetch = true
      for (const [index, item] of playlist.items.entries()) {
        if (this.activationCancelled) break
        const action: MediaQueueAction = replaced ? 'APPEND' : 'REPLACE'
        let landed = false

        if (item.serverUdn && item.objectId) {
          try {
            await queueAdd(host, item.serverUdn, item.objectId, action)
            landed = true
          } catch {
            // stale id — fall through to the content re-resolve
          }
        }

        if (!landed && !this.activationCancelled) {
          // Content re-resolve. This used to walk `searchable` servers only,
          // which meant an entry living on a Browse-only server (USB) could
          // never heal; resolveContent asks the indexes first, so it can.
          const found = await resolveContent(host, item)
          if (found) {
            try {
              await queueAdd(host, found.serverUdn, found.objectId, action)
              landed = true
              // heal in place — no updatedAt bump, so the collection keeps its order
              healPlaylistItem(id, index, item, found)
            } catch {
              // couldn't add it after all — counted as missed below
            }
          }
        }

        if (landed) {
          replaced = true
          this.activation.added += 1
        } else {
          this.activation.missed.push(item.title)
        }
        this.activation.done += 1
        announce()
      }
    } finally {
      this.queueBatch = false
      if (this.socket) this.socket.suppressQueueRefetch = false
      if (batchStarted) {
        // ONE authoritative read of the truth, whatever happened above. The
        // send throws on a half-dead socket (by design); swallowed HERE only,
        // so cleanup can't mask the loop's real error — reconnect resubscribes
        // /queue/list and delivers the same truth anyway.
        try {
          this.socket?.send('/queue/list')
        } catch {
          /* reconnect refetches */
        }
      }
      this.activation.cancelled = this.activationCancelled
      this.activation.finished = true
      // Stamp the attempt only if the queue was actually touched: a run that
      // died before the batch began didn't play anything and has no misses to
      // report — lastPlayedAt claiming otherwise would be a small lie.
      if (batchStarted) markPlaylistPlayed(id, this.activation.missed)
      announce()
      this.push({ kind: 'playlists', data: getPlaylists() })
    }
    return this.activation
  }

  // Playlist writes mirror the favorites verbs: mutate the bounded local file,
  // push the whole list, return it to the caller that asked.
  private pushPlaylists(list: ReturnType<typeof getPlaylists>): ReturnType<typeof getPlaylists> {
    this.push({ kind: 'playlists', data: list })
    return list
  }

  /** Returns the CREATED playlist (its stored name may have been uniquified). */
  playlistCreate(name: string, items: Parameters<typeof createPlaylist>[1]): Playlist {
    const { list, created } = createPlaylist(name, items)
    this.pushPlaylists(list)
    return created
  }

  playlistRename(id: string, name: string): ReturnType<typeof getPlaylists> {
    return this.pushPlaylists(renamePlaylist(id, name))
  }

  playlistDelete(id: string): ReturnType<typeof getPlaylists> {
    return this.pushPlaylists(deletePlaylist(id))
  }

  playlistRestore(playlist: Parameters<typeof restorePlaylist>[0]): ReturnType<typeof getPlaylists> {
    return this.pushPlaylists(restorePlaylist(playlist))
  }

  /**
   * Put a removed track back in the queue at `position` — the undo behind the
   * queue's ×.
   *
   * BEST-EFFORT BY NATURE, and the honesty matters more than the success rate.
   * A queue row carries no serverUdn/objectId (QueueListItem is id/position/
   * metadata), and the firmware's queue/add needs DIDL for a specific object,
   * so this is a re-RESOLVE and re-ADD, not a rollback: find the track by
   * content, append it, then move it from the end back to where it was. Every
   * path that fills a queue goes through a media server, so in practice the
   * resolve succeeds; when it can't, the caller says so rather than pretending.
   *
   * The position restore is deliberately not fatal — a track back in the wrong
   * slot beats a track that didn't come back.
   */
  async queueRestore(ref: ContentRef, position: number): Promise<QueueRestoreResult> {
    const conn = this.snapshot().connection
    if (conn.phase !== 'connected') return 'failed'
    const host = conn.host

    const found = await resolveContent(host, ref)
    if (!found) return 'not-found'

    const before = this.cache.queue?.items?.length ?? 0
    try {
      await queueAdd(host, found.serverUdn, found.objectId, 'APPEND')
    } catch {
      return 'failed'
    }

    // APPEND lands at the end, but the id it landed under only arrives with the
    // next /queue/list push — ask for one and wait for the queue to actually
    // grow rather than assuming a fixed delay.
    try {
      this.socket?.send('/queue/list')
    } catch {
      return 'ok' // it IS in the queue; reconnect will refetch and show it
    }
    const grown = await this.waitForQueue((q) => (q.items?.length ?? 0) > before, 4000)
    if (!grown) return 'ok'

    const items = grown.items ?? []
    const from = items.length - 1
    const landed = items[from]
    const to = Math.max(0, Math.min(position, from))
    if (landed?.id != null && to !== from) {
      try {
        await smoipHttp.queueMove(host, landed.id, from, to)
      } catch {
        // it's in the queue, just not where it was — see the doc comment
      }
    }
    return 'ok'
  }

  /**
   * Renderer-facing content resolution — the same index-first, live-fallback
   * search queue undo and playlist healing use, exposed so ANY surface can act
   * on a track it knows only by content (a recently-played entry, a favorite
   * whose server changed). Null when disconnected or nothing matches.
   */
  async contentResolve(ref: ContentRef): Promise<ResolvedContent | null> {
    const conn = this.snapshot().connection
    if (conn.phase !== 'connected') return null
    return resolveContent(conn.host, ref)
  }

  /** Resolve with the first cached queue satisfying `test`, or null on timeout. */
  private waitForQueue(test: (q: QueueList) => boolean, timeoutMs: number): Promise<QueueList | null> {
    if (this.cache.queue && test(this.cache.queue)) return Promise.resolve(this.cache.queue)
    return new Promise((resolve) => {
      const started = Date.now()
      const tick = setInterval(() => {
        if (this.cache.queue && test(this.cache.queue)) {
          clearInterval(tick)
          resolve(this.cache.queue)
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(tick)
          resolve(null)
        }
      }, 120)
    })
  }

  playlistSetItems(id: string, items: Parameters<typeof setPlaylistItems>[1]): ReturnType<typeof getPlaylists> {
    return this.pushPlaylists(setPlaylistItems(id, items))
  }

  playlistAppend(id: string, items: Parameters<typeof appendToPlaylist>[1]): ReturnType<typeof getPlaylists> {
    return this.pushPlaylists(appendToPlaylist(id, items))
  }

  favoriteRemove(key: string): ReturnType<typeof getFavorites> {
    const list = removeFavorite(key)
    this.push({ kind: 'favorites', data: list })
    return list
  }

  favoriteUpdate(key: string, patch: Parameters<typeof updateFavorite>[1]): ReturnType<typeof getFavorites> {
    const list = updateFavorite(key, patch)
    this.push({ kind: 'favorites', data: list })
    return list
  }

  // ----------------------------------------------------------------- push relay

  private push(msg: PushMessage): void {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send('tt:push', msg)
    }
  }

  private setRecalledPreset(id: number | null): void {
    if (id === this.lastRecalledPresetId) return
    this.lastRecalledPresetId = id
    this.push({ kind: 'recalledPreset', id })
  }

  private setConnection(state: ConnectionState): void {
    if (state.phase !== 'idle' && this.demo) state.demo = true
    this.connection = state
    // Wallclock-based listen accounting can't survive a dead link or a device
    // switch — drop the in-flight track rather than over-count it.
    if (state.phase !== 'connected') scrobbler.reset()
    this.push({ kind: 'connection', state })
  }

  private pushDevices(): void {
    this.push({ kind: 'devices', devices: this.devices, discovering: this.discovering })
  }

  private recordFrame(dir: 'in' | 'out', frame: SmoipFrame): void {
    const entry: FrameEntry = { at: Date.now(), dir, frame }
    this.frames.push(entry)
    if (this.frames.length > FRAME_RING_SIZE) this.frames.shift()
    this.push({ kind: 'frame', entry })
  }

  private log(level: LogEntry['level'], scope: string, text: string): void {
    const entry: LogEntry = { at: Date.now(), level, scope, text }
    this.logs.push(entry)
    if (this.logs.length > LOG_RING_SIZE) this.logs.shift()
    this.push({ kind: 'log', entry })
    console.log(`[${scope}] ${text}`)
  }

  // ------------------------------------------------------------------- snapshot

  snapshot(): Snapshot {
    return {
      connection: this.connection,
      devices: this.devices,
      discovering: this.discovering,
      settings: getSettings(),
      ...this.cache,
      sleep: this.sleep,
      lastRecalledPresetId: this.lastRecalledPresetId,
      recents: getRecents(),
      favorites: getFavorites(),
      playlists: getPlaylists(),
      playlistActivation: this.activation,
      mcpStatus: this.mcpStatus,
      mediaIndex: this.mediaIndexStatuses,
      frames: this.frames,
      logs: this.logs,
      netRequests: getNetRequests()
    }
  }
}
