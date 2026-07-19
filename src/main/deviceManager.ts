// Orchestrates discovery, the SMOIP socket, command dispatch, and the push relay
// to renderer windows. Mirrors PunyTunes' StreamMagicManager, translated to Node.

import { BrowserWindow, Notification, nativeImage, webContents } from 'electron'
import {
  presetVolumeKey,
  sleepTrackKey,
  type ConnectionState,
  type DiscoveredDevice,
  type FrameEntry,
  type LogEntry,
  type McpStatus,
  type PushMessage,
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
  SystemSources,
  ZoneNowPlaying,
  ZonePlayState,
  ZonePosition,
  ZoneState
} from '@shared/smoip'
import { isRadioMetadata, radioTrackTitle } from '@shared/smoip'
import { discoverStreamers } from './discovery'
import { SmoipSocket } from './smoipSocket'
import * as smoipHttp from './smoipHttp'
import { getSettings, updateSettings } from './persist'
import { clearRecents, getRecents, recordRecent } from './recents'
import { scrobbler } from './scrobbler'
import { getNetRequests, loggedFetch } from './netlog'

const FRAME_RING_SIZE = 300
const LOG_RING_SIZE = 300

interface Cache {
  playState: ZonePlayState | null
  position: ZonePosition | null
  nowPlaying: ZoneNowPlaying | null
  zoneState: ZoneState | null
  queue: QueueList | null
  presets: Presets | null
  systemInfo: SystemInfo | null
  systemPower: SystemPower | null
  sources: SystemSources | null
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
  sources: null
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
        if (isCurrent(socket)) this.setConnection({ phase: 'connected', host })
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

    switch (cmd.type) {
      case 'play':
        return socket.send('/zone/play_control', { action: 'play' })
      case 'pause':
        return socket.send('/zone/play_control', { action: 'pause' })
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
        return this.push({ kind: 'queue', data: this.cache.queue })
      case '/presets/list':
        this.cache.presets = data as Presets
        return this.push({ kind: 'presets', data: this.cache.presets })
      case '/system/info':
        this.cache.systemInfo = data as SystemInfo
        return this.push({ kind: 'systemInfo', data: this.cache.systemInfo })
      case '/system/power':
        this.cache.systemPower = data as SystemPower
        return this.push({ kind: 'systemPower', data: this.cache.systemPower })
      case '/system/sources':
        this.cache.sources = data as SystemSources
        return this.push({ kind: 'sources', data: this.cache.sources })
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
      mcpStatus: this.mcpStatus,
      frames: this.frames,
      logs: this.logs,
      netRequests: getNetRequests()
    }
  }
}
