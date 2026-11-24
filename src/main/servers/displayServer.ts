import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { PushMessage, Snapshot } from "@shared/ipc";
import {
  audioAnalysisKey,
  type AudioAnalysis,
  type LyricsQuery,
  type LyricsResult,
  type MediaInfoQuery,
  type MediaInfoTarget,
  type MediaNode,
} from "@shared/model";
import { artIdOf, displayPush, displaySnapshot } from "./displayFeed";
import { hostAllowed } from "./hostCheck";

/**
 * DISPLAY ON OTHER SCREENS (0.17.0): while its switch is on, the app serves its Display mode to any
 * browser on the local network, on its own port, for a tablet or another computer beside the
 * hi-fi. Display only: GET and the live channel, nothing that changes anything.
 *
 * - A TOKEN in the address (the one Settings shows): the first visit presents it as ?t=, the
 *   server answers with a cookie and sends the browser to the bare address, so the token never
 *   sits in the address bar, a referrer or a picture's request again. Without it, nothing but a
 *   page saying where to find the address. A new token ends every open screen at once
 *   (closeScreens), and their reconnect meets that page.
 * - The page's data is the reduced feed (displayFeed): the playing track, its state, the display
 *   settings; pictures by the id the feed handed out, never by address.
 * - THE LIVE CHANNEL IS WHOLE ON ITS OWN: every connection opens with the reduced snapshot, so a
 *   reconnect after a wake or a restart never shows the old track, and a ping every few seconds
 *   lets the page tell a quiet app from a lost one.
 * - Lyrics only for the track that is playing: the page can't make the app look anything up.
 * - THE SCENES' ANALYSIS, FINISHED (stage 2): the page asks which library file is playing (the
 *   window's own question, answered only for the playing track, with the file's ids left out)
 *   and then that file's stored analysis, by a key this server handed out; it never measures
 *   anything, so a track the app hasn't analyzed shows the Sleeve's face, as in the window.
 * - The page is the app's own Display tree (one home), built as a second entry of the renderer
 *   (display.html), with a web bridge in place of the window's API.
 */

export interface DisplayDeps {
  snapshot(): Snapshot;
  lyrics(query: LyricsQuery): Promise<LyricsResult | null | "unreachable">;
  lyricsAllowed(): boolean;
  picture(url: string): Promise<{ bytes: Buffer; type: string } | null>;
  /** The library file a query names, as the window's Info finds it (a show: no index rebuilt). */
  trackInfo(query: MediaInfoQuery): Promise<MediaInfoTarget | null>;
  /** A stored analysis by its content key. */
  analysis(contentKey: string): AudioAnalysis | null;
  token(): Promise<string>;
  /** The built renderer (out/renderer): display.html and its assets. */
  pageDir: string;
  log(text: string): void;
  /** The server stopped on its own (an error after it was listening). */
  failed?(message: string): void;
}

const COOKIE = "tt_display";
const MAX_ART_IDS = 200;
/** The analysis keys handed out with the playing file, kept for its next few asks. */
const MAX_TRACK_KEYS = 20;
/** A ping this often; the page counts the app lost after a few missed (display/live). */
export const PING_MS = 5_000;
/** Screens at once; more is someone else's loop, not a household. */
const MAX_SCREENS = 16;
/** A screen whose unread pushes pass this has stopped reading: it is let go. */
const MAX_UNREAD_BYTES = 1 << 20;
/** The last few pictures, kept so a page's reload or a second screen doesn't fetch them again. */
const KEPT_PICTURES = 6;
const KEPT_PICTURE_BYTES = 24 * 1024 * 1024;
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
/** A picture is only ever a picture: opened as a page, an SVG's script can't run. */
const PICTURE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
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

/** A cookie's value; a malformed one reads as none. */
function cookieOf(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

function urlOf(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "/", "http://display.local");
  } catch {
    return null;
  }
}

/** The asked track is the one playing: its title and artist as the page derives them (either
 *  play_state's or now_playing's lines, a station's on the radio), its album and length if asked. */
export function asksForPlaying(q: LyricsQuery, snap: Snapshot): boolean {
  const md = snap.playState?.metadata;
  const d = snap.nowPlaying?.display;
  const is = (v: string | null | undefined, ...of: Array<string | null | undefined>): boolean =>
    v != null && v !== "" && of.some((o) => o === v);
  return (
    is(q.title, md?.title, md?.station, d?.line1) &&
    is(q.artist, md?.artist, md?.title, d?.line2) &&
    (q.album == null || is(q.album, md?.album, d?.line3)) &&
    (q.duration == null || q.duration === md?.duration)
  );
}

