import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { PushMessage, Snapshot } from "@shared/ipc";
import type { LyricsQuery, LyricsResult } from "@shared/model";
import { artIdOf, displayPush, displaySnapshot } from "./displayFeed";

/**
 * DISPLAY ON OTHER SCREENS (0.17.0): while its switch is on, the app serves its Display mode to any
 * browser on the local network, on its own port, for a tablet or a TV's browser beside the hi-fi.
 * Display only: GET and the live channel, nothing that changes anything.
 *
 * - A TOKEN in the address (the one Settings shows, and its QR code): the first visit presents it
 *   as ?t=, the server answers with a cookie and sends the browser to the bare address, so the
 *   token never sits in the address bar, a referrer or a picture's request again. Without it,
 *   nothing but a page saying where to find the address.
 * - The page's data is the reduced feed (displayFeed): the playing track, its state, the display
 *   settings; pictures by the id the feed handed out, never by address.
 * - The page is the app's own Display tree (one home), built as a second entry of the renderer
 *   (display.html), with a web bridge in place of the window's API.
 */

export interface DisplayDeps {
  snapshot(): Snapshot;
  lyrics(query: LyricsQuery): Promise<LyricsResult | null | "unreachable">;
  lyricsAllowed(): boolean;
  picture(url: string): Promise<{ bytes: Buffer; type: string } | null>;
  token(): Promise<string>;
  /** The built renderer (out/renderer): display.html and its assets. */
  pageDir: string;
  log(text: string): void;
}

const COOKIE = "tt_display";
const MAX_ART_IDS = 200;
const PING_MS = 25_000;
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};
const NO_ADDRESS = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TastyTunes</title><body style="font:16px system-ui;background:#111;color:#ddd;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><p>Open the address shown in TastyTunes, in Settings › Integrations › Display on other screens.</p></body>`;

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function cookieOf(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export class DisplayServer {
  private http: Server | null = null;
  private readonly clients = new Set<ServerResponse>();
  private readonly artIds = new Map<string, string>();
  private ping: ReturnType<typeof setInterval> | null = null;
  private listening: { port: number; host: string } | null = null;

  constructor(private readonly deps: DisplayDeps) {}

  get running(): boolean {
    return this.listening != null;
  }

  get port(): number | null {
    return this.listening?.port ?? null;
  }

  /** Starts on `port` (0 for any) at `host`; resolves once listening, rejects on a port in use. */
  start(port: number, host = "0.0.0.0"): Promise<void> {
    if (this.http) return Promise.resolve();
    const server = createServer((req, res) => void this.handle(req, res));
    this.http = server;
    return new Promise((resolve, reject) => {
      server.once("error", (e) => {
        this.http = null;
        reject(e);
      });
      server.listen(port, host, () => {
        const a = server.address();
        this.listening = { port: typeof a === "object" && a ? a.port : port, host };
        this.ping = setInterval(() => {
          for (const c of this.clients) c.write(": ping\n\n");
        }, PING_MS);
        this.deps.log(`Display on other screens is on, port ${this.listening.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.http?.closeAllConnections();
    this.http?.close();
    this.http = null;
    if (this.listening) this.deps.log("Display on other screens is off");
    this.listening = null;
  }

  /** What the streamer reports reaches every open page, reduced. */
  push(msg: PushMessage): void {
    if (this.clients.size === 0) return;
    const out = displayPush(msg, this.art);
    if (!out) return;
    const line = `data: ${JSON.stringify(out)}\n\n`;
    for (const c of this.clients) c.write(line);
  }

  /** A picture's page address: the id is noted so /art/<id> can serve it, the address never. */
  private readonly art = (url: string): string => {
    const id = artIdOf(url);
    this.artIds.delete(id);
    this.artIds.set(id, url);
    while (this.artIds.size > MAX_ART_IDS) this.artIds.delete(this.artIds.keys().next().value!);
    return `/art/${id}`;
  };

  private base(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
    res.writeHead(status, {
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
      ...headers,
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        this.base(res, 405, { allow: "GET, HEAD" });
        return void res.end();
      }
      const url = new URL(req.url ?? "/", "http://display.local");
      const token = await this.deps.token();
      const given = url.searchParams.get("t");
      // the first visit: the token from the address becomes a cookie, and the address loses it
      if (given != null) {
        if (!sameToken(given, token)) {
          this.base(res, 401, { "content-type": "text/html; charset=utf-8" });
          return void res.end(NO_ADDRESS);
        }
        this.base(res, 303, {
          location: "/",
          "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
        });
        return void res.end();
      }
      if (!sameToken(cookieOf(req, COOKIE) ?? "", token)) {
        this.base(res, 401, { "content-type": "text/html; charset=utf-8" });
        return void res.end(NO_ADDRESS);
      }
      const path = url.pathname;
      if (path === "/" || path === "/index.html")
        return this.file(res, "display.html", { "content-security-policy": PAGE_CSP });
      if (path === "/api/snapshot")
        return this.json(res, displaySnapshot(this.deps.snapshot(), this.art));
      if (path === "/api/live") return this.live(req, res);
      if (path === "/api/lyrics") return this.lyrics(res, url);
      const art = /^\/art\/([0-9a-f]{24})$/.exec(path);
      if (art) return this.picture(res, art[1]);
      if (path.startsWith("/assets/") || path === "/display-guard.js")
        return this.file(res, path.slice(1), {
          "cache-control": "public, max-age=31536000, immutable",
        });
      this.base(res, 404);
      res.end();
    } catch (e) {
      this.deps.log(`a page's request failed: ${(e as Error).message}`);
      if (!res.headersSent) this.base(res, 500);
      res.end();
    }
  }

  private json(res: ServerResponse, body: unknown): void {
    this.base(res, 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private live(req: IncomingMessage, res: ServerResponse): void {
    this.base(res, 200, { "content-type": "text/event-stream", connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  private async lyrics(res: ServerResponse, url: URL): Promise<void> {
    if (!this.deps.lyricsAllowed()) return this.json(res, null);
    const p = url.searchParams;
    const duration = Number(p.get("duration"));
    const query: LyricsQuery = {
      artist: p.get("artist") ?? "",
      title: p.get("title") ?? "",
      album: p.get("album") || null,
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
    if (!query.artist || !query.title) return this.json(res, null);
    this.json(res, await this.deps.lyrics(query));
  }

  private async picture(res: ServerResponse, id: string): Promise<void> {
    const url = this.artIds.get(id);
    const got = url ? await this.deps.picture(url) : null;
    if (!got) {
      this.base(res, 404);
      return void res.end();
    }
    this.base(res, 200, { "content-type": got.type, "cache-control": "private, max-age=86400" });
    res.end(got.bytes);
  }

  /** A file from the built page, never outside it. */
  private file(res: ServerResponse, rel: string, headers: Record<string, string>): void {
    const root = normalize(this.deps.pageDir);
    const full = normalize(join(root, rel));
    if (!full.startsWith(root + sep) || !existsSync(full) || !statSync(full).isFile()) {
      this.base(res, 404);
      return void res.end();
    }
    this.base(res, 200, {
      "content-type": TYPES[extname(full)] ?? "application/octet-stream",
      ...headers,
    });
    createReadStream(full).pipe(res);
  }
}
