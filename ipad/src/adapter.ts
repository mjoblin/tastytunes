// createTtAdapter(): the TastyTunesApi seam reimplemented for browser
// runtimes. What Electron's main process does across deviceManager +
// smoipSocket happens here in-page: SMOIP socket, state cache, push fan-out
// in the exact PushMessage shapes the renderer store already consumes.
//
// Spike scope: connection + transport/zone commands + snapshot + media
// browse are REAL (proven against the mock streamer). Everything marked
// TODO(port) is a stub with the port-phase plan noted inline.
import type {
  AppSettings,
  DiscoveredDevice,
  ConnectionState,
  LyricsQuery,
  LyricsResult,
  MediaNode,
  MediaQueueAction,
  MediaServerInfo,
  PushMessage,
  RecentTrack,
  SleepTimer,
  Snapshot,
  StreamerCommand,
  TastyTunesApi
} from '../../src/shared/ipc'
import type {
  Presets,
  QueueList,
  SystemInfo,
  SystemPower,
  SystemSources,
  ZoneNowPlaying,
  ZonePlayState,
  ZonePosition,
  ZoneState
} from '../../src/shared/smoip'
import { browseChildren, fetchServers } from './browse.js'
import { SmoipClient, type SmoipFrame } from './smoipClient.js'

// TODO(port): hoist the real defaults out of src/main/persist.ts into
// src/shared/ and back this with Capacitor Preferences. The cast is spike
// scaffolding — the renderer boots with whatever fields it reads defaulting
// to undefined.
const SETTINGS_STUB = {} as AppSettings

