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
import { timingSafeEqual } from "node:crypto";
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
import { playlistFullSentence, resumeRun, resumeTarget } from "@shared/model";
import { playStatsFromRecord } from "../data/playStats";
import {
  MCP_CLUSTERS,
  mcpClusterEnabled,
  type McpClusterInfo,
  type McpToolInfo,
} from "@shared/mcpCatalog";
import { app } from "electron";
import type { MenuCommand } from "@shared/ipc";
import type { DeviceManager } from "../device/deviceManager";
import { ensureMcpToken, getSettings, updateSettings } from "../data/persist";
import { getSecret } from "../data/secrets";

import { refreshServers } from "../media/upnpBrowser";
import { pools as indexPools, ensureFresh as indexEnsureFresh } from "../media/mediaIndex";
import {
  type ConnectedSnapshot,
  type ResumeOffer,
  type ToolContext,
  type ToolImpl,
  type Target,
  err,
  streamerHostOf,
  strictInput,
} from "./mcp/toolkit";
import { remoteStreamers } from "../device/remoteStreamer";
import { deviceTools } from "./mcp/deviceTools";
import { libraryTools } from "./mcp/libraryTools";
import { historyTools } from "./mcp/historyTools";
import { collectionTools } from "./mcp/collectionTools";
import { audioTools } from "./mcp/audioTools";
import { editTools } from "./mcp/editTools";
import { sceneTools } from "./mcp/sceneTools";
import { exportTools } from "./mcp/exportTools";
import { mediaType, nameKey } from "@shared/keys";
import { acceptBothForSdk } from "./mcp/accept";
import { hostAllowed } from "./hostCheck";

/**
 * The address another computer on the local network reaches: a private IPv4 on a physical
 * interface first (0.16.0: the first external address found could be a VPN's, and the setup line
 * Settings showed then reached nothing).
 */
export function lanAddress(): string | null {
  const vpn = /^(utun|tun|tap|ppp|wg|ipsec|zt|tailscale|gpd)/i;
  const privateRange = (ip: string): boolean =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const found: { name: string; address: string }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces()))
    for (const a of addrs ?? [])
      if (a.family === "IPv4" && !a.internal) found.push({ name, address: a.address });
  const rank = (c: { name: string; address: string }): number =>
    (vpn.test(c.name) ? 2 : 0) + (privateRange(c.address) ? 0 : 1);
  return found.sort((x, y) => rank(x) - rank(y))[0]?.address ?? null;
}

/**
 * WHAT A CLIENT SHOWS THE MODEL ONCE (0.16.0, the server's instructions): how to begin, how
 * library items are addressed, why genres alone won't do, and what is off until the user says.
 */
const INSTRUCTIONS = [
  "TastyTunes controls a Cambridge Audio StreamMagic streamer and knows the user's local music library, listening history, playlists, favorites and presets.",
  "Call get_status first: it gives the local time and today's date, what is playing, and which tool groups are off.",
  "Library items are addressed by server_udn and object_id, from search_library, list_albums or list_tracks; a tool that takes tracks takes those ids, or a title with an artist and album.",
  "To find music by style or era, read library_facets and list_artists and use what you know about the artists, because genre tags are often missing.",
  "Dynamic range, loudness, tempo and key exist only for analyzed tracks, and answers that use them say how many were measured.",
  "Don't replace the queue unless the user asks.",
  "A tool that takes device acts on that streamer, by its name from list_devices, without moving the TastyTunes window; a tool that doesn't acts on the window's streamer, and connect_device is the one tool that moves the window.",
  "The history tools take local days (YYYY-MM-DD) or a named period.",
  "Some editing tools are off until the user turns them on in Settings › Integrations, and an agent that was already connected may need to reconnect to TastyTunes before they appear.",
].join(" ");

/** A JSON-RPC request is a few kilobytes; a megabyte is room for any of them. */
const MAX_BODY_BYTES = 1_000_000;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** A page served from this machine (an MCP inspector on localhost, say). */
function loopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}
/** A connection from this machine. */
function loopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return a === "::1" || a.startsWith("127.");
}
/** The Authorization header against the token, in constant time. */
function tokenMatches(header: string | undefined, token: string): boolean {
  if (!token || !header) return false;
  const want = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}

