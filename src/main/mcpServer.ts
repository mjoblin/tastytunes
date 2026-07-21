// The MCP server: a Streamable-HTTP endpoint in the main process so local AI
// agents and other MCP clients can drive the streamer.
//
// Stateless per the SDK's documented pattern: each POST gets a fresh
// McpServer + transport, so settings changes (tool/cluster toggles) apply to
// the very next request without a restart. Every command goes through
// DeviceManager.command, so agents inherit the volume-limit clamp and the
// power-ON reboot guard exactly like the UI. Tool/cluster identity lives in
// MCP_CLUSTERS (shared with the Settings screen); this file supplies each
// tool's input schema and handler.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z, type ZodRawShape } from 'zod'
import {
  MCP_CLUSTERS,
  favoriteKey,
  mcpClusterEnabled,
  sleepTrackKey,
  type Favorite,
  type MediaNode,
  type MediaQueueAction,
  type Snapshot
} from '@shared/ipc'
import { EQ_GAIN_MAX, EQ_GAIN_MIN, audioCaps, brightnessOptions } from '@shared/smoip'
import { app } from 'electron'
import type { DeviceManager } from './deviceManager'
import { getSettings } from './persist'
import { fetchArtistInfo } from './artistInfo'
import { fetchLyrics } from './lyrics'
import { radioSearch } from './radioBrowser'
import { queueAdd, refreshServers } from './upnpBrowser'
import { searchServer as librarySearch } from './mediaIndex'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

interface ToolImpl {
  inputSchema?: ZodRawShape
  handler(args: Record<string, unknown>): Promise<ToolResult> | ToolResult
}

const ok = (payload: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }]
})
const err = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true
})

/** First non-internal IPv4 address, for the reachable URL when bound to LAN. */
function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return null
}

export class McpBridge {
  private http: Server | null = null
  private active: { bind: McpSettings['bind']; port: number } | null = null

  constructor(private dm: DeviceManager) {}

  /** Bring the server in line with settings: start, stop, or move host/port. */
  sync(settings: { mcp: McpSettings }): void {
    const mcp = settings.mcp
    if (!mcp.enabled) {
      this.stop()
      return
    }
    if (this.http && this.active && this.active.bind === mcp.bind && this.active.port === mcp.port) {
      return // running in the right place; tool toggles apply per-request
    }
    this.stop(true)
    this.start(mcp)
  }

  stop(restarting = false): void {
    if (!this.http) return
    // close() only stops NEW connections — drop live keep-alive sockets too,
    // or a same-port restart (bind flip) races the drain into EADDRINUSE.
    this.http.closeAllConnections()
    this.http.close()
    this.http = null
    this.active = null
    if (!restarting) {
      this.dm.setMcpStatus({ running: false, url: null, error: null }, 'stopped')
    }
  }

  private start(mcp: McpSettings): void {
    const host = mcp.bind === 'lan' ? '0.0.0.0' : '127.0.0.1'
    const server = createServer((req, res) => void this.route(req, res, mcp.bind))
    server.on('error', (e: NodeJS.ErrnoException) => {
      this.http = null
      this.active = null
      const reason =
        e.code === 'EADDRINUSE' ? `port ${mcp.port} is already in use` : (e.message ?? 'failed to start')
      this.dm.setMcpStatus({ running: false, url: null, error: reason }, `error: ${reason}`, 'error')
    })
    server.listen(mcp.port, host, () => {
      const shown = mcp.bind === 'lan' ? (lanAddress() ?? '0.0.0.0') : '127.0.0.1'
      const url = `http://${shown}:${mcp.port}/mcp`
      this.dm.setMcpStatus({ running: true, url, error: null }, `listening on ${url} (${mcp.bind})`)
    })
    this.http = server
    this.active = { bind: mcp.bind, port: mcp.port }
  }