export function createTtAdapter(): TastyTunesApi {
  let client: SmoipClient | null = null
  let connection: ConnectionState = { phase: 'idle' }
  const listeners = new Set<(msg: PushMessage) => void>()

  const cache: {
    playState: ZonePlayState | null
    position: ZonePosition | null
    nowPlaying: ZoneNowPlaying | null
    zoneState: ZoneState | null
    queue: QueueList | null
    presets: Presets | null
    systemInfo: SystemInfo | null
    systemPower: SystemPower | null
    sources: SystemSources | null
  } = {
    playState: null,
    position: null,
    nowPlaying: null,
    zoneState: null,
    queue: null,
    presets: null,
    systemInfo: null,
    systemPower: null,
    sources: null
  }

  const push = (msg: PushMessage): void => {
    for (const cb of listeners) cb(msg)
  }
  const setConnection = (state: ConnectionState): void => {
    connection = state
    push({ kind: 'connection', state })
  }

  const handleFrame = (frame: SmoipFrame): void => {
    const data = frame.params?.data
    if (data == null || !frame.path) return
    switch (frame.path) {
      case '/zone/play_state':
        cache.playState = data as ZonePlayState
        return push({ kind: 'playState', data: cache.playState })
      case '/zone/play_state/position':
        cache.position = data as ZonePosition
        return push({ kind: 'position', data: cache.position })
      case '/zone/now_playing':
        cache.nowPlaying = data as ZoneNowPlaying
        return push({ kind: 'nowPlaying', data: cache.nowPlaying })
      case '/zone/state':
        cache.zoneState = data as ZoneState
        return push({ kind: 'zoneState', data: cache.zoneState })
      case '/queue/list':
        cache.queue = data as QueueList
        return push({ kind: 'queue', data: cache.queue })
      case '/presets/list':
        cache.presets = data as Presets
        return push({ kind: 'presets', data: cache.presets })
      case '/system/info':
        cache.systemInfo = data as SystemInfo
        return push({ kind: 'systemInfo', data: cache.systemInfo })
      case '/system/power':
        cache.systemPower = data as SystemPower
        return push({ kind: 'systemPower', data: cache.systemPower })
      case '/system/sources':
        cache.sources = data as SystemSources
        return push({ kind: 'sources', data: cache.sources })
    }
  }

  const streamerHost = (): string => {
    if (connection.phase !== 'connected') throw new Error('not connected to a streamer')
    return connection.host
  }

  // Server endpoints resolved once per mediaServers() call, keyed by udn for
  // the browse calls that follow (mirrors upnpBrowser's module cache).
  const serverEndpoints = new Map<string, string>()

  const todo = (what: string): never => {
    throw new Error(`TODO(port): ${what} not implemented in the iPad spike`)
  }

  return {
    storeBuild: false,

    getSnapshot: (): Promise<Snapshot> =>
      Promise.resolve({
        connection,
        devices: [] as DiscoveredDevice[], // TODO(port): zeroconf discovery
        discovering: false,
        settings: SETTINGS_STUB,
        ...cache,
        sleep: null, // TODO(port): sleep timer lives client-side on iPad
        recents: [] as RecentTrack[], // TODO(port): Preferences-backed recents
        mcpStatus: { running: false, url: null, error: null }, // MCP dropped on iPad
        frames: [],
        logs: [],
        netRequests: []
      }),

    // TODO(port): Bonjour/zeroconf plugin — the Evo advertises
    // _stream-magic._tcp (live-verified), no multicast entitlement needed.
    discover: (): Promise<DiscoveredDevice[]> => Promise.resolve([]),

    connect: (host: string): Promise<void> => {
      client?.close()
      const c = new SmoipClient(host, {
        onFrame: (f) => {
          if (client === c) handleFrame(f)
        },
        onConnecting: (attempt) => {
          if (client === c) setConnection({ phase: 'connecting', host, attempt })
        },
        onConnected: () => {
          if (client === c) setConnection({ phase: 'connected', host })
        },
        onDisconnected: (reason, reconnecting) => {
          if (client === c) setConnection({ phase: 'disconnected', host, reason, reconnecting })
        }
      })
      client = c
      c.connect()
      return Promise.resolve()
    },

    disconnect: (): Promise<void> => {
      client?.close()
      client = null
      setConnection({ phase: 'idle' })
      return Promise.resolve()
    },

    // The desktop demo device is an Electron-main construct; the iPad demo
    // needs the same state machine in-page. TODO(port): share the demo data
    // core via src/shared/.
    demoStart: (): Promise<void> => todo('demo mode'),

    command: (cmd: StreamerCommand): Promise<void> => {
      const c = client
      if (!c || connection.phase !== 'connected') return Promise.resolve()
      switch (cmd.type) {
        case 'play':
          c.send('/zone/play_control', { action: 'play' })
          break
        case 'pause':
          c.send('/zone/play_control', { action: 'pause' })
          break
        case 'stop':
          c.send('/zone/play_control', { action: 'stop' })
          break
        case 'togglePlayback':
          c.send('/zone/play_control', { action: 'toggle' })
          break
        case 'nextTrack':
          c.send('/zone/play_control', { skip_track: 1 })
          break
        case 'previousTrack':
          c.send('/zone/play_control', { skip_track: -1 })
          break
        case 'seek':
          c.send('/zone/play_control', { position: Math.max(0, Math.round(cmd.positionSecs)) })
          break
        case 'playQueueId':
          c.send('/zone/play_control', { queue_id: cmd.queueId })
          break
        case 'setRepeat':
          c.send('/zone/play_control', { mode_repeat: cmd.mode })
          break
        case 'setShuffle':
          c.send('/zone/play_control', { mode_shuffle: cmd.mode })
          break
        case 'setMute':
          c.send('/zone/state', { mute: cmd.mute })
          break
        case 'setSource':
          c.send('/zone/state', { source: cmd.sourceId })
          break
        case 'setVolumeStep':
          c.send('/zone/state', { volume_step: cmd.step })
          break
        case 'setVolumePercent':
          // TODO(port): volume-limit clamp once settings persistence lands
          c.send('/zone/state', { volume_percent: cmd.percent })
          break
        case 'power':
          // Re-sending ON to a powered-on streamer reboots it (desktop guard kept)
          if (cmd.power === 'ON' && cache.systemPower?.power === 'ON') break
          c.send('/system/power', { power: cmd.power })
          break
        case 'recallPreset':
          // TODO(port): preset-volume ride-along + is_playing refetches
          c.send('/zone/recall_preset', { preset: cmd.presetId })
          break
        default:
          // TODO(port): queueDelete/queueMove/presetDelete/presetMove and the
          // volumeStepChange helper — verbatim frames live in deviceManager.ts
          break
      }
      return Promise.resolve()
    },

    openExternal: (url: string): Promise<void> => {
      window.open(url, '_blank')
      return Promise.resolve()
    },

    getSettings: (): Promise<AppSettings> => Promise.resolve(SETTINGS_STUB),
    setSettings: (): Promise<AppSettings> => todo('settings persistence (Capacitor Preferences)'),

    // With CapacitorHttp there is no CORS to bypass — the renderer can load
    // art URLs directly. TODO(port): return null and teach ArtImage the direct
    // path, or proxy through CapacitorHttp as data URLs for parity.
    fetchArt: (): Promise<{ dataUrl: string } | null> => Promise.resolve(null),

    fetchLyrics: (_q: LyricsQuery, _force?: boolean): Promise<LyricsResult | null> =>
      todo('lyrics via direct LRCLIB fetch'),
    lbValidate: (): Promise<{ valid: boolean; userName: string | null } | null> =>
      todo('ListenBrainz scrobbling'),
    updateDownload: (): Promise<void> => Promise.resolve(), // TestFlight/App Store owns updates
    updateInstall: (): Promise<void> => Promise.resolve(),
    fetchArtistInfo: (): Promise<null> => todo('artist context via direct fetch'),
    fetchAlbumInfo: (): Promise<null> => todo('album context via direct fetch'),
    toggleMini: (): Promise<void> => Promise.resolve(), // mini player dropped on iPad
    showMain: (): Promise<void> => Promise.resolve(),
    setSleep: (_s: SleepTimer | null): Promise<void> => todo('client-side sleep timer'),
    getRecents: (): Promise<RecentTrack[]> => Promise.resolve([]),
    clearRecents: (): Promise<void> => Promise.resolve(),
    lookupCacheStats: (): Promise<{ entries: number; bytes: number }> =>
      Promise.resolve({ entries: 0, bytes: 0 }),
    clearLookupCaches: (): Promise<{ entries: number; bytes: number }> =>
      Promise.resolve({ entries: 0, bytes: 0 }),

    mediaServers: async (): Promise<MediaServerInfo[]> => {
      const endpoints = await fetchServers(streamerHost())
      serverEndpoints.clear()
      for (const e of endpoints) serverEndpoints.set(e.udn, e.controlUrl)
      return endpoints.map(({ controlUrl: _cu, ...info }) => info)
    },

    mediaBrowse: async (serverUdn: string, objectId: string | null): Promise<MediaNode[]> => {
      const controlUrl = serverEndpoints.get(serverUdn)
      if (!controlUrl) throw new Error(`unknown media server ${serverUdn} — call mediaServers first`)
      return browseChildren(controlUrl, objectId ?? '0')
    },

    mediaSearch: (): Promise<{ items: MediaNode[]; total: number }> =>
      todo('ContentDirectory search'),
    mediaQueueAdd: (
      _serverUdn: string,
      _objectId: string,
      _action: MediaQueueAction,
      _playFromId?: string
    ): Promise<void> => todo('queue add via /smoip/queue/add with verbatim DIDL'),
    mediaPresetSave: (): Promise<void> => todo('preset save via /smoip/queue/add action=PRESET'),

    onPush: (cb: (msg: PushMessage) => void): (() => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