/** A tool's MCP annotations from the catalog (its own hints, its cluster's read-only flag): every
 *  hint said outright, since a client assumes a tool may destroy and reach the world unless told. */
function annotationsOf(
  cluster: McpClusterInfo,
  tool: McpToolInfo,
): {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
} {
  const readOnly = cluster.readOnly === true || tool.hints?.readOnly === true;
  return {
    readOnlyHint: readOnly,
    ...(readOnly
      ? {}
      : {
          destructiveHint: tool.hints?.destructive === true,
          idempotentHint: tool.hints?.idempotent === true,
        }),
    openWorldHint: tool.hints?.openWorld === true,
  };
}

export class McpBridge {
  private http: Server | null = null;
  private active: { bind: McpSettings["bind"]; port: number } | null = null;
  /** The token's mint, which a request from the network waits for before it is checked. */
  private tokenReady: Promise<void> = Promise.resolve();
  /** Fired when an MCP tool mutates settings (schedules) — the renderer
   *  learns via a {kind:'settings'} push; index.ts wires this to the window. */
  onSettingsMutated: ((next: AppSettings) => void) | null = null;
  /** A menu command to the main window (set_display_mode); index.ts wires this to
   *  sendMenuCommand, which raises the window if there is none. */
  sendCommand: ((command: MenuCommand) => void) | null = null;
  /** Whether the main window exists; index.ts wires it to app/windows. */
  windowOpen: (() => boolean) | null = null;
  /** Display mode as the renderer last reported it (store.setDisplayMode → IPC.displayModeReport):
   *  renderer state main would not otherwise know. */
  private displayModeOn = false;

  /** The agent's connections to streamers the window isn't showing (0.16.0), the one pool. */
  private readonly remotes = remoteStreamers;

