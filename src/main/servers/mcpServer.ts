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
import {
  type AppSettings,
  type McpSettings,
  type Schedule,
  albumTracksOf,
  trackPosition,
} from "@shared/model";
import { resumeRun, resumeTarget } from "@shared/model";
import { playStatsFromRecord } from "../data/playStats";
import { MCP_CLUSTERS, mcpClusterEnabled } from "@shared/mcpCatalog";
import { app } from "electron";
import type { MenuCommand } from "@shared/ipc";
import type { DeviceManager } from "../device/deviceManager";
import { getSettings, updateSettings } from "../data/persist";

import { refreshServers } from "../media/upnpBrowser";
import { pools as indexPools, ensureFresh as indexEnsureFresh } from "../media/mediaIndex";
import {
  type ConnectedSnapshot,
  type ResumeOffer,
  type ToolContext,
  type ToolImpl,
  err,
} from "./mcp/toolkit";
import { deviceTools } from "./mcp/deviceTools";
import { libraryTools } from "./mcp/libraryTools";
import { historyTools } from "./mcp/historyTools";
import { collectionTools } from "./mcp/collectionTools";
import { audioTools } from "./mcp/audioTools";
import { editTools } from "./mcp/editTools";
import { sceneTools } from "./mcp/sceneTools";

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
  /** A menu command to the main window (set_display_mode); index.ts wires this to
   *  sendMenuCommand, which raises the window if there is none. */
  sendCommand: ((command: MenuCommand) => void) | null = null;
  /** Display mode as the renderer last reported it (store.setDisplayMode → IPC.displayModeReport):
   *  renderer state main would not otherwise know. */
  private displayModeOn = false;

  constructor(private dm: DeviceManager) {}

  reportDisplayMode(on: boolean): void {
    this.displayModeOn = on;
  }

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
  /** The resume card's offer, resolved in main: the record's most recent
   *  unfinished album run (shared resumeRun) against the index's albums. */
  private async resumeOffer(): Promise<ResumeOffer> {
    const stats = await playStatsFromRecord();
    const run = resumeRun(stats.recent);
    if (!run) return { reason: "No album was left unfinished in the past week." };
    const lc = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();
    const groups = indexPools();
    const albums = groups.flatMap((p) => p.albums);
    const node =
      albums.find(
        (n) => lc(n.title) === lc(run.album) && (!run.artist || lc(n.artist) === lc(run.artist)),
      ) ?? albums.find((n) => lc(n.title) === lc(run.album));
    if (!node) return { reason: `"${run.album}" is not in any library index.` };
    const pool = groups.find((p) => p.udn === node.serverUdn);
    const tracks = (pool ? albumTracksOf(node, pool) : []).sort(
      (x, y) => (trackPosition(x) ?? 0) - (trackPosition(y) ?? 0),
    );
    const target = resumeTarget(run, tracks);
    if (!target) return { reason: `"${run.album}" was played to the end.` };
    return { run, node, target, position: tracks.indexOf(target) + 1, total: tracks.length };
  }

  private connected(): ConnectedSnapshot {
    const snap = this.dm.snapshot();
    if (snap.connection.phase !== "connected") {
      throw new Error(
        "Not connected to a streamer. Use list_devices and connect_device, or open TastyTunes to connect.",
      );
    }
    return snap as ConnectedSnapshot;
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
      return "No library index is ready yet, and the streamer is not connected (the server list comes from it) — connect, or the user can build one in Settings › Libraries.";
    }
    const host = snap.connection.host;
    void refreshServers(host)
      .then((servers) => indexEnsureFresh(host, servers))
      .catch(() => {});
    return "No library index is ready yet — a build has been started (searchable servers index themselves in seconds; a Browse-only server needs rebuild_library_index). Ask again in a moment, or check list_media_servers.";
  }

  /** Every tool's implementation, from the six tool modules under ./mcp (the
   *  split of 2026-09-13); the shapes and helpers they share are the toolkit's. */
  private toolImpls(): Record<string, ToolImpl> {
    const ctx: ToolContext = {
      dm: this.dm,
      connected: () => this.connected(),
      kickIndex: () => this.kickIndex(),
      resumeOffer: () => this.resumeOffer(),
      mutateSchedules: (fn) => this.mutateSchedules(fn),
      saveSettings: (patch) => {
        const next = updateSettings(patch);
        this.onSettingsMutated?.(next);
        return next;
      },
      sendCommand: (command) => this.sendCommand?.(command),
      displayModeOn: () => this.displayModeOn,
    };
    return {
      ...deviceTools(ctx),
      ...libraryTools(ctx),
      ...historyTools(ctx),
      ...collectionTools(ctx),
      ...audioTools(ctx),
      ...editTools(ctx),
      ...sceneTools(ctx),
    };
  }

  /** Persist a schedules change and tell the renderer (settings push). */
  private mutateSchedules(fn: (list: Schedule[]) => Schedule[]): void {
    const next = updateSettings({ schedules: fn(getSettings().schedules) });
    this.onSettingsMutated?.(next);
  }
}