export class DisplayServer {
  private http: Server | null = null;
  private readonly clients = new Set<ServerResponse>();
  private readonly artIds = new Map<string, string>();
  private readonly trackKeys = new Set<string>();
  private readonly kept = new Map<string, { bytes: Buffer; type: string }>();
  private readonly fetching = new Map<string, Promise<{ bytes: Buffer; type: string } | null>>();
  private ping: ReturnType<typeof setInterval> | null = null;
  private listening: { port: number; host: string } | null = null;

  constructor(private readonly deps: DisplayDeps) {}

  get running(): boolean {
    return this.listening != null;
  }

  get port(): number | null {
    return this.listening?.port ?? null;
  }

  get screens(): number {
    return this.clients.size;
  }

  /** Starts on `port` (0 for any) at `host`; resolves once listening, rejects on a port in use. */
  start(port: number, host = "0.0.0.0"): Promise<void> {
    if (this.http) return Promise.resolve();
    const server = createServer((req, res) => void this.handle(req, res));
    server.maxConnections = 64;
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    this.http = server;
    return new Promise((resolve, reject) => {
      const early = (e: Error): void => {
        if (this.http === server) this.http = null;
        reject(e);
      };
      server.once("error", early);
      server.listen(port, host, () => {
        server.off("error", early);
        // an error once listening stops the server, so its switch can still start it again
        server.on("error", (e) => {
          if (this.http !== server) return;
          this.deps.log(`Display on other screens stopped: ${e.message}`);
          this.stop();
          this.deps.failed?.(e.message);
        });
        const a = server.address();
        this.listening = { port: typeof a === "object" && a ? a.port : port, host };
        this.ping = setInterval(() => this.send("event: ping\ndata: 1\n\n"), PING_MS);
        this.deps.log(`Display on other screens is on, port ${this.listening.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.closeScreens();
    this.http?.close();
    this.http = null;
    if (this.listening) this.deps.log("Display on other screens is off");
    this.listening = null;
    this.kept.clear();
  }

  /** Every open screen let go, the server still listening: after a new address, each screen's
   *  reconnect meets the "open the address" page. */
  closeScreens(): void {
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.http?.closeAllConnections();
  }

  /** What the streamer reports reaches every open page, reduced. */
  push(msg: PushMessage): void {
    if (this.clients.size === 0) return;
    const out = displayPush(msg, this.art);
    if (out) this.send(`data: ${JSON.stringify(out)}\n\n`);
  }

  private send(line: string): void {
    for (const c of this.clients) {
      if (c.writableLength > MAX_UNREAD_BYTES) {
        this.clients.delete(c);
        c.destroy();
        continue;
      }
      c.write(line);
    }
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

  private refuse(res: ServerResponse, status: number, body = ""): void {
    this.base(res, status, body ? { "content-type": "text/html; charset=utf-8" } : {});
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // nothing a request without the token sends reaches the log (each line is a push to every
    // window and a file append): only a request let in can fail out loud
    let admitted = false;
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        this.base(res, 405, { allow: "GET, HEAD" });
        return void res.end();
      }
      const url = urlOf(req);
      if (!url || !hostAllowed(req.headers.host, "network")) return this.refuse(res, 400);
      const token = await this.deps.token();
      const given = url.searchParams.get("t");
      // the first visit: the token from the address becomes a cookie, and the address loses it
      if (given != null) {
        if (!sameToken(given, token)) return this.refuse(res, 401, NO_ADDRESS);
        this.base(res, 303, {
          location: "/",
          "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
        });
        return void res.end();
      }
      if (!sameToken(cookieOf(req, COOKIE) ?? "", token)) return this.refuse(res, 401, NO_ADDRESS);
      admitted = true;
      const path = url.pathname;
      if (path === "/" || path === "/index.html")
        return this.file(res, "display.html", { "content-security-policy": PAGE_CSP });
      if (path === "/api/snapshot")
        return this.json(res, displaySnapshot(this.deps.snapshot(), this.art));
      if (path === "/api/live") return this.live(req, res);
      if (path === "/api/lyrics") return await this.lyrics(res, url);
      if (path === "/api/track") return await this.track(res, url);
      if (path === "/api/analysis") return this.storedAnalysis(res, url);
      const art = /^\/art\/([0-9a-f]{24})$/.exec(path);
      if (art) return await this.picture(res, art[1]);
      if (path.startsWith("/assets/"))
        return this.file(res, path.slice(1), {
          "cache-control": "public, max-age=31536000, immutable",
        });
      // its name carries no hash, so a browser asks again each time
      if (path === "/display-guard.js")
        return this.file(res, path.slice(1), { "cache-control": "no-cache" });
      this.base(res, 404);
      res.end();
    } catch (e) {
      if (admitted) this.deps.log(`a page's request failed: ${(e as Error).message}`);
      if (!res.headersSent) this.base(res, 500);
      res.end();
    }
  }

  private json(res: ServerResponse, body: unknown): void {
    this.base(res, 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private live(req: IncomingMessage, res: ServerResponse): void {
    if (this.clients.size >= MAX_SCREENS) {
      this.base(res, 503, { "retry-after": "30" });
      return void res.end();
    }
    this.base(res, 200, { "content-type": "text/event-stream", connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    const snap = displaySnapshot(this.deps.snapshot(), this.art);
    res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  /** The playing track's lyrics, asked as the page derives the track; any other track, none. */
  private async lyrics(res: ServerResponse, url: URL): Promise<void> {
    if (!this.deps.lyricsAllowed()) return this.json(res, null);
    const p = url.searchParams;
    const duration = Number(p.get("duration"));
    const query: LyricsQuery = {
      artist: p.get("artist") ?? "",
      title: p.get("title") ?? "",
      album: p.get("album") || null,
      duration: p.get("duration") && Number.isFinite(duration) && duration > 0 ? duration : null,
    };
    if (!asksForPlaying(query, this.deps.snapshot())) return this.json(res, null);
    this.json(res, await this.deps.lyrics(query));
  }

  /** The playing library file, as the window's mediaNodeInfo answers it, but only for the track
   *  that is playing and with only what the scenes read: its tags, its length, its class. Its ids
   *  stand in as one opaque id, and its analysis key is noted so /api/analysis may answer it. */
  private async track(res: ServerResponse, url: URL): Promise<void> {
    const p = url.searchParams;
    const duration = Number(p.get("duration"));
    const asked: LyricsQuery = {
      artist: p.get("artist") ?? "",
      title: p.get("title") ?? "",
      album: p.get("album") || null,
      duration: p.get("duration") && Number.isFinite(duration) && duration > 0 ? duration : null,
    };
    if (!asksForPlaying(asked, this.deps.snapshot())) return this.json(res, null);
    // the page's picture address is an id this server handed out: the query gets the real one
    const art = /^\/art\/([0-9a-f]{24})$/.exec(p.get("art") ?? "");
    const found = await this.deps.trackInfo({
      kind: "track",
      title: asked.title,
      artist: asked.artist,
      album: asked.album,
      durationSecs: asked.duration,
      artUrl: art ? (this.artIds.get(art[1]) ?? null) : null,
    });
    const n = found?.node;
    if (!n || n.isContainer) return this.json(res, null);
    const key = audioAnalysisKey(n);
    this.trackKeys.delete(key);
    this.trackKeys.add(key);
    while (this.trackKeys.size > MAX_TRACK_KEYS)
      this.trackKeys.delete(this.trackKeys.keys().next().value!);
    const node: MediaNode = {
      id: artIdOf(key),
      parentId: null,
      title: n.title,
      upnpClass: n.upnpClass,
      isContainer: false,
      artUrl: null,
      artist: n.artist,
      album: n.album,
      year: n.year ?? null,
      trackNumber: n.trackNumber ?? null,
      durationSecs: n.durationSecs,
      serverUdn: "display",
    };
    this.json(res, { node });
  }

  /** A stored analysis, only by a key handed out with the playing file. */
  private storedAnalysis(res: ServerResponse, url: URL): void {
    const key = url.searchParams.get("key") ?? "";
    this.json(res, this.trackKeys.has(key) ? this.deps.analysis(key) : null);
  }

  private async picture(res: ServerResponse, id: string): Promise<void> {
    const url = this.artIds.get(id);
    const got = url ? await this.pictureOf(id, url) : null;
    if (!got) {
      this.base(res, 404);
      return void res.end();
    }
    this.base(res, 200, {
      "content-type": got.type,
      "content-security-policy": PICTURE_CSP,
      "cache-control": "private, max-age=86400",
    });
    res.end(got.bytes);
  }

  /** One fetch per picture however many screens ask at once, and the last few kept. A fetch
   *  that fails is a missing picture, never a hung request. */
  private pictureOf(id: string, url: string): Promise<{ bytes: Buffer; type: string } | null> {
    const have = this.kept.get(id);
    if (have) {
      this.kept.delete(id);
      this.kept.set(id, have);
      return Promise.resolve(have);
    }
    const asked = this.fetching.get(id);
    if (asked) return asked;
    const next = this.deps
      .picture(url)
      .catch(() => null)
      .then((got) => {
        this.fetching.delete(id);
        if (got) this.keep(id, got);
        return got;
      });
    this.fetching.set(id, next);
    return next;
  }

  private keep(id: string, got: { bytes: Buffer; type: string }): void {
    this.kept.set(id, got);
    let bytes = 0;
    for (const k of this.kept.values()) bytes += k.bytes.length;
    while (this.kept.size > KEPT_PICTURES || (bytes > KEPT_PICTURE_BYTES && this.kept.size > 1)) {
      const oldest = this.kept.keys().next().value!;
      bytes -= this.kept.get(oldest)!.bytes.length;
      this.kept.delete(oldest);
    }
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
    createReadStream(full)
      .on("error", () => res.destroy())
      .pipe(res);
  }
}
