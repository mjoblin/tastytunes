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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z, type ZodRawShape } from "zod";
import { type Snapshot } from "@shared/ipc";
import {
  sleepTrackKey,
  type AppSettings,
  type ConnectionState,
  type McpSettings,
  type MediaNode,
  type MediaQueueAction,
  type Schedule,
  trackArtists,
  formatLabel,
  albumTracksOf,
  albumSummary,
  trackPosition,
  artistSummary,
  HIRES_BITS_ABOVE,
  HIRES_RATE_ABOVE,
  describeProfileNote,
  nameSortKey,
} from "@shared/model";
import {
  favoriteKey,
  isListen,
  type Favorite,
  type ListeningPlayEvent,
  audioAnalysisKey,
  albumDrKey,
  playKey,
  LOSSLESS_CODECS,
  isHiRes,
} from "@shared/model";
import { audioAnalysisGet, albumDrMap } from "../lookups/audioAnalysis";
import { playStatsFromRecord } from "../data/playStats";
import { listeningRecord } from "../data/listeningRecord";
import { MCP_CLUSTERS, mcpClusterEnabled } from "@shared/mcpCatalog";
import {
  EQ_GAIN_MAX,
  EQ_GAIN_MIN,
  audioCaps,
  brightnessOptions,
  isRadioMetadata,
} from "@shared/smoip";
import { app } from "electron";
import type { DeviceManager } from "../device/deviceManager";
import { getSettings, updateSettings } from "../data/persist";
import { randomUUID } from "node:crypto";
import { fetchArtistInfo } from "../lookups/artistInfo";
import { fetchAlbumInfo } from "../lookups/albumInfo";
import { fetchLyrics } from "../lookups/lyrics";
import { radioSearch, radioByTags } from "../lookups/radioBrowser";
import { presetSave, queueAdd, refreshServers } from "../media/upnpBrowser";
import {
  searchServer as librarySearch,
  status as indexStatus,
  pools as indexPools,
  ensureFresh as indexEnsureFresh,
  rebuild as indexRebuild,
} from "../media/mediaIndex";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface ToolImpl {
  inputSchema?: ZodRawShape;
  handler(args: Record<string, unknown>): Promise<ToolResult> | ToolResult;
}

const ok = (payload: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    },
  ],
});
const err = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** First non-internal IPv4 address, for the reachable URL when bound to LAN. */
function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

export class McpBridge {
  private http: Server | null = null;
  private active: { bind: McpSettings["bind"]; port: number } | null = null;
  /** Fired when an MCP tool mutates settings (schedules) — the renderer
   *  learns via a {kind:'settings'} push; index.ts wires this to the window. */
  onSettingsMutated: ((next: AppSettings) => void) | null = null;

  constructor(private dm: DeviceManager) {}

  /** Bring the server in line with settings: start, stop, or move host/port. */
  sync(settings: { mcp: McpSettings }): void {
    const mcp = settings.mcp;
    if (!mcp.enabled) {
      this.stop();
      return;
    }
    if (
      this.http &&
      this.active &&
      this.active.bind === mcp.bind &&
      this.active.port === mcp.port
    ) {
      return; // running in the right place; tool toggles apply per-request
    }
    this.stop(true);
    this.start(mcp);
  }

  stop(restarting = false): void {
    if (!this.http) return;
    // close() only stops NEW connections — drop live keep-alive sockets too,
    // or a same-port restart (bind flip) races the drain into EADDRINUSE.
    this.http.closeAllConnections();
    this.http.close();
    this.http = null;
    this.active = null;
    if (!restarting) {
      this.dm.setMcpStatus({ running: false, url: null, error: null }, "stopped");
    }
  }

