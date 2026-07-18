// SMOIP WebSocket client for browser runtimes (WKWebView / dev harness).
//
// The desktop app's src/main/smoipSocket.ts is the reference implementation
// (ws:// with an explicit Origin header via the `ws` package). Here the
// platform WebSocket is used instead: WKWebView stamps
// `Origin: capacitor://localhost` automatically, which the Evo accepts —
// live-verified 2026-07-18; the firmware requires Origin PRESENCE, any value.
//
// Reconnect/backoff and the subscribe set mirror smoipSocket.ts. Keepalive
// pings are TODO(port): browser WebSocket has no ping frames — needs either
// an application-level probe or reliance on WKWebView socket timeouts.

export interface SmoipFrame {
  path?: string
  params?: { data?: unknown; update?: number } & Record<string, unknown>
  message?: unknown
}

const SUBSCRIBED_PATHS = [
  '/presets/list',
  '/queue/info',
  '/system/info',
  '/system/power',
  '/system/sources',
  '/zone/now_playing',
  '/zone/play_state',
  '/zone/play_state/position',
  '/zone/state'
]

const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 8000

export interface SmoipClientEvents {
  onFrame(frame: SmoipFrame): void
  onConnecting(attempt: number): void
  onConnected(): void
  onDisconnected(reason: string, reconnecting: boolean): void
}

export class SmoipClient {
  readonly host: string
  private events: SmoipClientEvents
  private ws: WebSocket | null = null
  private closed = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(host: string, events: SmoipClientEvents) {
    this.host = host
    this.events = events
  }

  connect(): void {
    if (this.closed) return
    this.attempt += 1
    this.events.onConnecting(this.attempt)
    const ws = new WebSocket(`ws://${this.host}/smoip`)
    this.ws = ws

    ws.onopen = (): void => {
      if (this.ws !== ws) return
      this.attempt = 0
      this.events.onConnected()
      for (const path of SUBSCRIBED_PATHS) {
        ws.send(JSON.stringify({ path, params: { update: 1 } }))
      }
      // One-shot list fetch; re-sent whenever /queue/info announces a change
      // (mirrors smoipSocket.ts — /queue/info is the change SIGNAL, /queue/list
      // carries the data).
      this.request('/queue/list')
    }
    ws.onmessage = (ev: MessageEvent): void => {
      if (this.ws !== ws) return
      let frame: SmoipFrame
      try {
        frame = JSON.parse(String(ev.data)) as SmoipFrame
      } catch {
        return // non-JSON frames are ignored, same as the desktop client
      }
      if (frame.path === '/queue/info') this.request('/queue/list')
      this.events.onFrame(frame)
    }
    ws.onclose = (ev: CloseEvent): void => {
      if (this.ws !== ws) return
      this.ws = null
      const reconnecting = !this.closed
      this.events.onDisconnected(ev.reason || `closed (${ev.code})`, reconnecting)
      if (reconnecting) this.scheduleReconnect()
    }
    ws.onerror = (): void => {
      // close always follows; reconnect is scheduled there
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.attempt)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  send(path: string, params: Record<string, unknown>): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ path, params }))
  }

  /** Bare request (no update flag): used to refetch lists on demand. */
  request(path: string): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ path }))
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }
}