  private async route(req: IncomingMessage, res: ServerResponse, bind: McpSettings['bind']): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal')
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    // DNS-rebinding guard for the localhost bind: a malicious web page can make
    // a browser POST to 127.0.0.1, but it can't forge the Host header.
    if (bind === 'localhost') {
      const host = (req.headers.host ?? '').split(':')[0]
      if (host !== '127.0.0.1' && host !== 'localhost') {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'forbidden host' }))
        return
      }
    }
    if (req.method !== 'POST') {
      // Stateless mode: no SSE stream to resume, no session to delete.
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed — POST JSON-RPC to this endpoint.' },
          id: null
        })
      )
      return
    }

    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'))

      const mcpServer = this.buildServer()
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true
      })
      res.on('close', () => {
        void transport.close()
        void mcpServer.close()
      })
      await mcpServer.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      this.dm.setMcpStatus(null, `request failed: ${(e as Error).message}`, 'warn')
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null
          })
        )
      }
    }
  }

  /** A fresh server per request, registering only the currently-enabled tools. */
  private buildServer(): McpServer {
    const server = new McpServer({ name: 'tastytunes', version: app.getVersion() })
    const impls = this.toolImpls()
    const mcp = getSettings().mcp
    const { disabledTools } = mcp

    for (const cluster of MCP_CLUSTERS) {
      // Opt-in (write-capable) clusters require an explicit enable in Settings.
      if (!mcpClusterEnabled(cluster, mcp)) continue
      for (const tool of cluster.tools) {
        if (disabledTools.includes(tool.name)) continue
        const impl = impls[tool.name]
        if (!impl) continue
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: impl.inputSchema,
            annotations: { readOnlyHint: cluster.readOnly === true, openWorldHint: false }
          },
          (async (args: Record<string, unknown>) => {
            try {
              return await impl.handler(args ?? {})
            } catch (e) {
              return err((e as Error).message)
            }
          }) as never
        )
      }
    }
    return server
  }

  // --------------------------------------------------------------- tool handlers

  /** Snapshot when connected, or a throw that becomes a clean tool error. */
  private connected(): Snapshot {
    const snap = this.dm.snapshot()
    if (snap.connection.phase !== 'connected') {
      throw new Error(
        'Not connected to a streamer. Use list_devices and connect_device, or open TastyTunes to connect.'
      )
    }
    return snap
  }

  private toolImpls(): Record<string, ToolImpl> {
    const dm = this.dm

    const lc = (x: string | null | undefined): string => (x ?? '').trim().toLowerCase()
    const kindOf = (n: MediaNode): 'album' | 'artist' | 'track' | 'folder' =>
      n.upnpClass.includes('musicAlbum')
        ? 'album'
        : n.upnpClass.includes('Artist') || n.upnpClass.includes('person')
          ? 'artist'
          : n.upnpClass.includes('audioItem')
            ? 'track'
            : 'folder'
    const QUEUE_MODES: Record<string, MediaQueueAction> = {
      play_now: 'PLAY_NOW',
      play_next: 'PLAY_NEXT',
      append: 'APPEND',
      replace: 'REPLACE'
    }

    /** Tone/EQ gate: caps when the streamer has them, a clean error otherwise. */
    const toneCaps = (): { s: Snapshot; caps: NonNullable<ReturnType<typeof audioCaps>> } => {
      const s = this.connected()
      const caps = audioCaps(s.audioSpec)
      if (!caps) throw new Error('This streamer has no tone/EQ controls.')
      return { s, caps }
    }

    /** The preset-save contract: an occupied slot needs overwrite: true. */
    const guardSlot = (s: Snapshot, slot: number, overwrite: boolean): void => {
      const existing = (s.presets?.presets ?? []).find((p) => p.id === slot)
      if (existing && !overwrite) {
        throw new Error(
          `Slot ${slot} already holds "${existing.name ?? 'a preset'}". Pass overwrite: true to replace it.`
        )
      }
    }

    const status = (): unknown => {
      const s = dm.snapshot()
      if (s.connection.phase !== 'connected') {
        return {
          connection: s.connection.phase,
          hint: 'Not connected. Use list_devices and connect_device.'
        }
      }
      const md = s.playState?.metadata
      const activeSourceId = s.zoneState?.source ?? s.nowPlaying?.source?.id ?? null
      const sourceName =
        s.sources?.sources?.find((x) => x.id === activeSourceId)?.name ??
        s.nowPlaying?.source?.name ??
        null
      return {
        connection: 'connected',
        device: { name: s.systemInfo?.name ?? null, model: s.systemInfo?.model ?? null, host: s.connection.host },
        power: s.systemPower?.power ?? null,
        source: activeSourceId ? { id: activeSourceId, name: sourceName } : null,
        playback: {
          state: s.playState?.state ?? null,
          title: md?.title ?? null,
          artist: md?.artist ?? null,
          album: md?.album ?? null,
          station: md?.station ?? null,
          position_seconds: s.position?.position ?? s.playState?.position ?? null,
          duration_seconds: md?.duration ?? null,
          queue_index: s.playState?.queue_index ?? null,
          queue_length: s.playState?.queue_length ?? null,
          shuffle: s.playState?.mode_shuffle ?? null,
          repeat: s.playState?.mode_repeat ?? null,
          // Track-content match against the favorites (station URLs aren't
          // knowable from playback metadata, so stations report null here).
          favorited:
            md?.title != null && !md.station
              ? s.favorites.some(
                  (f) =>
                    favoriteKey(f) ===
                    favoriteKey({
                      kind: 'track',
                      addedAt: 0,
                      title: md.title!,
                      artist: md.artist ?? null,
                      album: md.album ?? null,
                      artUrl: null,
                      serverUdn: null,
                      serverName: null,
                      objectId: null,
                      titlePath: null
                    })
                )
              : null,
          format: md
            ? {
                codec: md.codec,
                sample_rate: md.sample_rate,
                bit_depth: md.bit_depth,
                lossless: md.lossless,
                bitrate: md.bitrate
              }
            : null
        },
        volume: {
          percent: s.zoneState?.volume_percent ?? null,
          step: s.zoneState?.volume_step ?? null,
          muted: s.zoneState?.mute ?? null,
          limit_percent: getSettings().volumeLimitPercent
        },
        // Tone/EQ — present only on streamers whose firmware has the controls.
        audio: (() => {
          const caps = audioCaps(s.audioSpec)
          if (!caps) return null
          const za = s.zoneAudio
          return {
            user_eq_enabled: za?.user_eq?.enabled ?? false,
            band_gains_db: za?.user_eq?.bands?.map((b) => b.gain) ?? null,
            tilt: za?.tilt_eq ? { enabled: za.tilt_eq.enabled, intensity: za.tilt_eq.intensity } : null,
            balance: za?.balance ?? null
          }
        })(),
        display: s.systemDisplay ? { brightness: s.systemDisplay.brightness } : null,
        sleep_timer: s.sleep
          ? {
              action: s.sleep.action,
              fires_at: s.sleep.firesAt,
              end_of_track: s.sleep.minutes == null
            }
          : null
      }
    }

    return {
      // ---- status & lists
      get_status: { handler: () => ok(status()) },
      list_queue: {
        handler: () => {
          const s = this.connected()
          return ok({
            current_id: s.queue?.play_id ?? null,
            total: s.queue?.total ?? 0,
            items: (s.queue?.items ?? []).map((i) => ({
              id: i.id,
              position: i.position,
              title: i.metadata?.title ?? i.metadata?.name ?? null,
              artist: i.metadata?.artist ?? null,
              album: i.metadata?.album ?? null,
              duration_seconds: i.metadata?.duration ?? null
            }))
          })
        }
      },
      list_presets: {
        handler: () => {
          const s = this.connected()
          return ok(
            (s.presets?.presets ?? []).map((p) => ({
              id: p.id,
              name: p.name,
              kind: p.class,
              is_playing: p.is_playing === true
            }))
          )
        }
      },
      list_sources: {
        handler: () => {
          const s = this.connected()
          const active = s.zoneState?.source ?? s.nowPlaying?.source?.id ?? null
          return ok(
            (s.sources?.sources ?? [])
              .filter((x) => x.ui_selectable)
              .map((x) => ({ id: x.id, name: x.name, kind: x.class, active: x.id === active }))
          )
        }
      },
      list_devices: {
        handler: () => {
          const s = dm.snapshot()
          const current = s.connection.phase === 'connected' ? s.connection.host : null
          return ok(
            s.devices.map((d) => ({
              host: d.host,
              name: d.friendlyName,
              model: d.model,
              connected: d.host === current
            }))
          )
        }
      },
      list_recently_played: {
        inputSchema: { limit: z.number().int().min(1).max(200).optional().describe('Max entries (default 25).') },
        handler: (a) => {
          const limit = typeof a.limit === 'number' ? a.limit : 25
          return ok(
            dm.snapshot().recents.slice(0, limit).map((r) => ({
              at: new Date(r.at).toISOString(),
              title: r.title,
              artist: r.artist,
              album: r.album,
              station: r.station,
              source: r.source
            }))
          )
        }
      },

      // ---- transport
      play: {
        handler: async () => {
          this.connected()
          await dm.command({ type: 'play' })
          return ok('Playing.')
        }
      },
      pause: {
        handler: async () => {
          this.connected()
          await dm.command({ type: 'pause' })
          return ok('Paused.')
        }
      },
      stop: {
        handler: async () => {
          this.connected()
          await dm.command({ type: 'stop' })
          return ok('Stopped.')
        }
      },
      next_track: {
        handler: async () => {
          this.connected()
          await dm.command({ type: 'nextTrack' })
          return ok('Skipped to the next track.')
        }
      },
      previous_track: {
        handler: async () => {
          this.connected()
          await dm.command({ type: 'previousTrack' })
          return ok('Went back to the previous track.')
        }
      },
      seek: {
        inputSchema: { position_seconds: z.number().min(0).describe('Position in the current track, in seconds.') },
        handler: async (a) => {
          this.connected()
          await dm.command({ type: 'seek', positionSecs: a.position_seconds as number })
          return ok(`Seeked to ${a.position_seconds}s.`)
        }
      },
      play_queue_item: {
        inputSchema: { id: z.number().int().describe('Queue item id from list_queue.') },
        handler: async (a) => {
          this.connected()
          await dm.command({ type: 'playQueueId', queueId: a.id as number })
          return ok(`Playing queue item ${a.id}.`)
        }
      },
      set_shuffle: {
        inputSchema: { on: z.boolean() },
        handler: async (a) => {
          this.connected()
          await dm.command({ type: 'setShuffle', mode: a.on ? 'all' : 'off' })
          return ok(`Shuffle ${a.on ? 'on' : 'off'}.`)
        }
      },
      set_repeat: {
        inputSchema: { on: z.boolean() },
        handler: async (a) => {
          this.connected()
          await dm.command({ type: 'setRepeat', mode: a.on ? 'all' : 'off' })
          return ok(`Repeat ${a.on ? 'on' : 'off'}.`)
        }
      },

      // ---- volume
      set_volume: {
        inputSchema: { percent: z.number().min(0).max(100).describe('Absolute volume percent.') },
        handler: async (a) => {
          this.connected()
          await dm.command({ type: 'setVolumePercent', percent: a.percent as number })
          const limit = getSettings().volumeLimitPercent
          const capped = limit != null && (a.percent as number) > limit
          return ok(capped ? `Volume set to ${limit}% (the app's volume limit).` : `Volume set to ${a.percent}%.`)
        }
      },
      change_volume: {
        inputSchema: { steps: z.number().int().min(-20).max(20).describe('Steps up (positive) or down (negative).') },
        handler: async (a) => {
          this.connected()
          await dm.command({ type: 'volumeStepChange', delta: a.steps as number })
          return ok(`Volume nudged by ${a.steps} step(s).`)
        }
      },
      set_mute: {
        inputSchema: { muted: z.boolean() },
        handler: async (a) => {
          this.connected()
          await dm.command({ type: 'setMute', mute: a.muted as boolean })
          return ok(a.muted ? 'Muted.' : 'Unmuted.')
        }
      },

      // ---- presets / sources / power / devices
      recall_preset: {
        inputSchema: { id: z.number().int().min(1).describe('Preset id from list_presets.') },
        handler: async (a) => {
          const s = this.connected()
          const preset = (s.presets?.presets ?? []).find((p) => p.id === a.id)
          if (!preset) return err(`No preset ${a.id}. Use list_presets.`)
          await dm.command({ type: 'recallPreset', presetId: a.id as number })
          return ok(`Recalled preset ${a.id}${preset.name ? ` (${preset.name})` : ''}.`)
        }
      },
      set_source: {
        inputSchema: { id: z.string().describe('Source id from list_sources, e.g. MEDIA_PLAYER or IR.') },
        handler: async (a) => {
          const s = this.connected()
          const src = (s.sources?.sources ?? []).find((x) => x.id === a.id)
          if (!src) return err(`Unknown source '${a.id}'. Use list_sources.`)
          await dm.command({ type: 'setSource', sourceId: a.id as string })
          return ok(`Switched to ${src.name}.`)
        }
      },
      set_power: {
        inputSchema: { state: z.enum(['on', 'standby']) },
        handler: async (a) => {
          this.connected()
          await dm.command({ type: 'power', power: a.state === 'on' ? 'ON' : 'NETWORK' })
          return ok(a.state === 'on' ? 'Powering on.' : 'Going to network standby.')
        }
      },
      connect_device: {
        inputSchema: { host: z.string().describe('Host or IP from list_devices.') },
        handler: (a) => {
          dm.connect(a.host as string)
          return ok(`Connecting to ${a.host}. Call get_status to confirm.`)
        }
      },

      // ---- sleep timer
      set_sleep_timer: {
        inputSchema: {
          minutes: z.number().min(1).max(720).optional().describe('Minutes from now. Omit when using end_of_track.'),
          end_of_track: z.boolean().optional().describe('Fire when the current track ends.'),
          action: z.enum(['pause', 'standby']).optional().describe("Defaults to the user's configured action.")
        },
        handler: (a) => {
          const s = this.connected()
          const stored = getSettings().sleepAction
          const action = (a.action ?? (stored === 'pause' ? 'pause' : 'standby')) as 'pause' | 'standby'
          if (a.end_of_track) {
            const key = sleepTrackKey(s.playState)
            if (key == null) return err('Nothing identifiable is playing — use minutes instead.')
            dm.setSleep({ action, minutes: null, firesAt: null, trackKey: key })
            return ok(`Sleep timer armed: ${action} at the end of the current track.`)
          }
          if (typeof a.minutes !== 'number') return err('Provide minutes, or end_of_track: true.')
          dm.setSleep({
            action,
            minutes: a.minutes,
            firesAt: Date.now() + a.minutes * 60_000,
            trackKey: null
          })
          return ok(`Sleep timer armed: ${action} in ${a.minutes} minute(s).`)
        }
      },
      cancel_sleep_timer: {
        handler: () => {
          dm.setSleep(null)
          return ok('Sleep timer cleared.')
        }
      },

      // ---- library
      list_media_servers: {
        handler: async () => {
          const s = this.connected()
          const servers = await refreshServers(s.connection.host)
          return ok(
            servers.map((x) => ({
              udn: x.udn,
              name: x.name,
              model: x.model,
              is_streamer_usb: x.isStreamer,
              searchable: x.searchable
            }))
          )
        }
      },
      search_library: {
        inputSchema: {
          query: z.string().min(1).describe('Album, artist, or track name (partial matches ok).'),
          server_udn: z.string().optional().describe('Limit to one server (see list_media_servers).'),
          kind: z.enum(['album', 'artist', 'track']).optional().describe('Only return this kind.')
        },
        handler: async (a) => {
          const s = this.connected()
          let servers = (await refreshServers(s.connection.host)).filter((x) => x.searchable)
          if (typeof a.server_udn === 'string') {
            servers = servers.filter((x) => x.udn === a.server_udn)
            if (servers.length === 0) {
              return err(`No searchable media server with udn '${a.server_udn}'. Use list_media_servers.`)
            }
          }
          if (servers.length === 0) return err('No searchable media servers are visible right now.')
          const results: unknown[] = []
          for (const server of servers.slice(0, 3)) {
            const { items } = await librarySearch(s.connection.host, server.udn, a.query as string)
            for (const n of items) {
              const kind = kindOf(n)
              if (kind === 'folder') continue
              if (a.kind != null && kind !== a.kind) continue
              results.push({
                server_udn: server.udn,
                server: server.name,
                object_id: n.id,
                kind,
                title: n.title,
                artist: n.artist,
                album: n.album,
                year: n.year,
                duration_seconds: n.durationSecs
              })
              if (results.length >= 40) break
            }
            if (results.length >= 40) break
          }
          return ok({ total: results.length, capped: results.length >= 40, results })
        }
      },
      play_media: {
        inputSchema: {
          server_udn: z.string().describe('From search_library / list_media_servers.'),
          object_id: z.string().describe('From search_library.'),
          mode: z
            .enum(['play_now', 'play_next', 'append', 'replace'])
            .optional()
            .describe("Default play_now (keeps the queue). 'replace' clears the queue — only when asked to.")
        },
        handler: async (a) => {
          const s = this.connected()
          const mode = (a.mode as string | undefined) ?? 'play_now'
          try {
            await queueAdd(s.connection.host, a.server_udn as string, a.object_id as string, QUEUE_MODES[mode])
          } catch (e) {
            return err(
              `Couldn't queue that item — its object id may be stale; run search_library again. (${(e as Error).message})`
            )
          }
          return ok(
            mode === 'replace'
              ? 'Playing — the previous queue was replaced.'
              : mode === 'play_now'
                ? 'Playing now (the queue is kept).'
                : mode === 'play_next'
                  ? 'Queued to play next.'
                  : 'Added to the end of the queue.'
          )
        }
      },

      // ---- radio (keyless directory; never any listening telemetry)
      search_radio: {
        inputSchema: { query: z.string().min(1).describe('Station name, genre, or place.') },
        handler: async (a) => {
          const stations = await radioSearch(a.query as string)
          return ok(
            stations.slice(0, 15).map((st) => ({
              name: st.name,
              url: st.url,
              country: st.country,
              codec: st.codec,
              tags: st.tags
            }))
          )
        }
      },
      play_radio: {
        inputSchema: {
          url: z.string().url().describe('Stream URL (from search_radio or a station favorite).'),
          name: z.string().min(1).describe('Display name for the station.')
        },
        handler: async (a) => {
          this.connected()
          await dm.command({ type: 'streamRadio', url: a.url as string, name: a.name as string })
          return ok(`Tuning to ${a.name}.`)
        }
      },

      // ---- favorites
      list_favorites: {
        handler: () => {
          const s = dm.snapshot()
          return ok(
            s.favorites.map((f) =>
              f.kind === 'station'
                ? { key: favoriteKey(f), kind: f.kind, name: f.name, url: f.url }
                : { key: favoriteKey(f), kind: f.kind, title: f.title, artist: f.artist, album: f.album }
            )
          )
        }
      },
      play_favorite: {
        inputSchema: { key: z.string().describe('Favorite key from list_favorites.') },
        handler: async (a) => {
          const s = this.connected()
          const fav = s.favorites.find((f) => favoriteKey(f) === a.key)
          if (!fav) return err(`No favorite '${a.key}'. Use list_favorites.`)
          if (fav.kind === 'station') {
            await dm.command({ type: 'streamRadio', url: fav.url, name: fav.name })
            return ok(`Tuning to ${fav.name}.`)
          }
          const host = s.connection.host
          if (fav.serverUdn && fav.objectId) {
            try {
              await queueAdd(host, fav.serverUdn, fav.objectId, 'PLAY_NOW')
              return ok(`Playing ${fav.title}.`)
            } catch {
              // stored id went stale — heal by content below (the app's model:
              // object ids are hints, title/artist identity is the truth)
            }
          }
          for (const server of (await refreshServers(host)).filter((x) => x.searchable)) {
            const { items } = await librarySearch(host, server.udn, fav.title)
            const match = items.find(
              (n) =>
                kindOf(n) === fav.kind &&
                lc(n.title) === lc(fav.title) &&
                (fav.artist == null || n.artist == null || lc(n.artist) === lc(fav.artist))
            )
            if (match) {
              await queueAdd(host, server.udn, match.id, 'PLAY_NOW')
              dm.favoriteUpdate(a.key as string, {
                serverUdn: server.udn,
                serverName: server.name,
                objectId: match.id
              })
              return ok(`Playing ${fav.title} (found on ${server.name}).`)
            }
          }
          return err(`Couldn't find "${fav.title}" on any media server right now.`)
        }
      },
      add_favorite: {
        inputSchema: {
          station_url: z.string().url().optional().describe('Favorite a station: its stream URL…'),
          station_name: z.string().optional().describe('…and its display name (both or neither).')
        },
        handler: (a) => {
          const s = this.connected()
          let fav: Favorite
          if (a.station_url != null || a.station_name != null) {
            if (typeof a.station_url !== 'string' || typeof a.station_name !== 'string') {
              return err('Pass BOTH station_url and station_name (or neither, to favorite the current track).')
            }
            fav = {
              kind: 'station',
              addedAt: Date.now(),
              name: a.station_name,
              url: a.station_url,
              favicon: null,
              radioBrowserUuid: null
            }
          } else {
            const md = s.playState?.metadata
            if (md?.station) {
              return err(
                "For radio, pass station_url + station_name — the stream URL isn't knowable from playback metadata."
              )
            }
            if (!md?.title) return err('Nothing identifiable is playing.')
            fav = {
              kind: 'track',
              addedAt: Date.now(),
              title: md.title,
              artist: md.artist ?? null,
              album: md.album ?? null,
              artUrl: md.art_url ?? null,
              serverUdn: null,
              serverName: null,
              objectId: null,
              titlePath: null,
              durationSecs: md.duration ?? null
            }
          }
          const key = favoriteKey(fav)
          if (s.favorites.some((f) => favoriteKey(f) === key)) return ok('Already a favorite.')
          dm.favoriteAdd(fav)
          return ok(fav.kind === 'station' ? `Favorited station ${fav.name}.` : `Favorited "${fav.title}".`)
        }
      },

      // ---- tone & EQ (feature-detected; toneCaps errors cleanly without)
      get_audio_settings: {
        handler: () => {
          const { s, caps } = toneCaps()
          const za = s.zoneAudio
          return ok({
            user_eq_enabled: za?.user_eq?.enabled ?? false,
            band_gains_db: za?.user_eq?.bands?.map((b) => b.gain) ?? null,
            tilt: za?.tilt_eq ?? null,
            balance: za?.balance ?? null,
            ranges: {
              band_gain_db: { min: EQ_GAIN_MIN, max: EQ_GAIN_MAX },
              tilt: caps.tilt ? caps.tiltRange : null,
              balance: caps.balance ? caps.balanceRange : null
            },
            saved_presets: getSettings().eqPresets.map((p) => p.name)
          })
        }
      },
      set_eq_band: {
        inputSchema: {
          band: z.number().int().min(0).max(6).describe('Band index 0 (lowest) … 6 (highest frequency).'),
          gain_db: z.number().min(EQ_GAIN_MIN).max(EQ_GAIN_MAX)
        },
        handler: async (a) => {
          const { s } = toneCaps()
          if (s.zoneAudio?.user_eq?.enabled !== true) await dm.command({ type: 'setUserEq', enabled: true })
          await dm.command({ type: 'setEqBandGain', index: a.band as number, gain: a.gain_db as number })
          return ok(`Band ${a.band} set to ${a.gain_db} dB.`)
        }
      },
      set_tilt: {
        inputSchema: {
          intensity: z
            .number()
            .describe('Negative = warmer, positive = brighter (range from get_audio_settings).')
        },
        handler: async (a) => {
          const { s, caps } = toneCaps()
          if (!caps.tilt) return err('This streamer has no tone tilt.')
          if (s.zoneAudio?.tilt_eq?.enabled !== true) await dm.command({ type: 'setTiltEq', enabled: true })
          await dm.command({ type: 'setTiltIntensity', intensity: a.intensity as number })
          return ok(`Tilt set to ${a.intensity}.`)
        }
      },
      set_balance: {
        inputSchema: {
          balance: z.number().describe('Negative = left, positive = right (range from get_audio_settings).')
        },
        handler: async (a) => {
          const { caps } = toneCaps()
          if (!caps.balance) return err('This streamer has no balance control.')
          await dm.command({ type: 'setBalance', balance: a.balance as number })
          return ok(`Balance set to ${a.balance}.`)
        }
      },
      apply_eq_preset: {
        inputSchema: { name: z.string().describe('A saved preset name from get_audio_settings.') },
        handler: async (a) => {
          toneCaps()
          const preset = getSettings().eqPresets.find((p) => lc(p.name) === lc(a.name as string))
          if (!preset) return err(`No saved EQ preset named '${a.name}'. get_audio_settings lists them.`)
          await dm.command({ type: 'setUserEq', enabled: true })
          await dm.command({ type: 'setEqBands', gains: preset.gains })
          return ok(`Applied EQ preset "${preset.name}".`)
        }
      },
      reset_eq: {
        handler: async () => {
          toneCaps()
          await dm.command({ type: 'setEqBands', gains: [0, 0, 0, 0, 0, 0, 0] })
          return ok('EQ reset to flat.')
        }
      },

      // ---- display
      set_display_brightness: {
        inputSchema: { level: z.enum(['off', 'dim', 'bright']) },
        handler: async (a) => {
          const s = this.connected()
          const options = brightnessOptions(s.displaySpec)
          if (!options) return err('This streamer has no front-panel display.')
          if (!options.includes(a.level as string)) {
            return err(`This display only supports: ${options.join(', ')}.`)
          }
          await dm.command({ type: 'setBrightness', brightness: a.level as string })
          return ok(`Display set to ${a.level}.`)
        }
      },

      // ---- lookups (each behind its Connections toggle: off = no requests, ever)
      get_lyrics: {
        handler: async () => {
          if (!getSettings().lyrics) {
            return err('Lyrics lookups are switched off in Settings → Connections (off means no requests, ever).')
          }
          const s = this.connected()
          const md = s.playState?.metadata
          if (!md?.title || !md.artist) return err('Need a playing track with a title and artist.')
          const r = await fetchLyrics({
            artist: md.artist,
            title: md.title,
            album: md.album ?? null,
            duration: md.duration ?? null
          })
          if (!r) return ok('No lyrics found for this track.')
          if (r.instrumental) return ok('Instrumental — no lyrics.')
          return ok({ title: md.title, artist: md.artist, lyrics: r.plain ?? r.synced })
        }
      },
      get_artist_info: {
        inputSchema: { artist: z.string().optional().describe('Defaults to the playing artist.') },
        handler: async (a) => {
          if (!getSettings().artistInfo) {
            return err('Artist context is switched off in Settings → Connections (off means no requests, ever).')
          }
          const s = this.connected()
          const name = (a.artist as string | undefined) ?? s.playState?.metadata?.artist ?? null
          if (!name) return err('No artist playing — pass artist explicitly.')
          const info = await fetchArtistInfo(name)
          if (!info) return ok(`No artist match for "${name}".`)
          return ok({
            name: info.name,
            summary: info.summary,
            wikipedia: info.wikipediaUrl,
            musicbrainz: info.musicbrainzUrl
          })
        }
      },

      // ---- queue editing (opt-in cluster)
      remove_queue_item: {
        inputSchema: { id: z.number().int().describe('Queue item id from list_queue.') },
        handler: async (a) => {
          const s = this.connected()
          const item = (s.queue?.items ?? []).find((i) => i.id === a.id)
          if (!item) return err(`No queue item ${a.id}. Use list_queue.`)
          await dm.command({ type: 'queueDelete', id: a.id as number })
          return ok(`Removed "${item.metadata?.title ?? `item ${a.id}`}" from the queue.`)
        }
      },
      move_queue_item: {
        inputSchema: {
          id: z.number().int().describe('Queue item id from list_queue.'),
          to_position: z.number().int().min(0).describe('New 0-based position.')
        },
        handler: async (a) => {
          const s = this.connected()
          const item = (s.queue?.items ?? []).find((i) => i.id === a.id)
          if (!item || item.position == null) return err(`No queue item ${a.id}. Use list_queue.`)
          const total = s.queue?.total ?? 0
          if ((a.to_position as number) >= total) return err(`to_position must be below ${total}.`)
          await dm.command({
            type: 'queueMove',
            id: a.id as number,
            from: item.position,
            to: a.to_position as number
          })
          return ok(`Moved "${item.metadata?.title ?? `item ${a.id}`}" to position ${a.to_position}.`)
        }
      },

      // ---- preset saving (opt-in cluster; explicit-overwrite contract)
      save_queue_as_preset: {
        inputSchema: {
          slot: z.number().int().min(1).max(99).describe('Preset slot 1–99.'),
          name: z.string().min(1).describe('Name for the saved queue.'),
          overwrite: z.boolean().optional().describe('Must be true to replace an occupied slot.')
        },
        handler: async (a) => {
          const s = this.connected()
          if ((s.queue?.total ?? 0) === 0) return err('The queue is empty.')
          guardSlot(s, a.slot as number, a.overwrite === true)
          await dm.command({ type: 'queueSavePreset', slot: a.slot as number, name: a.name as string })
          return ok(`Saved the queue to preset ${a.slot} as "${a.name}".`)
        }
      },
      save_playing_to_preset: {
        inputSchema: {
          slot: z.number().int().min(1).max(99).describe('Preset slot 1–99.'),
          name: z.string().optional().describe('Optional rename (the firmware derives a name otherwise).'),
          overwrite: z.boolean().optional().describe('Must be true to replace an occupied slot.')
        },
        handler: async (a) => {
          const s = this.connected()
          if (s.playState?.state !== 'play' && s.playState?.state !== 'pause') {
            return err('Nothing is playing to save.')
          }
          guardSlot(s, a.slot as number, a.overwrite === true)
          await dm.command({ type: 'zoneSavePreset', slot: a.slot as number })
          if (typeof a.name === 'string' && a.name.length > 0) {
            await dm.command({ type: 'presetRename', slot: a.slot as number, name: a.name })
          }
          return ok(`Saved the current playback to preset ${a.slot}${a.name ? ` as "${a.name}"` : ''}.`)
        }
      }
    }
  }
}
