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
import { MCP_CLUSTERS, sleepTrackKey, type McpSettings, type Snapshot } from '@shared/ipc'
import { app } from 'electron'
import type { DeviceManager } from './deviceManager'
import { getSettings } from './persist'

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
    const { disabledClusters, disabledTools } = getSettings().mcp

    for (const cluster of MCP_CLUSTERS) {
      if (disabledClusters.includes(cluster.id)) continue
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
      }
    }
  }
}