  constructor(private dm: DeviceManager) {
    remoteStreamers.log = (text) => this.dm.log("info", "agents", text);
  }

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
      // the server off, no agent is left to use a background connection
      this.remotes.closeAll();
      this.dm.setMcpStatus({ running: false, url: null, error: null }, "stopped");
    }
  }

  private start(mcp: McpSettings): void {
    // the token is minted the first time the server runs, never for an install that never does
    this.tokenReady = ensureMcpToken().catch(() => {});
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
    // (On the network bind the token is the guard: a rebinding page holds none.)
    if (bind === "localhost" && !hostAllowed(req.headers.host, "loopback")) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden host" }));
      return;
    }
    // THE REQUEST CHECKS (0.10.0, the whole-app review). A web page can POST to this port
    // without a preflight (a text/plain body naming application/json passed the SDK's own
    // test), so a request that carries a browser's Origin is refused unless the page is on
    // this machine; the body must be JSON by its exact type and no larger than a request
    // needs; and while the server is reachable from the network, a request from another
    // machine must carry the token from Settings › Integrations (one from this machine is
    // held to the checks above, as on the localhost bind).
    const reject = (status: number, message: string, extra: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
    };
    const origin = req.headers.origin;
    if (origin && !loopbackOrigin(origin)) {
      reject(403, "Requests from web pages are refused.");
      return;
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

    const type = mediaType(req.headers["content-type"]);
    if (type !== "application/json") {
      reject(415, "The body must be application/json.");
      return;
    }
    if (bind === "lan" && !loopbackAddress(req.socket.remoteAddress)) {
      await this.tokenReady;
      if (!tokenMatches(req.headers.authorization, (await getSecret("mcpToken")) ?? "")) {
        reject(401, "This server needs its token: Authorization: Bearer <token>.", {
          "www-authenticate": 'Bearer realm="tastytunes"',
        });
        return;
      }
    }

    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) {
          reject(413, "The request is too large.");
          req.destroy();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

      // a client that sends no Accept, or */* (Home Assistant's rest_command, curl), is served
      // like one that lists both types; the transport alone would refuse it with a 406
      acceptBothForSdk(req);
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
    const server = new McpServer(
      { name: "tastytunes", version: app.getVersion() },
      { instructions: INSTRUCTIONS },
    );
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
            inputSchema: strictInput(tool.name, impl.inputSchema),
            annotations: annotationsOf(cluster, tool),
          },
          (async (args: Record<string, unknown>) => {
            try {
              return await impl.handler(args ?? {});
            } catch (e) {
              // a refusal at a playlist bound says its own sentence, never its IPC token
              return err(playlistFullSentence(e) ?? (e as Error).message);
            }
          }) as never,
        );
      }
    }
    // a fresh server per request can never tell a client its list changed: say so (0.16.0; the SDK
    // claims listChanged as soon as a tool is registered)
    server.server.registerCapabilities({ tools: { listChanged: false } });
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
    const groups = indexPools();
    const albums = groups.flatMap((p) => p.albums);
    const node =
      albums.find(
        (n) =>
          nameKey(n.title) === nameKey(run.album) &&
          (!run.artist || nameKey(n.artist) === nameKey(run.artist)),
      ) ?? albums.find((n) => nameKey(n.title) === nameKey(run.album));
    if (!node) return { reason: `"${run.album}" is not in any library index.` };
    const pool = groups.find((p) => p.udn === node.serverUdn);
    const tracks = (pool ? albumTracksOf(node, pool) : []).sort(
      (x, y) => (trackPosition(x) ?? 0) - (trackPosition(y) ?? 0),
    );
    const target = resumeTarget(run, tracks);
    if (!target) return { reason: `"${run.album}" was played to the end.` };
    return { run, node, target, position: tracks.indexOf(target) + 1, total: tracks.length };
  }

  /** The streamer a call acts on (ToolContext.target): by device, on this network only
   *  (mcp/toolkit streamerHostOf). */
  private async target(device?: string): Promise<Target> {
    const snap = this.dm.snapshot();
    const windowHost = snap.connection.phase === "connected" ? snap.connection.host : null;
    let host: string | null = null;
    if (device != null) {
      const named = streamerHostOf(device, [...snap.devices, ...getSettings().knownDevices]);
      if ("error" in named) throw new Error(named.error);
      host = named.host;
    }
    if (host == null || host === windowHost) {
      // the window's streamer: an agent's own connection to it, if it had one, gives way, and a
      // sleep timer armed there goes over to the window's connection unless it has its own
      if (host != null) {
        const sleep = this.remotes.drop(host);
        if (sleep && this.dm.snapshot().sleep == null) this.dm.setSleep(sleep);
      }
      const s = this.connected();
      return {
        window: true,
        host: s.connection.host,
        name: s.systemInfo?.name ?? s.connection.host,
        snapshot: () => this.connected(),
        command: (cmd) => this.dm.command(cmd),
        queueAdd: (udn, id, action, from, opts) => this.dm.queueAdd(udn, id, action, from, opts),
        queueTracks: (items, mode) => this.dm.queueTracks(items, mode),
        ensureAwake: () => this.dm.ensureAwake(),
        setSleep: (sleep) => this.dm.setSleep(sleep),
      };
    }
    const remote = this.remotes.get(host);
    if (!(await remote.ready())) {
      this.remotes.forget(host);
      throw new Error(
        `Couldn't reach ${device} at ${host}. It may be off the network, or asleep in eco standby.`,
      );
    }
    const snapshotOf = (): ConnectedSnapshot => ({
      ...this.dm.snapshot(),
      connection: { phase: "connected", host },
      ...remote.cache,
      sleep: remote.sleeper.current,
      lastRecalledPresetId: null,
      held: null,
      playlistActivation: remote.queueOps.activation,
    });
    return {
      window: false,
      host,
      name: remote.name,
      snapshot: snapshotOf,
      command: (cmd) => remote.command(cmd),
      queueAdd: (udn, id, action, from, opts) => remote.queueAdd(udn, id, action, from, opts),
      queueTracks: (items, mode) => remote.queueOps.queueTracks(items, mode),
      ensureAwake: () => remote.ensureAwake(),
      setSleep: (sleep) => remote.setSleep(sleep),
    };
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
      target: (device) => this.target(device),
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
      windowOpen: () => this.windowOpen?.() ?? false,
    };
    return {
      ...deviceTools(ctx),
      ...libraryTools(ctx),
      ...historyTools(ctx),
      ...collectionTools(ctx),
      ...audioTools(ctx),
      ...editTools(ctx),
      ...sceneTools(ctx),
      ...exportTools(ctx),
    };
  }

  /** Persist a schedules change and tell the renderer (settings push). */
  private mutateSchedules(fn: (list: Schedule[]) => Schedule[]): void {
    const next = updateSettings({ schedules: fn(getSettings().schedules) });
    this.onSettingsMutated?.(next);
  }
}