  private start(mcp: McpSettings): void {
    const host = mcp.bind === "lan" ? "0.0.0.0" : "127.0.0.1";
    const server = createServer((req, res) => void this.route(req, res, mcp.bind));
    server.on("error", (e: NodeJS.ErrnoException) => {
      this.http = null;
      this.active = null;
      const reason =
        e.code === "EADDRINUSE"
          ? `port ${mcp.port} is already in use`
          : (e.message ?? "failed to start");
      this.dm.setMcpStatus(
        { running: false, url: null, error: reason },
        `error: ${reason}`,
        "error",
      );
    });
    server.listen(mcp.port, host, () => {
      const shown = mcp.bind === "lan" ? (lanAddress() ?? "0.0.0.0") : "127.0.0.1";
      const url = `http://${shown}:${mcp.port}/mcp`;
      this.dm.setMcpStatus(
        { running: true, url, error: null },
        `listening on ${url} (${mcp.bind})`,
      );
    });
    this.http = server;
    this.active = { bind: mcp.bind, port: mcp.port };
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    bind: McpSettings["bind"],
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    // DNS-rebinding guard for the localhost bind: a malicious web page can make
    // a browser POST to 127.0.0.1, but it can't forge the Host header.
    if (bind === "localhost") {
      const host = (req.headers.host ?? "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden host" }));
        return;
      }
    }
    if (req.method !== "POST") {
      // Stateless mode: no SSE stream to resume, no session to delete.
      res.writeHead(405, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed — POST JSON-RPC to this endpoint." },
          id: null,
        }),
      );
      return;
    }

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

      const mcpServer = this.buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      this.dm.setMcpStatus(null, `request failed: ${(e as Error).message}`, "warn");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  }

  /** A fresh server per request, registering only the currently-enabled tools. */
  private buildServer(): McpServer {
    const server = new McpServer({ name: "tastytunes", version: app.getVersion() });
    const impls = this.toolImpls();
    const mcp = getSettings().mcp;
    const { disabledTools } = mcp;

    for (const cluster of MCP_CLUSTERS) {
      // Opt-in (write-capable) clusters require an explicit enable in Settings.
      if (!mcpClusterEnabled(cluster, mcp)) continue;
      for (const tool of cluster.tools) {
        if (disabledTools.includes(tool.name)) continue;
        const impl = impls[tool.name];
        if (!impl) continue;
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: impl.inputSchema,
            annotations: { readOnlyHint: cluster.readOnly === true, openWorldHint: false },
          },
          (async (args: Record<string, unknown>) => {
            try {
              return await impl.handler(args ?? {});
            } catch (e) {
              return err((e as Error).message);
            }
          }) as never,
        );
      }
    }
    return server;
  }

  // --------------------------------------------------------------- tool handlers

  /** Snapshot when connected, or a throw that becomes a clean tool error. */
  private connected(): Snapshot & { connection: Extract<ConnectionState, { phase: "connected" }> } {
    const snap = this.dm.snapshot();
    if (snap.connection.phase !== "connected") {
      throw new Error(
        "Not connected to a streamer. Use list_devices and connect_device, or open TastyTunes to connect.",
      );
    }
    return snap as Snapshot & { connection: Extract<ConnectionState, { phase: "connected" }> };
  }

  /**
   * No ready index yet: kick the build the way listing servers would (the
   * Library screen or list_media_servers), and say so. An agent whose first
   * question is list_albums used to hit a dead end until something else
   * happened to list the servers (2026-08-16); now the answer is "building —
   * ask again in a moment", and it will be. Fire-and-forget; needs the
   * streamer (the server list comes from it) — offline it just reports.
   */
  private kickIndex(): string {
    const snap = this.dm.snapshot();
    if (snap.connection.phase !== "connected") {
      return "No library index is ready yet, and the streamer is not connected (the server list comes from it) — connect, or the user can build one in Settings → Libraries.";
    }
    const host = snap.connection.host;
    void refreshServers(host)
      .then((servers) => indexEnsureFresh(host, servers))
      .catch(() => {});
    return "No library index is ready yet — a build has been started (searchable servers index themselves in seconds; a Browse-only server needs rebuild_library_index). Ask again in a moment, or check list_media_servers.";
  }

  private toolImpls(): Record<string, ToolImpl> {
    const dm = this.dm;

    const lc = (x: string | null | undefined): string => (x ?? "").trim().toLowerCase();
    const kindOf = (n: MediaNode): "album" | "artist" | "track" | "folder" =>
      n.upnpClass.includes("musicAlbum")
        ? "album"
        : n.upnpClass.includes("Artist") || n.upnpClass.includes("person")
          ? "artist"
          : n.upnpClass.includes("audioItem")
            ? "track"
            : "folder";
    const QUEUE_MODES: Record<string, MediaQueueAction> = {
      play_now: "PLAY_NOW",
      play_next: "PLAY_NEXT",
      append: "APPEND",
      replace: "REPLACE",
    };

    /** Tone/EQ gate: caps when the streamer has them, a clean error otherwise. */
    const toneCaps = (): { s: Snapshot; caps: NonNullable<ReturnType<typeof audioCaps>> } => {
      const s = this.connected();
      const caps = audioCaps(s.audioSpec);
      if (!caps) throw new Error("This streamer has no tone/EQ controls.");
      return { s, caps };
    };

    /** The preset-save contract: an occupied slot needs overwrite: true. */
    const guardSlot = (s: Snapshot, slot: number, overwrite: boolean): void => {
      const existing = (s.presets?.presets ?? []).find((p) => p.id === slot);
      if (existing && !overwrite) {
        throw new Error(
          `Slot ${slot} already holds "${existing.name ?? "a preset"}". Pass overwrite: true to replace it.`,
        );
      }
    };

    const status = (): unknown => {
      const s = dm.snapshot();
      if (s.connection.phase !== "connected") {
        return {
          connection: s.connection.phase,
          hint: "Not connected. Use list_devices and connect_device.",
        };
      }
      const md = s.playState?.metadata;
      const activeSourceId = s.zoneState?.source ?? s.nowPlaying?.source?.id ?? null;
      const sourceName =
        s.sources?.sources?.find((x) => x.id === activeSourceId)?.name ??
        s.nowPlaying?.source?.name ??
        null;
      return {
        connection: "connected",
        device: {
          name: s.systemInfo?.name ?? null,
          model: s.systemInfo?.model ?? null,
          host: s.connection.host,
        },
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
                      kind: "track",
                      addedAt: 0,
                      title: md.title!,
                      artist: md.artist ?? null,
                      album: md.album ?? null,
                      artUrl: null,
                      serverUdn: null,
                      serverName: null,
                      objectId: null,
                      titlePath: null,
                    }),
                )
              : null,
          format: md
            ? {
                codec: md.codec,
                sample_rate: md.sample_rate,
                bit_depth: md.bit_depth,
                lossless: md.lossless,
                bitrate: md.bitrate,
              }
            : null,
        },
        volume: {
          percent: s.zoneState?.volume_percent ?? null,
          step: s.zoneState?.volume_step ?? null,
          muted: s.zoneState?.mute ?? null,
          limit_percent: getSettings().volumeLimitPercent,
        },
        // Tone/EQ — present only on streamers whose firmware has the controls.
        audio: (() => {
          const caps = audioCaps(s.audioSpec);
          if (!caps) return null;
          const za = s.zoneAudio;
          return {
            user_eq_enabled: za?.user_eq?.enabled ?? false,
            band_gains_db: za?.user_eq?.bands?.map((b) => b.gain) ?? null,
            tilt: za?.tilt_eq
              ? { enabled: za.tilt_eq.enabled, intensity: za.tilt_eq.intensity }
              : null,
            balance: za?.balance ?? null,
          };
        })(),
        display: s.systemDisplay ? { brightness: s.systemDisplay.brightness } : null,
        sleep_timer: s.sleep
          ? {
              action: s.sleep.action,
              fires_at: s.sleep.firesAt,
              end_of_track: s.sleep.minutes == null,
            }
          : null,
      };
    };

    return {
      // ---- status & lists
      get_status: { handler: () => ok(status()) },
      list_queue: {
        handler: () => {
          const s = this.connected();
          return ok({
            current_id: s.queue?.play_id ?? null,
            total: s.queue?.total ?? 0,
            items: (s.queue?.items ?? []).map((i) => ({
              id: i.id,
              position: i.position,
              title: i.metadata?.title ?? i.metadata?.name ?? null,
              artist: i.metadata?.artist ?? null,
              album: i.metadata?.album ?? null,
              duration_seconds: i.metadata?.duration ?? null,
            })),
          });
        },
      },
      list_presets: {
        handler: () => {
          const s = this.connected();
          return ok(
            (s.presets?.presets ?? []).map((p) => ({
              id: p.id,
              name: p.name,
              kind: p.class,
              is_playing: p.is_playing === true,
            })),
          );
        },
      },
      list_sources: {
        handler: () => {
          const s = this.connected();
          const active = s.zoneState?.source ?? s.nowPlaying?.source?.id ?? null;
          return ok(
            (s.sources?.sources ?? [])
              .filter((x) => x.ui_selectable)
              .map((x) => ({ id: x.id, name: x.name, kind: x.class, active: x.id === active })),
          );
        },
      },
      list_devices: {
        handler: () => {
          const s = dm.snapshot();
          const current = s.connection.phase === "connected" ? s.connection.host : null;
          return ok(
            s.devices.map((d) => ({
              host: d.host,
              name: d.friendlyName,
              model: d.model,
              connected: d.host === current,
            })),
          );
        },
      },
      list_recently_played: {
        inputSchema: {
          limit: z.number().int().min(1).max(200).optional().describe("Max entries (default 25)."),
        },
        handler: (a) => {
          const limit = typeof a.limit === "number" ? a.limit : 25;
          return ok(
            dm
              .snapshot()
              .recents.slice(0, limit)
              .map((r) => ({
                at: new Date(r.at).toISOString(),
                title: r.title,
                artist: r.artist,
                album: r.album,
                station: r.station,
                source: r.source,
              })),
          );
        },
      },
      list_schedules: {
        handler: () =>
          ok({
            note: "Schedules fire only while TastyTunes is running and connected.",
            schedules: getSettings().schedules.map(scheduleOut),
          }),
      },

      // ---- transport
      play: {
        handler: async () => {
          this.connected();
          await dm.command({ type: "play" });
          return ok("Playing.");
        },
      },
      pause: {
        handler: async () => {
          this.connected();
          await dm.command({ type: "pause" });
          return ok("Paused.");
        },
      },
      stop: {
        handler: async () => {
          this.connected();
          await dm.command({ type: "stop" });
          return ok("Stopped.");
        },
      },
      next_track: {
        handler: async () => {
          this.connected();
          await dm.command({ type: "nextTrack" });
          return ok("Skipped to the next track.");
        },
      },
      previous_track: {
        handler: async () => {
          this.connected();
          await dm.command({ type: "previousTrack" });
          return ok("Went back to the previous track.");
        },
      },
      seek: {
        inputSchema: {
          position_seconds: z
            .number()
            .min(0)
            .describe("Position in the current track, in seconds."),
        },
        handler: async (a) => {
          this.connected();
          await dm.command({ type: "seek", positionSecs: a.position_seconds as number });
          return ok(`Seeked to ${String(a.position_seconds)}s.`);
        },
      },
      play_queue_item: {
        inputSchema: { id: z.number().int().describe("Queue item id from list_queue.") },
        handler: async (a) => {
          this.connected();
          await dm.command({ type: "playQueueId", queueId: a.id as number });
          return ok(`Playing queue item ${String(a.id)}.`);
        },
      },
      set_shuffle: {
        inputSchema: { on: z.boolean() },
        handler: async (a) => {
          this.connected();
          await dm.command({ type: "setShuffle", mode: a.on ? "all" : "off" });
          return ok(`Shuffle ${a.on ? "on" : "off"}.`);
        },
      },
      set_repeat: {
        inputSchema: { on: z.boolean() },
        handler: async (a) => {
          this.connected();
          await dm.command({ type: "setRepeat", mode: a.on ? "all" : "off" });
          return ok(`Repeat ${a.on ? "on" : "off"}.`);
        },
      },

      // ---- volume
      set_volume: {
        inputSchema: { percent: z.number().min(0).max(100).describe("Absolute volume percent.") },
        handler: async (a) => {
          this.connected();
          await dm.command({ type: "setVolumePercent", percent: a.percent as number });
          const limit = getSettings().volumeLimitPercent;
          const capped = limit != null && (a.percent as number) > limit;
          return ok(
            capped
              ? `Volume set to ${limit}% (the app's volume limit).`
              : `Volume set to ${String(a.percent)}%.`,
          );
        },
      },
      change_volume: {
        inputSchema: {
          steps: z
            .number()
            .int()
            .min(-20)
            .max(20)
            .describe("Steps up (positive) or down (negative)."),
        },
        handler: async (a) => {
          this.connected();
          await dm.command({ type: "volumeStepChange", delta: a.steps as number });
          return ok(`Volume nudged by ${String(a.steps)} step(s).`);
        },
      },
      set_mute: {
        inputSchema: { muted: z.boolean() },
        handler: async (a) => {
          this.connected();
          await dm.command({ type: "setMute", mute: a.muted as boolean });
          return ok(a.muted ? "Muted." : "Unmuted.");
        },
      },

      // ---- presets / sources / power / devices
      recall_preset: {
        inputSchema: { id: z.number().int().min(1).describe("Preset id from list_presets.") },
        handler: async (a) => {
          const s = this.connected();
          const preset = (s.presets?.presets ?? []).find((p) => p.id === a.id);
          if (!preset) return err(`No preset ${String(a.id)}. Use list_presets.`);
          await dm.command({ type: "recallPreset", presetId: a.id as number });
          return ok(`Recalled preset ${String(a.id)}${preset.name ? ` (${preset.name})` : ""}.`);
        },
      },
      set_source: {
        inputSchema: {
          id: z.string().describe("Source id from list_sources, e.g. MEDIA_PLAYER or IR."),
        },
        handler: async (a) => {
          const s = this.connected();
          const src = (s.sources?.sources ?? []).find((x) => x.id === a.id);
          if (!src) return err(`Unknown source '${String(a.id)}'. Use list_sources.`);
          await dm.command({ type: "setSource", sourceId: a.id as string });
          return ok(`Switched to ${src.name}.`);
        },
      },
      set_power: {
        inputSchema: { state: z.enum(["on", "standby"]) },
        handler: async (a) => {
          this.connected();
          await dm.command({ type: "power", power: a.state === "on" ? "ON" : "NETWORK" });
          return ok(a.state === "on" ? "Powering on." : "Going to network standby.");
        },
      },
      connect_device: {
        inputSchema: { host: z.string().describe("Host or IP from list_devices.") },
        handler: (a) => {
          dm.connect(a.host as string);
          return ok(`Connecting to ${String(a.host)}. Call get_status to confirm.`);
        },
      },

      // ---- sleep timer
      set_sleep_timer: {
        inputSchema: {
          minutes: z
            .number()
            .min(1)
            .max(720)
            .optional()
            .describe("Minutes from now. Omit when using end_of_track."),
          end_of_track: z.boolean().optional().describe("Fire when the current track ends."),
          action: z
            .enum(["pause", "standby"])
            .optional()
            .describe("Defaults to the user's configured action."),
        },
        handler: (a) => {
          const s = this.connected();
          const stored = getSettings().sleepAction;
          const action = (a.action ?? (stored === "pause" ? "pause" : "standby")) as
            "pause" | "standby";
          if (a.end_of_track) {
            const key = sleepTrackKey(s.playState);
            if (key == null) return err("Nothing identifiable is playing — use minutes instead.");
            dm.setSleep({ action, minutes: null, firesAt: null, trackKey: key });
            return ok(`Sleep timer armed: ${action} at the end of the current track.`);
          }
          if (typeof a.minutes !== "number") return err("Provide minutes, or end_of_track: true.");
          dm.setSleep({
            action,
            minutes: a.minutes,
            firesAt: Date.now() + a.minutes * 60_000,
            trackKey: null,
          });
          return ok(`Sleep timer armed: ${action} in ${a.minutes} minute(s).`);
        },
      },
      cancel_sleep_timer: {
        handler: () => {
          dm.setSleep(null);
          return ok("Sleep timer cleared.");
        },
      },

      // ---- library
      rebuild_library_index: {
        inputSchema: {
          server_udn: z
            .string()
            .describe("Which server to index (see list_media_servers for udn + index state)."),
        },
        handler: async (a) => {
          const s = this.connected();
          const servers = await refreshServers(s.connection.host);
          const server = servers.find((x) => x.udn === (a.server_udn as string));
          if (!server) return err(`No media server with udn ${a.server_udn as string}.`);
          // Browse-only servers (a streamer's USB drive) never index
          // themselves — this is the ONLY way to make them searchable, which
          // is why an agent needs it: list_media_servers can already SEE that
          // an index is missing, and could do nothing about it.
          await indexRebuild(s.connection.host, server);
          // build() is a NO-OP while a build is already in flight — listing
          // servers nudges Tier A builds, so awaiting rebuild can return
          // mid-crawl. Wait for it to settle, and if it is still going, SAY so
          // instead of reporting zeros as though they were the answer.
          const statusOf = ():
            { state: string; albums: number; artists: number; tracks: number } | undefined => {
            const x = indexStatus().find((y) => y.udn === (a.server_udn as string));
            return x
              ? {
                  state: x.state,
                  albums: x.albums ?? 0,
                  artists: x.artists ?? 0,
                  tracks: x.tracks ?? 0,
                }
              : undefined;
          };
          const deadline = Date.now() + 45_000;
          let st = statusOf();
          while (st?.state === "building" && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 400));
            st = statusOf();
          }
          if (st?.state === "building")
            return ok({
              server: server.name,
              state: "building",
              note: "Still indexing — call list_media_servers in a little while for the counts.",
            });
          return ok({
            server: server.name,
            state: st?.state ?? "unknown",
            albums: st?.albums ?? 0,
            artists: st?.artists ?? 0,
            tracks: st?.tracks ?? 0,
          });
        },
      },
      list_media_servers: {
        handler: async () => {
          const s = this.connected();
          const servers = await refreshServers(s.connection.host);
          // same freshness semantics as the app's Library screen: listing
          // servers nudges Tier A index builds in the background (gated on
          // the user's auto-index setting inside ensureFresh)
          indexEnsureFresh(s.connection.host, servers);
          const stats = new Map(indexStatus().map((x) => [x.udn, x]));
          return ok(
            servers.map((x) => {
              const st = stats.get(x.udn);
              const ready = st?.state === "ready";
              return {
                udn: x.udn,
                name: x.name,
                model: x.model,
                is_streamer_usb: x.isStreamer,
                searchable: x.searchable,
                index_ready: ready,
                ...(st?.state === "failed" ? { index_failed: st.failure ?? "no index" } : {}),
                // library counts, so "how many albums do I have" is one call
                ...(ready && st
                  ? {
                      index: {
                        albums: st.albums,
                        artists: st.artists,
                        tracks: st.tracks,
                        built_at: st.builtAt != null ? new Date(st.builtAt).toISOString() : null,
                        // how the index was built and every reconciliation that changed something —
                        // the SHAPE of the server's answers, so an agent can explain what it sees
                        ...(st.profile
                          ? {
                              built_by: st.profile.strategy,
                              albums_from: st.profile.albumsFrom,
                              class_search: st.profile.classSearch,
                              notes: st.profile.notes.map(describeProfileNote),
                            }
                          : {}),
                      },
                    }
                  : {}),
              };
            }),
          );
        },
      },
      search_library: {
        inputSchema: {
          query: z.string().min(1).describe("Album, artist, or track name (partial matches ok)."),
          server_udn: z
            .string()
            .optional()
            .describe(
              "Limit to one server (see list_media_servers); omit to search every eligible server.",
            ),
          kind: z.enum(["album", "artist", "track"]).optional().describe("Only return this kind."),
          match: z
            .enum(["any", "title"])
            .optional()
            .describe(
              "'title' = only items whose OWN title contains the query (e.g. songs with 'love' in the track title). Default 'any' — title, artist, or album.",
            ),
          limit: z.number().int().min(1).max(200).optional().describe("Default 40."),
          offset: z.number().int().min(0).optional().describe("For paging; default 0."),
        },
        handler: async (a) => {
          const s = this.connected();
          const ready = new Set(
            indexStatus()
              .filter((x) => x.state === "ready")
              .map((x) => x.udn),
          );
          // Eligible = answers live Search OR has a ready local index (the
          // app's own rule) — a Browse-only USB stick with a built index
          // is searchable here too.
          let servers = (await refreshServers(s.connection.host)).filter(
            (x) => x.searchable || ready.has(x.udn),
          );
          if (typeof a.server_udn === "string") {
            servers = servers.filter((x) => x.udn === a.server_udn);
            if (servers.length === 0) {
              return err(
                `No searchable or indexed media server with udn '${a.server_udn}'. Use list_media_servers.`,
              );
            }
          }
          if (servers.length === 0)
            return err("No searchable media servers are visible right now.");
          // Ready indexes answer from memory (every match retrieved, true
          // totals) — the only real cost is tokens, which limit/offset
          // govern. The LAN-protection cap that matters is on live SOAP:
          // at most 3 un-indexed servers per query, each already bounded
          // by the ContentDirectory search's own 500-result ceiling.
          const fleet = [
            ...servers.filter((x) => ready.has(x.udn)),
            ...servers.filter((x) => !ready.has(x.udn)).slice(0, 3),
          ];
          const tokens = (a.query as string).toLowerCase().split(/\s+/).filter(Boolean);
          const collected: unknown[] = [];
          let sourceCapped = false;
          for (const server of fleet) {
            const { items, total } = await librarySearch(
              s.connection.host,
              server.udn,
              a.query as string,
            );
            if (total > items.length) sourceCapped = true;
            for (const n of items) {
              const kind = kindOf(n);
              if (kind === "folder") continue;
              if (a.kind != null && kind !== a.kind) continue;
              if (a.match === "title") {
                const title = n.title.toLowerCase();
                if (!tokens.every((t) => title.includes(t))) continue;
              }
              collected.push({
                server_udn: server.udn,
                server: server.name,
                object_id: n.id,
                kind,
                title: n.title,
                artist: n.artist,
                album: n.album,
                year: n.year,
                duration_seconds: n.durationSecs,
                // what the DIDL knows beyond the packed artist string (2026-08-16)
                ...(n.albumArtist ? { album_artist: n.albumArtist } : {}),
                ...(n.artists ? { performers: n.artists } : {}),
                ...(n.composers ? { composers: n.composers } : {}),
                ...(n.format ? { format: formatLabel(n.format) } : {}),
              });
            }
          }
          const offset = (a.offset as number | undefined) ?? 0;
          const limit = (a.limit as number | undefined) ?? 40;
          const page = collected.slice(offset, offset + limit);
          return ok({
            total: collected.length,
            offset,
            returned: page.length,
            ...(sourceCapped
              ? {
                  note: "A source hit its internal retrieval cap — total covers only what it returned.",
                }
              : {}),
            results: page,
          });
        },
      },
      list_history: {
        inputSchema: {
          from: z.string().optional().describe("Earliest local date, YYYY-MM-DD."),
          to: z.string().optional().describe("Latest local date, YYYY-MM-DD, inclusive."),
          kind: z
            .enum(["play", "radio-session", "radio-track", "external"])
            .optional()
            .describe("One kind only; default all."),
          limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
          offset: z.number().int().min(0).optional().describe("For paging; default 0."),
        },
        // Local files only — works with the streamer off, so no connected() gate.
        handler: async (a) => {
          const { events, unreadable } = await listeningRecord.readAll();
          const fromMs = a.from != null ? Date.parse(`${a.from as string}T00:00:00`) : null;
          const toMs = a.to != null ? Date.parse(`${a.to as string}T23:59:59.999`) : null;
          const filtered = events
            .filter(
              (e) =>
                (fromMs == null || e.at >= fromMs) &&
                (toMs == null || e.at <= toMs) &&
                (a.kind == null || e.kind === a.kind),
            )
            .sort((x, y) => y.at - x.at);
          const offset = (a.offset as number | undefined) ?? 0;
          const limit = (a.limit as number | undefined) ?? 50;
          const page = filtered.slice(offset, offset + limit).map((e) => ({
            ...e,
            at: new Date(e.at).toISOString(),
            ...(e.kind === "play" ? { listen: isListen(e.playedSeconds, e.duration) } : {}),
          }));
          return ok({
            total: filtered.length,
            offset,
            returned: page.length,
            ...(unreadable > 0 ? { unreadable_lines: unreadable } : {}),
            events: page,
          });
        },
      },
      history_top: {
        inputSchema: {
          by: z.enum(["artists", "albums", "tracks"]).describe("What to rank."),
          from: z.string().optional().describe("Earliest local date, YYYY-MM-DD."),
          to: z.string().optional().describe("Latest local date, YYYY-MM-DD, inclusive."),
          limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
        },
        handler: async (a) => {
          const { events } = await listeningRecord.readAll();
          const fromMs = a.from != null ? Date.parse(`${a.from as string}T00:00:00`) : null;
          const toMs = a.to != null ? Date.parse(`${a.to as string}T23:59:59.999`) : null;
          const counts = new Map<string, { label: string; plays: number; listens: number }>();
          for (const e of events) {
            // Library plays only: a count means "played from the library".
            if (e.kind !== "play") continue;
            if ((fromMs != null && e.at < fromMs) || (toMs != null && e.at > toMs)) continue;
            const label =
              a.by === "artists"
                ? (e.artist ?? "Unknown artist")
                : a.by === "albums"
                  ? `${e.album ?? "Unknown album"}${e.artist ? ` · ${e.artist}` : ""}`
                  : `${e.title}${e.artist ? ` · ${e.artist}` : ""}`;
            const key = label.toLowerCase();
            const row = counts.get(key) ?? { label, plays: 0, listens: 0 };
            row.plays += 1;
            if (isListen(e.playedSeconds, e.duration)) row.listens += 1;
            counts.set(key, row);
          }
          const limit = (a.limit as number | undefined) ?? 20;
          const results = [...counts.values()]
            .sort((x, y) => y.listens - x.listens || y.plays - x.plays)
            .slice(0, limit);
          return ok({
            by: a.by,
            listen_definition: "half the track or four minutes of real play time",
            results,
          });
        },
      },
      history_on_this_day: {
        inputSchema: {
          month: z.number().int().min(1).max(12).optional().describe("Default: today's month."),
          day: z.number().int().min(1).max(31).optional().describe("Default: today's day."),
        },
        handler: async (a) => {
          const now = new Date();
          const month = (a.month as number | undefined) ?? now.getMonth() + 1;
          const day = (a.day as number | undefined) ?? now.getDate();
          const { events } = await listeningRecord.readAll();
          const hits = events
            .filter((e) => {
              // The local day AS IT WAS RECORDED: shift by the stored tz
              // offset, then read the shifted date's UTC fields.
              const local = new Date(e.at - e.tzOffsetMin * 60000);
              return local.getUTCMonth() + 1 === month && local.getUTCDate() === day;
            })
            .sort((x, y) => y.at - x.at)
            .map((e) => ({
              ...e,
              at: new Date(e.at).toISOString(),
              ...(e.kind === "play" ? { listen: isListen(e.playedSeconds, e.duration) } : {}),
            }));
          return ok({ month, day, total: hits.length, events: hits });
        },
      },
      history_first_listen: {
        inputSchema: {
          title: z.string().describe("Track title, case-insensitive exact match."),
          artist: z
            .string()
            .optional()
            .describe("Narrow by artist, case-insensitive substring of the recorded artist."),
        },
        handler: async (a) => {
          const lc = (v: string): string => v.trim().toLowerCase();
          const { events } = await listeningRecord.readAll();
          const plays = events
            .filter(
              (e): e is ListeningPlayEvent =>
                e.kind === "play" &&
                lc(e.title) === lc(a.title as string) &&
                (a.artist == null ||
                  (e.artist ?? "").toLowerCase().includes(lc(a.artist as string))),
            )
            .sort((x, y) => x.at - y.at);
          if (plays.length === 0) return ok({ found: false });
          const listens = plays.filter((e) => isListen(e.playedSeconds, e.duration));
          return ok({
            found: true,
            first_played: new Date(plays[0].at).toISOString(),
            first_listen: listens.length > 0 ? new Date(listens[0].at).toISOString() : null,
            plays: plays.length,
            listens: listens.length,
          });
        },
      },
      // ---- the record's reading surfaces as tools (0.8.0)
      history_stats: {
        inputSchema: {
          title: z
            .string()
            .optional()
            .describe(
              "A track title (add artist/album to disambiguate). Omit title AND album for the playing track.",
            ),
          artist: z.string().optional(),
          album: z.string().optional().describe("With no title: the whole album's tally."),
        },
        handler: async (a) => {
          const stats = await playStatsFromRecord();
          const md = dm.snapshot().playState?.metadata;
          const title =
            (a.title as string | undefined) ?? (a.album ? undefined : (md?.title ?? undefined));
          const artist =
            (a.artist as string | undefined) ??
            (a.title || a.album ? undefined : (md?.artist ?? undefined));
          const album =
            (a.album as string | undefined) ?? (a.title ? undefined : (md?.album ?? undefined));
          const since = stats.since != null ? new Date(stats.since).toISOString() : null;
          const lc = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();
          if (title) {
            const exact = stats.tracks[playKey(title, artist ?? null, album ?? null)];
            const loose = exact
              ? [exact]
              : Object.entries(stats.tracks)
                  .filter(
                    ([k]) =>
                      k.startsWith(`${lc(title)}|`) && (!artist || k.includes(`|${lc(artist)}|`)),
                  )
                  .map(([, v]) => v);
            if (loose.length === 0)
              return ok({
                track: { title, artist: artist ?? null, album: album ?? null },
                plays: 0,
                listens: 0,
                last_played: null,
                seconds_heard: 0,
                record_since: since,
              });
            const plays = loose.reduce((n, v) => n + v.plays, 0);
            const listens = loose.reduce((n, v) => n + v.listens, 0);
            const lastAt = Math.max(...loose.map((v) => v.lastAt));
            const seconds = loose.reduce((n, v) => n + v.seconds, 0);
            return ok({
              track: { title, artist: artist ?? null, album: album ?? null },
              plays,
              listens,
              last_played: new Date(lastAt).toISOString(),
              seconds_heard: seconds,
              record_since: since,
            });
          }
          if (album) {
            let plays = 0,
              listens = 0,
              seconds = 0,
              lastAt = 0;
            const titles = new Set<string>();
            for (const [k, v] of Object.entries(stats.tracks)) {
              const [t, ar, al] = k.split("|");
              if (al !== lc(album)) continue;
              if (artist && ar !== lc(artist)) continue;
              plays += v.plays;
              listens += v.listens;
              seconds += v.seconds;
              lastAt = Math.max(lastAt, v.lastAt);
              titles.add(t);
            }
            return ok({
              album: { title: album, artist: artist ?? null },
              plays,
              listens,
              distinct_tracks_played: titles.size,
              last_played: lastAt > 0 ? new Date(lastAt).toISOString() : null,
              seconds_heard: seconds,
              record_since: since,
            });
          }
          return err("Nothing is playing and no track or album was named.");
        },
      },
      history_unplayed: {
        inputSchema: {
          artist: z.string().optional().describe("Case-insensitive substring on the album artist."),
          genre: z.string().optional(),
          decade: z.string().optional().describe("e.g. '1990s'."),
          limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
          offset: z.number().int().min(0).optional(),
        },
        handler: async (a) => {
          const groups = indexPools();
          if (groups.length === 0) return err(this.kickIndex());
          const stats = await playStatsFromRecord();
          const poolOf = new Map(groups.map((p) => [p.udn, p]));
          const artistNeedle = (a.artist as string | undefined)?.toLowerCase();
          const genreNeedle = (a.genre as string | undefined)?.toLowerCase();
          const decade = a.decade != null ? String(a.decade).replace(/s$/i, "") : null;
          const albums = groups
            .flatMap((p) => p.albums)
            .filter(
              (n) => artistNeedle == null || (n.artist ?? "").toLowerCase().includes(artistNeedle),
            )
            .filter(
              (n) =>
                genreNeedle == null || (n.genre ?? []).some((g) => g.toLowerCase() === genreNeedle),
            )
            .filter(
              (n) =>
                decade == null ||
                (n.year != null && String(Math.floor(Number(n.year) / 10) * 10) === decade),
            )
            .filter((n) => {
              const pool = n.serverUdn ? poolOf.get(n.serverUdn) : undefined;
              const tracks = pool ? albumTracksOf(n, pool) : [];
              return !tracks.some((t) => stats.tracks[playKey(t.title, t.artist, t.album)] != null);
            })
            .sort(
              (x, y) =>
                nameSortKey(x.artist ?? "￿").localeCompare(nameSortKey(y.artist ?? "￿")) ||
                x.title.localeCompare(y.title),
            );
          const offset = (a.offset as number | undefined) ?? 0;
          const limit = (a.limit as number | undefined) ?? 50;
          const page = albums.slice(offset, offset + limit);
          return ok({
            record_since: stats.since != null ? new Date(stats.since).toISOString() : null,
            note: "Unplayed means no recorded play since the listening record began, not never.",
            total: albums.length,
            offset,
            returned: page.length,
            albums: page.map((n) => ({
              server_udn: n.serverUdn,
              object_id: n.id,
              title: n.title,
              artist: n.artist,
              year: n.year,
              genres: n.genre ?? [],
            })),
          });
        },
      },
      history_rediscover: {
        inputSchema: {
          not_since: z
            .string()
            .optional()
            .describe(
              "Local date YYYY-MM-DD; albums last played BEFORE this. Default: 90 days ago.",
            ),
          min_plays: z.number().int().min(1).optional().describe("Default 1."),
          limit: z.number().int().min(1).max(200).optional().describe("Default 30."),
        },
        handler: async (a) => {
          const groups = indexPools();
          if (groups.length === 0) return err(this.kickIndex());
          const stats = await playStatsFromRecord();
          const cutoff =
            a.not_since != null
              ? Date.parse(`${a.not_since as string}T00:00:00`)
              : Date.now() - 90 * 86_400_000;
          if (Number.isNaN(cutoff)) return err("not_since must be YYYY-MM-DD.");
          const minPlays = (a.min_plays as number | undefined) ?? 1;
          const poolOf = new Map(groups.map((p) => [p.udn, p]));
          const rows = groups
            .flatMap((p) => p.albums)
            .flatMap((n) => {
              const pool = n.serverUdn ? poolOf.get(n.serverUdn) : undefined;
              const tracks = pool ? albumTracksOf(n, pool) : [];
              let plays = 0,
                lastAt = 0;
              for (const t of tracks) {
                const st = stats.tracks[playKey(t.title, t.artist, t.album)];
                if (!st) continue;
                plays += st.plays;
                lastAt = Math.max(lastAt, st.lastAt);
              }
              return plays >= minPlays && lastAt > 0 && lastAt < cutoff
                ? [{ n, plays, lastAt }]
                : [];
            });
          rows.sort((x, y) => x.lastAt - y.lastAt);
          const limit = (a.limit as number | undefined) ?? 30;
          return ok({
            not_since: new Date(cutoff).toISOString(),
            total: rows.length,
            returned: Math.min(limit, rows.length),
            albums: rows.slice(0, limit).map(({ n, plays, lastAt }) => ({
              server_udn: n.serverUdn,
              object_id: n.id,
              title: n.title,
              artist: n.artist,
              year: n.year,
              plays,
              last_played: new Date(lastAt).toISOString(),
            })),
          });
        },
      },
      list_albums: {
        inputSchema: {
          artist: z
            .string()
            .optional()
            .describe("Case-insensitive substring match on the album artist."),
          genre: z
            .string()
            .optional()
            .describe("Case-insensitive genre, e.g. 'Rock' (results list each album's genres)."),
          decade: z.string().optional().describe("e.g. '1990s' (or just '1990')."),
          kind: z
            .enum(["all", "albums", "compilations"])
            .optional()
            .describe(
              "Default 'all'. 'compilations' = various-artists albums (album artist 'Various Artists' or credited to no performer on it); 'albums' excludes them.",
            ),
          hires: z
            .boolean()
            .optional()
            .describe(
              `true = only albums with any track above ${HIRES_BITS_ABOVE}-bit or ${HIRES_RATE_ABOVE / 1000} kHz.`,
            ),
          format: z
            .string()
            .optional()
            .describe(
              "Case-insensitive substring of the album's format headline or any track's, e.g. 'FLAC', '24/96', 'MP3'.",
            ),
          composer: z
            .string()
            .optional()
            .describe("Case-insensitive substring match on any track's composers."),
          server_udn: z
            .string()
            .optional()
            .describe("Limit to one server (see list_media_servers)."),
          lossless: z
            .boolean()
            .optional()
            .describe("true = only albums whose every track is lossless (FLAC, ALAC, WAV, …)."),
          min_dr: z
            .number()
            .int()
            .min(1)
            .max(30)
            .optional()
            .describe(
              "Only albums whose recorded dynamic range (DR, whole album analyzed) is at least this; albums without one are excluded.",
            ),
          sort: z
            .enum(["title", "artist", "year", "dr"])
            .optional()
            .describe(
              "Default 'title'; 'year' sorts newest first; 'dr' most dynamic first, unanalyzed last.",
            ),
          limit: z.number().int().min(1).max(100).optional().describe("Default 40."),
          offset: z.number().int().min(0).optional().describe("For paging; default 0."),
        },
        // Purely index-backed (the lenses' feedstock) — works even while the
        // streamer itself is off, so no connected() gate.
        handler: (a) => {
          const groups = indexPools().filter((p) => a.server_udn == null || p.udn === a.server_udn);
          if (groups.length === 0) {
            return err(
              a.server_udn != null
                ? `No ready index for server '${String(a.server_udn)}'. Use list_media_servers.`
                : this.kickIndex(),
            );
          }
          const artistNeedle = (a.artist as string | undefined)?.toLowerCase();
          const genreNeedle = (a.genre as string | undefined)?.toLowerCase();
          const decade = a.decade != null ? String(a.decade).replace(/s$/i, "") : null;
          let albums = groups.flatMap((p) => p.albums);
          if (artistNeedle != null)
            albums = albums.filter((n) => n.artist?.toLowerCase().includes(artistNeedle));
          if (genreNeedle != null)
            albums = albums.filter((n) =>
              (n.genre ?? []).some((g) => g.toLowerCase() === genreNeedle),
            );
          if (decade != null)
            albums = albums.filter(
              (n) => n.year != null && String(Math.floor(Number(n.year) / 10) * 10) === decade,
            );
          // Each album's tracks, summed once (the same derivations the album
          // leaf, the lens and the Info modal use — albumTracksOf/albumSummary):
          // the filters below and the per-album fields both read this map.
          const poolOf = new Map(groups.map((p) => [p.udn, p]));
          const summaries = new Map<
            string,
            { tracks: MediaNode[]; sum: ReturnType<typeof albumSummary> }
          >();
          const summaryFor = (
            n: MediaNode,
          ): { tracks: MediaNode[]; sum: ReturnType<typeof albumSummary> } => {
            const key = `${n.serverUdn}|${n.id}`;
            let hit = summaries.get(key);
            if (!hit) {
              const pool = n.serverUdn ? poolOf.get(n.serverUdn) : undefined;
              const tracks = pool ? albumTracksOf(n, pool) : [];
              hit = { tracks, sum: albumSummary(n, tracks) };
              summaries.set(key, hit);
            }
            return hit;
          };
          const kind = (a.kind as string | undefined) ?? "all";
          if (kind === "compilations")
            albums = albums.filter((n) => summaryFor(n).sum.isCompilation);
          else if (kind === "albums")
            albums = albums.filter((n) => !summaryFor(n).sum.isCompilation);
          if (a.hires === true) albums = albums.filter((n) => summaryFor(n).sum.hires);
          // the analysis round's facets (0.7.0): the album's recorded DR, all-lossless
          const drMap = albumDrMap();
          const albumDr = (n: MediaNode): number | null => drMap[albumDrKey(n)]?.dr ?? null;
          if (a.lossless === true)
            albums = albums.filter((n) => {
              const { tracks } = summaryFor(n);
              return (
                tracks.length > 0 &&
                tracks.every((t) => LOSSLESS_CODECS.has((t.format?.codec ?? "").toUpperCase()))
              );
            });
          if (a.min_dr != null) {
            const min = a.min_dr as number;
            albums = albums.filter((n) => (albumDr(n) ?? -1) >= min);
          }
          const formatNeedle = (a.format as string | undefined)?.toLowerCase();
          if (formatNeedle != null)
            albums = albums.filter((n) => {
              const { tracks, sum } = summaryFor(n);
              return (
                (sum.format ?? "").toLowerCase().includes(formatNeedle) ||
                tracks.some((t) =>
                  (formatLabel(t.format) ?? "").toLowerCase().includes(formatNeedle),
                )
              );
            });
          const composerNeedle = (a.composer as string | undefined)?.toLowerCase();
          if (composerNeedle != null)
            albums = albums.filter((n) =>
              summaryFor(n).tracks.some((t) =>
                (t.composers ?? []).some((c) => c.toLowerCase().includes(composerNeedle)),
              ),
            );
          const sort = (a.sort as string | undefined) ?? "title";
          albums.sort((x, y) => {
            if (sort === "artist")
              return (
                nameSortKey(x.artist ?? "￿").localeCompare(nameSortKey(y.artist ?? "￿")) ||
                x.title.localeCompare(y.title)
              );
            if (sort === "year")
              return (y.year ?? "").localeCompare(x.year ?? "") || x.title.localeCompare(y.title);
            if (sort === "dr")
              return (albumDr(y) ?? -1) - (albumDr(x) ?? -1) || x.title.localeCompare(y.title);
            return x.title.localeCompare(y.title);
          });
          const offset = (a.offset as number | undefined) ?? 0;
          const limit = (a.limit as number | undefined) ?? 40;
          const page = albums.slice(offset, offset + limit);
          return ok({
            total: albums.length,
            offset,
            returned: page.length,
            albums: page.map((n) => {
              const { sum } = summaryFor(n);
              return {
                server_udn: n.serverUdn,
                server: n.serverName,
                object_id: n.id,
                title: n.title,
                artist: n.artist,
                year: n.year,
                genres: n.genre ?? [],
                // summed from the album's tracks (2026-08-16): what the app's
                // album header shows
                tracks: sum.tracks,
                ...(sum.discs > 1 ? { discs: sum.discs } : {}),
                runtime_seconds: sum.runtimeSecs,
                ...(sum.sizeBytes > 0 ? { size_bytes: sum.sizeBytes } : {}),
                ...(sum.format ? { format: sum.format } : {}),
                ...(sum.formatOdd > 0 ? { format_tracks_differ: sum.formatOdd } : {}),
                hires: sum.hires,
                ...(albumDr(n) != null ? { dr: albumDr(n) } : {}),
                ...(sum.composers.length > 0 ? { composers: sum.composers } : {}),
                is_compilation: sum.isCompilation,
              };
            }),
          });
        },
      },
      list_artists: {
        inputSchema: {
          query: z
            .string()
            .optional()
            .describe("Case-insensitive substring match on the artist name."),
          role: z
            .enum(["performers", "composers"])
            .optional()
            .describe(
              "Default 'performers' (album artists and every performer, featured guests included). 'composers' lists who WROTE the tracks (upnp:artist role=Composer), with track and album counts.",
            ),
          server_udn: z
            .string()
            .optional()
            .describe("Limit to one server (see list_media_servers)."),
          sort: z
            .enum(["name", "albums"])
            .optional()
            .describe("Default 'name' (A–Z); 'albums' sorts by album count, most first."),
          limit: z.number().int().min(1).max(200).optional().describe("Default 100."),
          offset: z.number().int().min(0).optional().describe("For paging; default 0."),
        },
        // index-backed like list_albums — no connected() gate
        handler: (a) => {
          const groups = indexPools().filter((p) => a.server_udn == null || p.udn === a.server_udn);
          if (groups.length === 0) {
            return err(
              a.server_udn != null
                ? `No ready index for server '${String(a.server_udn)}'. Use list_media_servers.`
                : this.kickIndex(),
            );
          }
          // Derive from the album/track pools (like the Artists lens): albums
          // and tracks grouped by normalized artist name, first-seen casing.
          const byName = new Map<string, { name: string; albums: number; tracks: number }>();
          const bump = (artist: string | null, field: "albums" | "tracks"): void => {
            if (!artist?.trim()) return;
            const k = artist.trim().toLowerCase();
            const cur = byName.get(k) ?? { name: artist.trim(), albums: 0, tracks: 0 };
            cur[field]++;
            byName.set(k, cur);
          };
          const role = (a.role as string | undefined) ?? "performers";
          if (role === "composers") {
            // composers: tracks they wrote, and the distinct albums those sit on
            const albumsOf = new Map<string, Set<string>>();
            for (const p of groups)
              for (const t of p.tracks)
                for (const cname of t.composers ?? []) {
                  bump(cname, "tracks");
                  const k = cname.trim().toLowerCase();
                  const set = albumsOf.get(k) ?? new Set<string>();
                  if (t.album) set.add(`${p.udn}|${t.album.toLowerCase()}`);
                  albumsOf.set(k, set);
                }
            for (const [k, cur] of byName) cur.albums = albumsOf.get(k)?.size ?? 0;
          } else {
            for (const p of groups) {
              for (const alb of p.albums) bump(alb.artist, "albums");
              // every PERFORMER, not the packed "A; B" string (featured tracks)
              for (const t of p.tracks) for (const name of trackArtists(t)) bump(name, "tracks");
            }
          }
          const needle = (a.query as string | undefined)?.toLowerCase();
          let artists = [...byName.values()];
          if (needle != null)
            artists = artists.filter((x) => x.name.toLowerCase().includes(needle));
          const sort = (a.sort as string | undefined) ?? "name";
          artists.sort((x, y) =>
            sort === "albums"
              ? y.albums - x.albums || nameSortKey(x.name).localeCompare(nameSortKey(y.name))
              : nameSortKey(x.name).localeCompare(nameSortKey(y.name)),
          );
          const offset = (a.offset as number | undefined) ?? 0;
          const limit = (a.limit as number | undefined) ?? 100;
          const page = artists.slice(offset, offset + limit);
          return ok({ total: artists.length, offset, returned: page.length, artists: page });
        },
      },
      list_tracks: {
        inputSchema: {
          artist: z
            .string()
            .optional()
            .describe("Case-insensitive substring on the track's performers."),
          album: z.string().optional().describe("Case-insensitive substring on the album title."),
          genre: z.string().optional().describe("Case-insensitive genre."),
          decade: z.string().optional().describe("e.g. '1990s'."),
          format: z
            .string()
            .optional()
            .describe(
              "Case-insensitive substring of the format label, e.g. 'FLAC', '24/96', 'MP3'.",
            ),
          lossless: z.boolean().optional().describe("true = lossless codecs only."),
          hires: z
            .boolean()
            .optional()
            .describe(`true = above ${HIRES_BITS_ABOVE}-bit or ${HIRES_RATE_ABOVE / 1000} kHz.`),
          min_dr: z
            .number()
            .int()
            .min(1)
            .max(30)
            .optional()
            .describe(
              "Only tracks with a recorded DR at least this; unanalyzed tracks are excluded.",
            ),
          sort: z
            .enum(["title", "artist", "album", "year", "duration", "dr", "plays", "last_played"])
            .optional()
            .describe(
              "Default 'title'. 'plays' most played first; 'last_played' most recent first; 'dr' most dynamic first; 'duration' longest first.",
            ),
          limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
          offset: z.number().int().min(0).optional().describe("For paging; default 0."),
          server_udn: z
            .string()
            .optional()
            .describe("Limit to one server (see list_media_servers)."),
        },
        handler: async (a) => {
          const groups = indexPools().filter((p) => a.server_udn == null || p.udn === a.server_udn);
          if (groups.length === 0)
            return err(
              a.server_udn != null
                ? `No ready index for server '${String(a.server_udn)}'. Use list_media_servers.`
                : this.kickIndex(),
            );
          const lc = (v: string | null | undefined): string => (v ?? "").toLowerCase();
          const artistNeedle = (a.artist as string | undefined)?.toLowerCase();
          const albumNeedle = (a.album as string | undefined)?.toLowerCase();
          const genreNeedle = (a.genre as string | undefined)?.toLowerCase();
          const decade = a.decade != null ? String(a.decade).replace(/s$/i, "") : null;
          const formatNeedle = (a.format as string | undefined)?.toLowerCase();
          const drOf = (t: MediaNode): number | null => {
            const an = audioAnalysisGet(audioAnalysisKey(t));
            return an && an.dr > 0 ? an.dr : null;
          };
          let tracks = groups.flatMap((p) => p.tracks);
          if (artistNeedle != null)
            tracks = tracks.filter(
              (t) =>
                trackArtists(t).some((n) => n.toLowerCase().includes(artistNeedle)) ||
                lc(t.artist).includes(artistNeedle),
            );
          if (albumNeedle != null) tracks = tracks.filter((t) => lc(t.album).includes(albumNeedle));
          if (genreNeedle != null)
            tracks = tracks.filter((t) =>
              (t.genre ?? []).some((g) => g.toLowerCase() === genreNeedle),
            );
          if (decade != null)
            tracks = tracks.filter(
              (t) => t.year != null && String(Math.floor(Number(t.year) / 10) * 10) === decade,
            );
          if (formatNeedle != null)
            tracks = tracks.filter(
              (t) =>
                (formatLabel(t.format) ?? "").toLowerCase().includes(formatNeedle) ||
                lc(t.format?.codec).includes(formatNeedle),
            );
          if (a.lossless === true)
            tracks = tracks.filter((t) =>
              LOSSLESS_CODECS.has((t.format?.codec ?? "").toUpperCase()),
            );
          if (a.hires === true)
            tracks = tracks.filter((t) => (t.format ? isHiRes(t.format) : false));
          if (a.min_dr != null) {
            const min = a.min_dr as number;
            tracks = tracks.filter((t) => (drOf(t) ?? -1) >= min);
          }
          const stats = await playStatsFromRecord();
          const statOf = (t: MediaNode) =>
            stats.tracks[playKey(t.title, t.artist, t.album)] ?? null;
          const sort = (a.sort as string | undefined) ?? "title";
          const byTitle = (x: MediaNode, y: MediaNode): number =>
            x.title.localeCompare(y.title) || lc(x.artist).localeCompare(lc(y.artist));
          const byAlbum = (x: MediaNode, y: MediaNode): number =>
            lc(x.album).localeCompare(lc(y.album)) ||
            (trackPosition(x) ?? 0) - (trackPosition(y) ?? 0) ||
            byTitle(x, y);
          tracks = [...tracks].sort((x, y) => {
            if (sort === "artist")
              return (
                nameSortKey(x.artist ?? "￿").localeCompare(nameSortKey(y.artist ?? "￿")) ||
                byAlbum(x, y)
              );
            if (sort === "album") return byAlbum(x, y);
            if (sort === "year") return (y.year ?? "").localeCompare(x.year ?? "") || byAlbum(x, y);
            if (sort === "duration")
              return (y.durationSecs ?? 0) - (x.durationSecs ?? 0) || byTitle(x, y);
            if (sort === "dr") return (drOf(y) ?? -1) - (drOf(x) ?? -1) || byTitle(x, y);
            if (sort === "plays")
              return (statOf(y)?.plays ?? 0) - (statOf(x)?.plays ?? 0) || byTitle(x, y);
            if (sort === "last_played")
              return (statOf(y)?.lastAt ?? 0) - (statOf(x)?.lastAt ?? 0) || byTitle(x, y);
            return byTitle(x, y);
          });
          const offset = (a.offset as number | undefined) ?? 0;
          const limit = (a.limit as number | undefined) ?? 50;
          const page = tracks.slice(offset, offset + limit);
          return ok({
            total: tracks.length,
            offset,
            returned: page.length,
            tracks: page.map((t) => {
              const st = statOf(t);
              const dr = drOf(t);
              return {
                server_udn: t.serverUdn,
                object_id: t.id,
                title: t.title,
                artist: t.artist,
                album: t.album,
                year: t.year,
                ...(t.trackNumber != null ? { track_number: t.trackNumber } : {}),
                duration_seconds: t.durationSecs,
                ...(formatLabel(t.format) ? { format: formatLabel(t.format) } : {}),
                ...(dr != null ? { dr } : {}),
                plays: st?.plays ?? 0,
                last_played: st ? new Date(st.lastAt).toISOString() : null,
              };
            }),
          });
        },
      },
      get_track_analysis: {
        inputSchema: {
          title: z
            .string()
            .optional()
            .describe("A track title in the library; omit for the playing track."),
          artist: z.string().optional(),
          album: z.string().optional(),
        },
        handler: (a) => {
          const lc = (v: string | null | undefined): string => (v ?? "").toLowerCase();
          let t:
            | (Pick<MediaNode, "title" | "artist" | "album" | "durationSecs"> & {
                albumArtist?: string | null;
              })
            | null = null;
          if (a.title) {
            const title = lc(a.title as string);
            t =
              indexPools()
                .flatMap((p) => p.tracks)
                .find(
                  (n) =>
                    lc(n.title) === title &&
                    (!a.artist || lc(n.artist).includes(lc(a.artist as string))) &&
                    (!a.album || lc(n.album).includes(lc(a.album as string))),
                ) ?? null;
            if (!t)
              return err(
                `No indexed track titled "${String(a.title)}". Use list_tracks or search_library.`,
              );
          } else {
            const md = dm.snapshot().playState?.metadata;
            if (!md?.title) return err("Nothing is playing and no track was named.");
            t = { title: md.title, artist: md.artist, album: md.album, durationSecs: md.duration };
          }
          const an = audioAnalysisGet(audioAnalysisKey(t));
          const albumDr = t.album
            ? (albumDrMap()[albumDrKey({ title: t.album, artist: t.albumArtist ?? t.artist })]
                ?.dr ?? null)
            : null;
          return ok({
            track: { title: t.title, artist: t.artist, album: t.album },
            analyzed: an != null,
            ...(an
              ? {
                  dr: an.dr > 0 ? an.dr : null,
                  peak_db: an.peakDb,
                  rms_db: an.rmsDb,
                  crest_db: an.crestDb,
                }
              : {
                  note: "Not analyzed yet. It is analyzed the first time it plays in TastyTunes, or with Analyze audio on its album.",
                }),
            album_dr: albumDr,
            dr_definition:
              "TT-DR, the DR database's procedure; the album value needs every track analyzed.",
          });
        },
      },
      get_media_info: {
        inputSchema: {
          server_udn: z
            .string()
            .describe("From search_library / list_albums / list_media_servers."),
          object_id: z.string().describe("The album, track or artist object id."),
        },
        // Everything the local index knows about one thing — the app's Info
        // modal as a tool. Index-backed (no connected() gate); an object the
        // index doesn't hold (a Browse-only server before its build, a plain
        // folder) says so rather than guessing.
        handler: (a) => {
          const pool = indexPools().find((p) => p.udn === a.server_udn);
          if (!pool)
            return err(
              indexPools().length === 0
                ? this.kickIndex()
                : `No ready index for server '${String(a.server_udn)}'. Use list_media_servers.`,
            );
          const id = a.object_id as string;
          const node =
            pool.tracks.find((n) => n.id === id) ??
            pool.albums.find((n) => n.id === id) ??
            pool.artists.find((n) => n.id === id);
          if (!node)
            return err(
              `Object '${id}' is not in the index for '${pool.serverName}' — search_library or list_albums give indexed ids.`,
            );
          const kind = pool.tracks.includes(node)
            ? "track"
            : pool.albums.includes(node)
              ? "album"
              : "artist";
          const base = {
            kind,
            server_udn: pool.udn,
            server: pool.serverName,
            object_id: node.id,
            parent_id: node.parentId,
            upnp_class: node.upnpClass,
            title: node.title,
            ...(node.artist ? { artist: node.artist } : {}),
            ...(node.year ? { year: node.year } : {}),
            genres: node.genre ?? [],
            art_url: node.artUrl,
          };
          if (kind === "track") {
            const f = node.format;
            return ok({
              ...base,
              performers: trackArtists(node),
              ...(node.albumArtist ? { album_artist: node.albumArtist } : {}),
              ...(node.album ? { album: node.album } : {}),
              ...(node.composers ? { composers: node.composers } : {}),
              ...(node.trackNumber != null ? { track_number: trackPosition(node) } : {}),
              ...(node.discNumber != null ? { disc_number: node.discNumber } : {}),
              ...(node.discCount != null ? { disc_count: node.discCount } : {}),
              duration_seconds: node.durationSecs,
              ...(f
                ? {
                    format: formatLabel(f),
                    codec: f.codec,
                    ...(f.bits ? { bits_per_sample: f.bits } : {}),
                    ...(f.rate ? { sample_rate_hz: f.rate } : {}),
                    ...(f.kbps ? { bitrate_kbps: f.kbps } : {}),
                    ...(f.channels ? { channels: f.channels } : {}),
                    ...(f.sizeBytes ? { size_bytes: f.sizeBytes } : {}),
                  }
                : {}),
            });
          }
          if (kind === "album") {
            const tracks = albumTracksOf(node, pool);
            const sum = albumSummary(node, tracks);
            return ok({
              ...base,
              tracks: sum.tracks,
              discs: sum.discs,
              runtime_seconds: sum.runtimeSecs,
              ...(sum.sizeBytes > 0 ? { size_bytes: sum.sizeBytes } : {}),
              ...(sum.format ? { format: sum.format } : {}),
              ...(sum.formatOdd > 0 ? { format_tracks_differ: sum.formatOdd } : {}),
              hires: sum.hires,
              ...(sum.composers.length > 0 ? { composers: sum.composers } : {}),
              is_compilation: sum.isCompilation,
              track_list: tracks.map((t) => ({
                object_id: t.id,
                title: t.title,
                ...(t.discNumber != null ? { disc: t.discNumber } : {}),
                ...(t.trackNumber != null ? { track: trackPosition(t) } : {}),
                artist: t.artist,
                ...(t.artists ? { performers: t.artists } : {}),
                ...(t.composers ? { composers: t.composers } : {}),
                duration_seconds: t.durationSecs,
                ...(t.format ? { format: formatLabel(t.format) } : {}),
              })),
            });
          }
          // artist: their library page (albums, credits) — artistSummary, the modal's source
          const summary = artistSummary(node.title, pool);
          return ok({
            ...base,
            albums: summary.albums.map((x) => ({
              object_id: x.objectId,
              title: x.title,
              year: x.year,
              tracks: x.tracks,
              ...(x.format ? { format: x.format } : {}),
            })),
            track_count: summary.trackCount,
            guest_on: summary.guestOn.map((g) => ({
              object_id: g.objectId,
              title: g.title,
              album: g.album,
              album_artist: g.albumArtist,
            })),
            composed: summary.composed.map((x) => ({
              object_id: x.objectId,
              title: x.title,
              album: x.album,
            })),
            genres_across_albums: summary.genres,
            ...(summary.years ? { active_years: summary.years } : {}),
          });
        },
      },
      play_media: {
        inputSchema: {
          server_udn: z.string().describe("From search_library / list_media_servers."),
          object_id: z.string().describe("From search_library."),
          mode: z
            .enum(["play_now", "play_next", "append", "replace"])
            .optional()
            .describe(
              "Default play_now (keeps the queue). 'replace' clears the queue — only when asked to.",
            ),
        },
        handler: async (a) => {
          const s = this.connected();
          const mode = (a.mode as string | undefined) ?? "play_now";
          try {
            await this.dm.ensureAwake(); // agents get wake-on-intent too
            await queueAdd(
              s.connection.host,
              a.server_udn as string,
              a.object_id as string,
              QUEUE_MODES[mode],
            );
          } catch (e) {
            return err(
              `Couldn't queue that item — its object id may be stale; run search_library again. (${(e as Error).message})`,
            );
          }
          return ok(
            mode === "replace"
              ? "Playing — the previous queue was replaced."
              : mode === "play_now"
                ? "Playing now (the queue is kept)."
                : mode === "play_next"
                  ? "Queued to play next."
                  : "Added to the end of the queue.",
          );
        },
      },

      // ---- radio (keyless directory; never any listening telemetry)
      search_radio: {
        inputSchema: {
          query: z
            .string()
            .optional()
            .describe("Station name or place. Optional when genre is given."),
          genre: z
            .string()
            .optional()
            .describe(
              "Style tag, e.g. 'jazz' — matched against the directory's tags, most-listened first.",
            ),
        },
        handler: async (a) => {
          // The directory gate lives at the source (radioBrowser.fetchRaw), so
          // with the setting off this tool would "work" and return [] — which
          // an agent reads as "no stations matched", not "lookups are off".
          // Humans get a disabled chip for this state; the agent gets told.
          if (getSettings().radioDirectory === false) {
            return err(
              "The internet-radio directory is turned off in Settings (Behavior → Internet radio directory), so station lookups are unavailable. Favorited stations still play.",
            );
          }
          const q = (a.query as string | undefined)?.trim();
          const g = (a.genre as string | undefined)?.trim().toLowerCase();
          if (!q && !g) return err("Pass query and/or genre.");
          let stations;
          if (g && !q) stations = await radioByTags([g]);
          else {
            stations = await radioSearch(q as string);
            if (g)
              stations = stations.filter((st) =>
                st.tags
                  .toLowerCase()
                  .split(",")
                  .map((t) => t.trim())
                  .includes(g),
              );
          }
          return ok(
            stations.slice(0, 15).map((st) => ({
              name: st.name,
              url: st.url,
              country: st.country,
              codec: st.codec,
              tags: st.tags,
            })),
          );
        },
      },
      play_radio: {
        inputSchema: {
          url: z.string().url().describe("Stream URL (from search_radio or a station favorite)."),
          name: z.string().min(1).describe("Display name for the station."),
        },
        handler: async (a) => {
          this.connected();
          await dm.command({ type: "streamRadio", url: a.url as string, name: a.name as string });
          return ok(`Tuning to ${String(a.name)}.`);
        },
      },

      // ---- favorites
      list_playlists: {
        handler: () => {
          const s = dm.snapshot();
          return ok(
            s.playlists.map((p) => ({
              id: p.id,
              name: p.name,
              tracks: p.items.length,
              seconds: p.items.reduce((n, i) => n + (i.durationSecs ?? 0), 0),
              last_played: p.lastPlayedAt ?? null,
              // surfaced because a run that skipped tracks is worth knowing
              // about before you play it again
              missing_last_time: p.lastMissing ?? [],
            })),
          );
        },
      },
      get_playlist: {
        inputSchema: { id: z.string().describe("Playlist id from list_playlists.") },
        handler: (a) => {
          const p = dm.snapshot().playlists.find((x) => x.id === a.id);
          if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
          return ok({
            id: p.id,
            name: p.name,
            items: p.items.map((i) => ({
              title: i.title,
              artist: i.artist,
              album: i.album,
              seconds: i.durationSecs ?? null,
            })),
          });
        },
      },
      play_playlist: {
        inputSchema: { id: z.string().describe("Playlist id from list_playlists.") },
        handler: async (a) => {
          this.connected();
          const p = dm.snapshot().playlists.find((x) => x.id === a.id);
          if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
          if (p.items.length === 0) return err(`"${p.name}" is empty.`);
          const res = await dm.playlistActivate(a.id as string);
          const missed = res.missed.length;
          // Name a few and count the rest: a long playlist can miss dozens, and
          // twenty-two titles inline is noise an agent has to wade through.
          const sample = res.missed.slice(0, 3).join(", ");
          const more = res.missed.length - 3;
          return ok(
            missed > 0
              ? `Queued ${res.added} of ${res.total} from "${p.name}". ${missed} not found on any media server (${sample}${more > 0 ? `, +${more} more` : ""}).`
              : `Queued ${res.added} ${res.added === 1 ? "track" : "tracks"} from "${p.name}".`,
          );
        },
      },
      create_playlist: {
        inputSchema: {
          name: z.string().describe("Name for the new playlist."),
          from_queue: z
            .boolean()
            .optional()
            .describe("Seed it with the current play queue (default false — creates it empty)."),
        },
        handler: (a) => {
          const s = dm.snapshot();
          const items =
            a.from_queue === true
              ? (s.queue?.items ?? [])
                  .map((i) => i.metadata)
                  .filter((m): m is NonNullable<typeof m> => m != null)
                  .map((m) => ({
                    title: m.title ?? "Unknown track",
                    artist: m.artist ?? null,
                    album: m.album ?? null,
                    artUrl: m.art_url ?? null,
                    serverUdn: null,
                    serverName: null,
                    objectId: null,
                    durationSecs: m.duration ?? null,
                  }))
              : [];
          // The returned playlist, not a lookup by name: on a name collision
          // the stored name is uniquified, and finding by the REQUESTED name
          // would report the old playlist's id — an agent would then edit
          // the wrong list.
          const made = dm.playlistCreate(a.name as string, items);
          return ok(`Created "${made.name}" with ${made.items.length} tracks. id: ${made.id}`);
        },
      },
      add_to_playlist: {
        inputSchema: { id: z.string().describe("Playlist id from list_playlists.") },
        handler: (a) => {
          const s = dm.snapshot();
          const p = s.playlists.find((x) => x.id === a.id);
          if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
          const md = s.playState?.metadata;
          // A playlist is an ordered list of TRACKS; a stream has no position
          // in one, and content identity needs a title and an artist.
          if (!md || isRadioMetadata(md)) return err("Nothing playing that can go in a playlist.");
          if (!md.title || !md.artist)
            return err("The playing track has no title/artist to store.");
          dm.playlistAppend(a.id as string, [
            {
              title: md.title,
              artist: md.artist,
              album: md.album ?? null,
              artUrl: md.art_url ?? null,
              serverUdn: null,
              serverName: null,
              objectId: null,
              durationSecs: md.duration ?? null,
            },
          ]);
          return ok(`Added "${md.title}" to "${p.name}".`);
        },
      },
      delete_playlist: {
        inputSchema: { id: z.string().describe("Playlist id from list_playlists.") },
        handler: (a) => {
          const p = dm.snapshot().playlists.find((x) => x.id === a.id);
          if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
          dm.playlistDelete(a.id as string);
          return ok(`Deleted "${p.name}".`);
        },
      },
      list_favorites: {
        handler: () => {
          const s = dm.snapshot();
          return ok(
            s.favorites.map((f) =>
              f.kind === "station"
                ? { key: favoriteKey(f), kind: f.kind, name: f.name, url: f.url }
                : {
                    key: favoriteKey(f),
                    kind: f.kind,
                    title: f.title,
                    artist: f.artist,
                    album: f.album,
                  },
            ),
          );
        },
      },
      play_favorite: {
        inputSchema: { key: z.string().describe("Favorite key from list_favorites.") },
        handler: async (a) => {
          const s = this.connected();
          const fav = s.favorites.find((f) => favoriteKey(f) === a.key);
          if (!fav) return err(`No favorite '${String(a.key)}'. Use list_favorites.`);
          if (fav.kind === "station") {
            await dm.command({ type: "streamRadio", url: fav.url, name: fav.name });
            return ok(`Tuning to ${fav.name}.`);
          }
          const host = s.connection.host;
          await dm.ensureAwake(); // favorites are wake intents too
          if (fav.serverUdn && fav.objectId) {
            try {
              await queueAdd(host, fav.serverUdn, fav.objectId, "PLAY_NOW");
              return ok(`Playing ${fav.title}.`);
            } catch {
              // stored id went stale — heal by content below (the app's model:
              // object ids are hints, title/artist identity is the truth)
            }
          }
          for (const server of (await refreshServers(host)).filter((x) => x.searchable)) {
            const { items } = await librarySearch(host, server.udn, fav.title);
            const match = items.find(
              (n) =>
                kindOf(n) === fav.kind &&
                lc(n.title) === lc(fav.title) &&
                (fav.artist == null || n.artist == null || lc(n.artist) === lc(fav.artist)),
            );
            if (match) {
              await queueAdd(host, server.udn, match.id, "PLAY_NOW");
              dm.favoriteUpdate(a.key as string, {
                serverUdn: server.udn,
                serverName: server.name,
                objectId: match.id,
              });
              return ok(`Playing ${fav.title} (found on ${server.name}).`);
            }
          }
          return err(`Couldn't find "${fav.title}" on any media server right now.`);
        },
      },
      add_favorite: {
        inputSchema: {
          station_url: z.string().url().optional().describe("Favorite a station: its stream URL…"),
          station_name: z.string().optional().describe("…and its display name (both or neither)."),
        },
        handler: (a) => {
          const s = this.connected();
          let fav: Favorite;
          if (a.station_url != null || a.station_name != null) {
            if (typeof a.station_url !== "string" || typeof a.station_name !== "string") {
              return err(
                "Pass BOTH station_url and station_name (or neither, to favorite the current track).",
              );
            }
            fav = {
              kind: "station",
              addedAt: Date.now(),
              name: a.station_name,
              url: a.station_url,
              favicon: null,
              radioBrowserUuid: null,
            };
          } else {
            const md = s.playState?.metadata;
            if (md?.station) {
              return err(
                "For radio, pass station_url + station_name — the stream URL isn't knowable from playback metadata.",
              );
            }
            if (!md?.title) return err("Nothing identifiable is playing.");
            fav = {
              kind: "track",
              addedAt: Date.now(),
              title: md.title,
              artist: md.artist ?? null,
              album: md.album ?? null,
              artUrl: md.art_url ?? null,
              serverUdn: null,
              serverName: null,
              objectId: null,
              titlePath: null,
              durationSecs: md.duration ?? null,
            };
          }
          const key = favoriteKey(fav);
          if (s.favorites.some((f) => favoriteKey(f) === key)) return ok("Already a favorite.");
          dm.favoriteAdd(fav);
          return ok(
            fav.kind === "station" ? `Favorited station ${fav.name}.` : `Favorited "${fav.title}".`,
          );
        },
      },
      remove_favorite: {
        inputSchema: { key: z.string().describe("Favorite key from list_favorites.") },
        handler: (a) => {
          const s = this.connected();
          const fav = s.favorites.find((f) => favoriteKey(f) === a.key);
          if (!fav) return err(`No favorite with key '${String(a.key)}'. Use list_favorites.`);
          dm.favoriteRemove(a.key as string);
          return ok(
            fav.kind === "station"
              ? `Removed station ${fav.name} from favorites.`
              : `Removed "${fav.title}" from favorites.`,
          );
        },
      },

      // ---- tone & EQ (feature-detected; toneCaps errors cleanly without)
      get_audio_settings: {
        handler: () => {
          const { s, caps } = toneCaps();
          const za = s.zoneAudio;
          return ok({
            user_eq_enabled: za?.user_eq?.enabled ?? false,
            band_gains_db: za?.user_eq?.bands?.map((b) => b.gain) ?? null,
            tilt: za?.tilt_eq ?? null,
            balance: za?.balance ?? null,
            ranges: {
              band_gain_db: { min: EQ_GAIN_MIN, max: EQ_GAIN_MAX },
              tilt: caps.tilt ? caps.tiltRange : null,
              balance: caps.balance ? caps.balanceRange : null,
            },
            saved_presets: getSettings().eqPresets.map((p) => p.name),
          });
        },
      },
      set_eq_band: {
        inputSchema: {
          band: z
            .number()
            .int()
            .min(0)
            .max(6)
            .describe("Band index 0 (lowest) … 6 (highest frequency)."),
          gain_db: z.number().min(EQ_GAIN_MIN).max(EQ_GAIN_MAX),
        },
        handler: async (a) => {
          const { s } = toneCaps();
          if (s.zoneAudio?.user_eq?.enabled !== true)
            await dm.command({ type: "setUserEq", enabled: true });
          await dm.command({
            type: "setEqBandGain",
            index: a.band as number,
            gain: a.gain_db as number,
          });
          return ok(`Band ${String(a.band)} set to ${String(a.gain_db)} dB.`);
        },
      },
      set_tilt: {
        inputSchema: {
          intensity: z
            .number()
            .describe("Negative = warmer, positive = brighter (range from get_audio_settings)."),
        },
        handler: async (a) => {
          const { s, caps } = toneCaps();
          if (!caps.tilt) return err("This streamer has no tone tilt.");
          if (s.zoneAudio?.tilt_eq?.enabled !== true)
            await dm.command({ type: "setTiltEq", enabled: true });
          await dm.command({ type: "setTiltIntensity", intensity: a.intensity as number });
          return ok(`Tilt set to ${String(a.intensity)}.`);
        },
      },
      set_balance: {
        inputSchema: {
          balance: z
            .number()
            .describe("Negative = left, positive = right (range from get_audio_settings)."),
        },
        handler: async (a) => {
          const { caps } = toneCaps();
          if (!caps.balance) return err("This streamer has no balance control.");
          await dm.command({ type: "setBalance", balance: a.balance as number });
          return ok(`Balance set to ${String(a.balance)}.`);
        },
      },
      apply_eq_preset: {
        inputSchema: { name: z.string().describe("A saved preset name from get_audio_settings.") },
        handler: async (a) => {
          toneCaps();
          const preset = getSettings().eqPresets.find((p) => lc(p.name) === lc(a.name as string));
          if (!preset)
            return err(
              `No saved EQ preset named '${String(a.name)}'. get_audio_settings lists them.`,
            );
          await dm.command({ type: "setUserEq", enabled: true });
          await dm.command({ type: "setEqBands", gains: preset.gains });
          return ok(`Applied EQ preset "${preset.name}".`);
        },
      },
      reset_eq: {
        handler: async () => {
          toneCaps();
          await dm.command({ type: "setEqBands", gains: [0, 0, 0, 0, 0, 0, 0] });
          return ok("EQ reset to flat.");
        },
      },

      // ---- display
      set_display_brightness: {
        inputSchema: { level: z.enum(["off", "dim", "bright"]) },
        handler: async (a) => {
          const s = this.connected();
          const options = brightnessOptions(s.displaySpec);
          if (!options) return err("This streamer has no front-panel display.");
          if (!options.includes(a.level as string)) {
            return err(`This display only supports: ${options.join(", ")}.`);
          }
          await dm.command({ type: "setBrightness", brightness: a.level as string });
          return ok(`Display set to ${String(a.level)}.`);
        },
      },

      // ---- lookups (each behind its Connections toggle: off = no requests, ever)
      get_lyrics: {
        handler: async () => {
          if (!getSettings().lyrics) {
            return err(
              "Lyrics lookups are switched off in Settings → Connections (off means no requests, ever).",
            );
          }
          const s = this.connected();
          const md = s.playState?.metadata;
          if (!md?.title || !md.artist) return err("Need a playing track with a title and artist.");
          const r = await fetchLyrics({
            artist: md.artist,
            title: md.title,
            album: md.album ?? null,
            duration: md.duration ?? null,
          });
          if (!r) return ok("No lyrics found for this track.");
          if (r.instrumental) return ok("Instrumental — no lyrics.");
          return ok({ title: md.title, artist: md.artist, lyrics: r.plain ?? r.synced });
        },
      },
      get_artist_info: {
        inputSchema: { artist: z.string().optional().describe("Defaults to the playing artist.") },
        handler: async (a) => {
          if (!getSettings().artistInfo) {
            return err(
              "Artist context is switched off in Settings → Connections (off means no requests, ever).",
            );
          }
          const s = this.connected();
          const name = (a.artist as string | undefined) ?? s.playState?.metadata?.artist ?? null;
          if (!name) return err("No artist playing — pass artist explicitly.");
          const info = await fetchArtistInfo(name);
          if (!info) return ok(`No artist match for "${name}".`);
          return ok({
            name: info.name,
            summary: info.summary,
            wikipedia: info.wikipediaUrl,
            musicbrainz: info.musicbrainzUrl,
          });
        },
      },
      get_album_info: {
        inputSchema: {
          artist: z.string().optional().describe("Defaults to the playing artist."),
          album: z.string().optional().describe("Defaults to the playing album."),
        },
        handler: async (a) => {
          // one toggle governs both context tabs in the app — same here
          if (!getSettings().artistInfo) {
            return err(
              "Artist & album context is switched off in Settings → Connections (off means no requests, ever).",
            );
          }
          const s = this.connected();
          const artist = (a.artist as string | undefined) ?? s.playState?.metadata?.artist ?? null;
          const album = (a.album as string | undefined) ?? s.playState?.metadata?.album ?? null;
          if (!artist || !album) return err("No album playing — pass artist and album explicitly.");
          const info = await fetchAlbumInfo(artist, album);
          if (!info) return ok(`No album match for "${album}" by ${artist}.`);
          return ok({
            title: info.title,
            year: info.year,
            type: info.type,
            label: info.label,
            genres: info.genres,
            credits: info.credits,
            summary: info.summary,
            wikipedia: info.wikipediaUrl,
            musicbrainz: info.musicbrainzUrl,
          });
        },
      },

      // ---- queue editing (opt-in cluster)
      remove_queue_item: {
        inputSchema: { id: z.number().int().describe("Queue item id from list_queue.") },
        handler: async (a) => {
          const s = this.connected();
          const item = (s.queue?.items ?? []).find((i) => i.id === a.id);
          if (!item) return err(`No queue item ${String(a.id)}. Use list_queue.`);
          await dm.command({ type: "queueDelete", id: a.id as number });
          return ok(`Removed "${item.metadata?.title ?? `item ${String(a.id)}`}" from the queue.`);
        },
      },
      clear_queue: {
        handler: async () => {
          const s = this.connected();
          const n = s.queue?.total ?? s.queue?.items?.length ?? 0;
          await dm.command({ type: "queueClear" });
          return ok(`Queue cleared (${n} items removed).`);
        },
      },
      move_queue_item: {
        inputSchema: {
          id: z.number().int().describe("Queue item id from list_queue."),
          to_position: z.number().int().min(0).describe("New 0-based position."),
        },
        handler: async (a) => {
          const s = this.connected();
          const item = (s.queue?.items ?? []).find((i) => i.id === a.id);
          if (!item || item.position == null)
            return err(`No queue item ${String(a.id)}. Use list_queue.`);
          const total = s.queue?.total ?? 0;
          if ((a.to_position as number) >= total) return err(`to_position must be below ${total}.`);
          await dm.command({
            type: "queueMove",
            id: a.id as number,
            from: item.position,
            to: a.to_position as number,
          });
          return ok(
            `Moved "${item.metadata?.title ?? `item ${String(a.id)}`}" to position ${String(a.to_position)}.`,
          );
        },
      },

      // ---- preset saving (opt-in cluster; explicit-overwrite contract)
      save_queue_as_preset: {
        inputSchema: {
          slot: z.number().int().min(1).max(99).describe("Preset slot 1–99."),
          name: z.string().min(1).describe("Name for the saved queue."),
          overwrite: z.boolean().optional().describe("Must be true to replace an occupied slot."),
        },
        handler: async (a) => {
          const s = this.connected();
          if ((s.queue?.total ?? 0) === 0) return err("The queue is empty.");
          guardSlot(s, a.slot as number, a.overwrite === true);
          await dm.command({
            type: "queueSavePreset",
            slot: a.slot as number,
            name: a.name as string,
          });
          return ok(`Saved the queue to preset ${String(a.slot)} as "${String(a.name)}".`);
        },
      },
      repair_preset: {
        inputSchema: {
          slot: z.number().int().min(1).max(99).describe("The preset slot that will not play."),
        },
        handler: async (a) => {
          const s = this.connected();
          const slot = a.slot as number;
          const preset = (s.presets?.presets ?? []).find((p) => p.id === slot);
          if (!preset) return err(`Preset slot ${slot} is empty.`);
          if (!preset.art_url)
            return err(`Preset ${slot} has no artwork to match on, so it cannot be repaired here.`);
          // The art id survives the object-id churn that breaks presets, which
          // is what makes this a lookup rather than a guess.
          const hits = indexPools().flatMap((pool) =>
            pool.albums.filter((alb) => alb.artUrl != null && alb.artUrl === preset.art_url),
          );
          if (hits.length === 0)
            return err(
              `Nothing in the library index matches preset ${slot}'s artwork. Build the index for the server that holds it (rebuild_library_index) and try again.`,
            );
          if (hits.length > 1)
            return err(
              `Preset ${slot}'s artwork matches ${hits.length} albums, so the right one is ambiguous — repair it from the app instead.`,
            );
          const match = hits[0];
          if (!match.serverUdn)
            return err("The matched album has no server — index may be mid-build.");
          await presetSave(s.connection.host, match.serverUdn, match.id, slot);
          return ok({
            slot,
            repaired_to: match.title,
            artist: match.artist ?? null,
            server: match.serverName ?? null,
          });
        },
      },
      save_playing_to_preset: {
        inputSchema: {
          slot: z.number().int().min(1).max(99).describe("Preset slot 1–99."),
          name: z
            .string()
            .optional()
            .describe("Optional rename (the firmware derives a name otherwise)."),
          overwrite: z.boolean().optional().describe("Must be true to replace an occupied slot."),
        },
        handler: async (a) => {
          const s = this.connected();
          if (s.playState?.state !== "play" && s.playState?.state !== "pause") {
            return err("Nothing is playing to save.");
          }
          guardSlot(s, a.slot as number, a.overwrite === true);
          await dm.command({ type: "zoneSavePreset", slot: a.slot as number });
          if (typeof a.name === "string" && a.name.length > 0) {
            await dm.command({ type: "presetRename", slot: a.slot as number, name: a.name });
          }
          return ok(
            `Saved the current playback to preset ${String(a.slot)}${a.name ? ` as "${String(a.name)}"` : ""}.`,
          );
        },
      },

      // ---- schedules (opt-in cluster; list_schedules lives with Status & lists)
      create_schedule: {
        inputSchema: {
          time: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .describe("Local 24h 'HH:MM', e.g. '07:30'."),
          days: z
            .array(z.number().int().min(0).max(6))
            .min(1)
            .describe("Days it fires: 0 = Sunday … 6 = Saturday."),
          action: z
            .enum(["wake", "standby"])
            .describe("wake = power on (optionally recall a preset); standby = power down."),
          preset_id: z
            .number()
            .int()
            .min(1)
            .max(99)
            .optional()
            .describe("Wake only: preset to recall after powering on."),
          volume_percent: z
            .number()
            .int()
            .min(0)
            .max(100)
            .optional()
            .describe("Wake only: volume to set after the preset settles."),
          enabled: z.boolean().optional().describe("Default true."),
        },
        handler: (a) => {
          if (a.action === "standby" && (a.preset_id != null || a.volume_percent != null)) {
            return err("preset_id and volume_percent only apply to wake schedules.");
          }
          const sched: Schedule = {
            id: randomUUID(),
            enabled: a.enabled !== false,
            time: a.time as string,
            days: [...new Set(a.days as number[])].sort(),
            action: a.action === "wake" ? "on" : "standby",
            presetId: (a.preset_id as number | undefined) ?? null,
            volumePercent: (a.volume_percent as number | undefined) ?? null,
          };
          this.mutateSchedules((list) => [...list, sched]);
          return ok({
            created: scheduleOut(sched),
            note: "Schedules fire only while TastyTunes is running and connected.",
          });
        },
      },
      set_schedule_enabled: {
        inputSchema: {
          id: z.string().describe("Schedule id from list_schedules."),
          enabled: z.boolean(),
        },
        handler: (a) => {
          const found = getSettings().schedules.find((x) => x.id === a.id);
          if (!found) return err(`No schedule '${String(a.id)}'. Use list_schedules.`);
          this.mutateSchedules((list) =>
            list.map((x) => (x.id === a.id ? { ...x, enabled: a.enabled as boolean } : x)),
          );
          return ok(`Schedule ${a.enabled ? "enabled" : "disabled"}.`);
        },
      },
      delete_schedule: {
        inputSchema: { id: z.string().describe("Schedule id from list_schedules.") },
        handler: (a) => {
          const found = getSettings().schedules.find((x) => x.id === a.id);
          if (!found) return err(`No schedule '${String(a.id)}'. Use list_schedules.`);
          this.mutateSchedules((list) => list.filter((x) => x.id !== a.id));
          return ok("Schedule deleted.");
        },
      },
    };
  }

  /** Persist a schedules change and tell the renderer (settings push). */
  private mutateSchedules(fn: (list: Schedule[]) => Schedule[]): void {
    const next = updateSettings({ schedules: fn(getSettings().schedules) });
    this.onSettingsMutated?.(next);
  }
}

/** Agent-facing schedule shape: 'wake' instead of the internal 'on'. */
function scheduleOut(s: Schedule): Record<string, unknown> {
  return {
    id: s.id,
    enabled: s.enabled,
    time: s.time,
    days: s.days,
    action: s.action === "on" ? "wake" : "standby",
    preset_id: s.presetId,
    volume_percent: s.volumePercent,
  };
}
