// The SMOIP WebSocket client: one persistent connection to ws://<host>:80/smoip.
//
// State flows in by subscribing to paths with {"params": {"update": 1}}; commands go
// out over the same socket as {"path": ..., "params": ...}. Reconnects use capped
// exponential backoff, and liveness is watched with ws ping/pong (the streamer also
// pings us; tokio-tungstenite/ws auto-pong on both ends).

import WebSocket from "ws";
import type { SmoipFrame } from "@shared/smoip";

const SUBSCRIBED_PATHS = [
  "/presets/list",
  "/queue/info",
  "/system/info",
  "/system/power",
  // Firmware self-check status the streamer PUSHES to subscribers. Subscribing
  // is READ-ONLY — TastyTunes only ever sends this path with {update:1} and
  // never with an `action` param (see the PASSIVE-ONLY guard in deviceManager).
  "/system/update",
  "/system/sources",
  // Front-panel brightness — pushed on change (e.g. from the web admin);
  // headless models simply never answer (gated on /system/display/spec).
  "/system/display",
  // Tone/EQ chain — per-model; a streamer without it simply never answers
  // (feature detection runs off /zone/audio/spec, probed over HTTP at connect).
  "/zone/audio",
  "/zone/now_playing",
  "/zone/play_state",
  "/zone/play_state/position",
  "/zone/state",
];

const CONNECT_TIMEOUT_MS = 4000;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 5000;

export interface SmoipSocketEvents {
  onFrame(frame: SmoipFrame): void;
  onOutgoing(frame: SmoipFrame): void;
  onConnecting(attempt: number): void;
  onConnected(): void;
  onDisconnected(reason: string, reconnecting: boolean): void;
  onLog(level: "info" | "warn" | "error", text: string): void;
}

export class SmoipSocket {
  readonly host: string;
  private events: SmoipSocketEvents;
  private ws: WebSocket | null = null;
  private closedIntentionally = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;

  constructor(host: string, events: SmoipSocketEvents) {
    this.host = host;
    this.events = events;
  }

  connect(): void {
    if (this.closedIntentionally) return;
    this.attempt += 1;
    this.events.onConnecting(this.attempt);

    // Plain host → SMOIP's standard port 80; "host:port" respected (proxies, testing).
    const authority = this.host.includes(":") ? this.host : `${this.host}:80`;
    const url = `ws://${authority}/smoip`;
    const ws = new WebSocket(url, {
      headers: { Origin: "tastytunes" },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.events.onLog("info", `connected to ${url}`);
      this.events.onConnected();
      for (const path of SUBSCRIBED_PATHS) {
        this.send(path, { update: 1 });
      }
      // One-shot state request; also re-sent whenever /queue/info announces a change.
      this.send("/queue/list");
      this.startKeepalive();
    });

    ws.on("message", (raw) => {
      let frame: SmoipFrame;
      try {
        // the wire's shape is the streamer's; readers guard each field they use
        frame = JSON.parse(raw.toString()) as SmoipFrame;
      } catch {
        this.events.onLog("warn", `unparseable frame: ${raw.toString().slice(0, 200)}`);
        return;
      }
      if (frame.path === "/queue/info" && !this.suppressQueueRefetch) {
        // The queue changed — fetch the full list.
        this.send("/queue/list");
      }
      this.events.onFrame(frame);
    });

    ws.on("pong", () => this.clearPongTimer());

    ws.on("error", (err) => {
      this.events.onLog("error", `websocket error: ${err.message}`);
    });

    ws.on("close", (code, reasonBuf) => {
      this.stopKeepalive();
      this.ws = null;
      const reason = reasonBuf?.toString() || `closed (code ${code})`;
      if (this.closedIntentionally) {
        this.events.onDisconnected("disconnected", false);
        return;
      }
      this.events.onDisconnected(reason, true);
      this.scheduleReconnect();
    });
  }

  /** True when frames can actually reach the device right now. */
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Send a SMOIP frame; silently dropped when the socket isn't open. */
  send(path: string, params?: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.events.onLog("warn", `dropped ${path} — socket not open`);
      return;
    }
    const frame: SmoipFrame = params === undefined ? { path } : { path, params };
    this.ws.send(JSON.stringify(frame));
    this.events.onOutgoing(frame);
  }

  /**
   * Actively verify the socket (used after sleep/focus). A dead socket is
   * terminated, which triggers the normal reconnect path.
   */
  async healthCheck(): Promise<boolean> {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    const alive = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        ws.removeListener("pong", onPong);
        resolve(false);
      }, 1500);
      const onPong = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      ws.once("pong", onPong);
      try {
        ws.ping("TASTYTUNES");
      } catch {
        clearTimeout(timer);
        ws.removeListener("pong", onPong);
        resolve(false);
      }
    });
    if (!alive && this.ws === ws) {
      this.events.onLog("warn", "health check failed — recycling connection");
      ws.terminate();
    }
    return alive;
  }

  close(): void {
    this.closedIntentionally = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopKeepalive();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
        // If close doesn't complete promptly, force it.
        setTimeout(() => ws.terminate(), 1000);
      } catch {
        ws.terminate();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closedIntentionally) return;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** Math.min(this.attempt, 6),
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * Set during a BULK queue write (playlist activation). Queue entries can only
   * be added one at a time, and each add pushes /queue/info — which would
   * otherwise refetch the whole list N times for an N-track playlist. The batch
   * fetches once at the end instead.
   */
  public suppressQueueRefetch = false;

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      const ws = this.ws;
      if (ws?.readyState !== WebSocket.OPEN) return;
      this.pongTimer = setTimeout(() => {
        this.events.onLog("warn", "keepalive pong missed — recycling connection");
        ws.terminate();
      }, PONG_TIMEOUT_MS);
      try {
        ws.ping();
      } catch {
        // terminate via pong timeout
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }
}
