import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import {
  isDisplayVerb,
  isPlaylistId,
  isSleepChoice,
  LINE_PICTURES_MAX,
  screenName,
  type DisplayControl,
  type DisplayControlAnswer,
  type DisplayVerb,
  type DisplayVerbArgs,
} from "@shared/displayControl";
import type { PushMessage, Snapshot } from "@shared/ipc";
import type { ArtTier } from "../lookups/artThumbs";
import {
  audioAnalysisKey,
  type AudioAnalysis,
  type LyricsQuery,
  type LyricsResult,
  type MediaInfoQuery,
  type MediaInfoTarget,
  type MediaNode,
} from "@shared/model";
import {
  artIdOf,
  clockedLine,
  displayControlLine,
  displayPush,
  displaySnapshot,
} from "./displayFeed";
import { SCREEN_ID } from "./displayScreens";
import { hostAllowed } from "./hostCheck";

/**
 * DISPLAY ON OTHER SCREENS (0.17.0): while its switch is on, the app serves its Display mode to any
 * browser on the local network, on its own port, for a tablet or another computer beside the
 * hi-fi. GET and the live channel, and ONE WRITE ROUTE (POST /api/control): a fixed list of verbs
 * (shared/displayControl), from a screen the app has allowed, nothing else reachable.
 *
 * - A TOKEN in the address (the one Settings shows): the first visit presents it as ?t=, the
 *   server answers with a cookie and sends the browser to the bare address, so the token never
 *   sits in the address bar, a referrer or a picture's request again. Without it, nothing but a
 *   page saying where to find the address. A new token ends every open screen at once
 *   (closeScreens), and their reconnect meets that page.
 * - The page's data is the reduced feed (displayFeed): the playing track, its state, the display
 *   settings; pictures by the id the feed handed out, never by address. A list's row or card asks
 *   for its picture's small copy (?size=, lib/artSrc), made and kept by the window's own thumbnail
 *   cache (lookups/artThumbs); the cover and the scenes take the picture as it is.
 * - THE LIVE CHANNEL IS WHOLE ON ITS OWN: every connection opens with the reduced snapshot, so a
 *   reconnect after a wake or a restart never shows the old track, and a ping every few seconds
 *   lets the page tell a quiet app from a lost one. Before the snapshot it says which build of the
 *   page it serves (`event: build`), so a page left open across an update reloads into the new one
 *   rather than running the old for days, and before drawing anything the new one sent
 *   (display/live).
 * - Lyrics only for the track that is playing: the page can't make the app look anything up.
 * - THE SCENES' ANALYSIS, FINISHED (stage 2): the page asks which library file is playing (the
 *   window's own question, answered only for the playing track, with the file's ids left out)
 *   and then that file's stored analysis, by a key this server handed out; it never measures
 *   anything, so a track the app hasn't analyzed shows the Sleeve's face, as in the window. When
 *   the window stores the analysis of a track a page asked about (it measures a track as it
 *   plays), every open page hears it (`event: measured`, with the key) and asks again.
 * - The page is the app's own Display tree (one home), built as a second entry of the renderer
 *   (display.html), with a web bridge in place of the window's API.
 * - ON THE HOME SCREEN: a tablet can add the page to its Home Screen and open it as an app of its
 *   own, with no browser around it. The web app description (/manifest.webmanifest) goes only to a
 *   page let in, and its start address carries the token, since a home-screen app keeps its own
 *   cookies, apart from the browser's; the icons go to anyone (they say only "TastyTunes"), since
 *   a home screen may fetch them without the page's cookie. A new address ends it, as every screen.
 * - EACH SCREEN ITS OWN ID (controls on the other screens): every browser is given an id of its own
 *   at its first visit (the tt_screen cookie, beside the token's), and the app's approvals are
 *   kept by it (displayScreens). Each open screen hears where it stands over its own line of the
 *   live channel (`event: control`), so it draws only what it may do.
 * - THE WRITE ROUTE'S CHECKS, in order: the Host as everywhere; an Origin equal to the page's own
 *   (a missing or null one refused); a header a form can't send, with a JSON body (a cross-site
 *   page would need a preflight this server never answers); the token's cookie; the screen's id; a
 *   known verb; a small rate cap per screen (volume steps a stricter one). Then the app decides
 *   (deps.steer): the switch, the screen's approval, what the source can do.
 */

export interface DisplayDeps {
  snapshot(): Snapshot;
  lyrics(query: LyricsQuery): Promise<LyricsResult | null | "unreachable">;
  lyricsAllowed(): boolean;
  picture(url: string): Promise<{ bytes: Buffer; type: string } | null>;
  /** A picture's small copy at a tier of the window's thumbnail cache (lookups/artThumbs), for a
   *  list's row or card: made once and kept, a picture that can't be resized as it came. */
  thumb(url: string, tier: ArtTier): Promise<{ bytes: Buffer; type: string } | null>;
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
  /** Where a screen stands and what it may see of the controls, by its id. */
  controlFor(screen: string | null): DisplayControl;
  /** A screen's verb, past the route's checks: what the app did with it. */
  steer(
    screen: string,
    name: string,
    verb: DisplayVerb,
    args: DisplayVerbArgs,
  ): DisplayControlAnswer;
}

const COOKIE = "tt_display";
/** The home screen's icons (src/renderer/public), served without the token. */
const HOME_ICONS = new Set(["/apple-touch-icon.png", "/app-icon-192.png", "/app-icon-512.png"]);
/** Each browser's own id, given at its first visit: the app's approvals are kept by it. */
const SCREEN_COOKIE = "tt_screen";
/** The one write route, and the header its requests carry (a form can't send one). */
export const CONTROL_PATH = "/api/control";
export const CONTROL_HEADER = "x-tastytunes";
/** A verb's body is a few bytes; anything longer isn't one. */
const MAX_CONTROL_BODY = 512;
/** At most this many commands from one screen in a few seconds, volume steps fewer: a screen's
 *  runaway repeat stops here as well as on the page. */
export const CONTROL_RATE = { count: 8, ms: 4_000 } as const;
export const VOLUME_RATE = { count: 4, ms: 1_000 } as const;
/** The picture ids kept: room for two whole control lines (a screen still fetching the pictures
 *  of the one before as the next arrives) and the playing cover, which its push names before the
 *  line does. Worked out from what a line can name, so the two can't drift apart. */
export const MAX_ART_IDS = 2 * LINE_PICTURES_MAX + 1;
/** The analysis keys handed out with the playing file, kept for its next few asks (and forgotten
 *  with the screens, closeScreens). */
const MAX_TRACK_KEYS = 20;
/** A ping this often; the page counts the app lost after a few missed (display/live). */
export const PING_MS = 5_000;
/** Screens at once; more is someone else's loop, not a household. */
const MAX_SCREENS = 16;
/** The rate cap's memory, at most: two entries a screen (its commands, its volume steps), room
 *  for twice the screens at once, the least recently heard let go first. */
export const MAX_RATE_KEYS = 4 * MAX_SCREENS;
/** A screen whose unread pushes pass this has stopped reading: it is let go. */
const MAX_UNREAD_BYTES = 1 << 20;
/** The last few pictures as they are (the cover, the scenes), kept so a page's reload or a second
 *  screen doesn't fetch them again; a list's small copies are the thumbnail cache's. */
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
/** The small copies a list asks for, by the thumbnail cache's tiers (lib/artSrc asks). */
const isTier = (size: string | null): size is ArtTier => size === "thumb" || size === "card";
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
const NO_ADDRESS = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TastyTunes</title><body style="font:16px system-ui;background:#111;color:#ddd;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><p>Open the address shown in TastyTunes, in Settings › Integrations › Second screen.</p></body>`;

/** The pushes that can change what a screen may do: the switches (settings), the source and its
 *  controls, the volume, the queue, the connection, and for presets and the sleeping screen the
 *  presets, the playlists and a playlist's loading, the power, what is held, a recall's answer and
 *  a wake, and the sleep timer. */
const CONTROL_KINDS: ReadonlySet<PushMessage["kind"]> = new Set([
  "settings",
  "connection",
  "playState",
  "nowPlaying",
  "zoneState",
  "queue",
  "presets",
  "playlists",
  "playlistActivation",
  "systemPower",
  "held",
  "recalledPreset",
  "presetRecallDead",
  "waking",
  "sleep",
]);

const newScreenId = (): string => randomBytes(16).toString("hex");

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

/**
 * A cookie that lasts a year, for this server's own pages. SameSite=Lax, not Strict: a browser
 * sends a Lax cookie on a top-level visit from another site, so the address opened from a link in
 * a mail or a web chat lets the screen in and keeps its id (a Strict one is held back there, and
 * the screen met "Open the address" with a new id in place of an allowed one). It never sends one
 * on a cross-site POST, frame or fetch, and the write route keeps its Origin, header and JSON
 * checks besides; no GET changes anything.
 */
const cookieLine = (name: string, value: string): string =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;

/** The screen's own id, or null without a well-formed one. */
function screenOf(req: IncomingMessage): string | null {
  const id = cookieOf(req, SCREEN_COOKIE);
  return id != null && SCREEN_ID.test(id) ? id : null;
}

/** A JSON body of at most `max` bytes, or null (too long, or not JSON). */
function bodyOf(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        resolve(null);
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
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
export function asksForPlaying(
  q: LyricsQuery,
  snap: Snapshot,
  { noArtist = false }: { noArtist?: boolean } = {},
): boolean {
  const md = snap.playState?.metadata;
  const d = snap.nowPlaying?.display;
  const is = (v: string | null | undefined, ...of: Array<string | null | undefined>): boolean =>
    v != null && v !== "" && of.some((o) => o === v);
  // `noArtist`: a file with no artist tag is asked for by its title alone, when the streamer
  // names no artist either (the playing file's route; lyrics are never asked without one)
  const artistless = noArtist && q.artist === "" && !md?.artist && !d?.line2;
  return (
    is(q.title, md?.title, md?.station, d?.line1) &&
    (artistless || is(q.artist, md?.artist, md?.title, d?.line2)) &&
    (q.album == null || is(q.album, md?.album, d?.line3)) &&
    (q.duration == null || q.duration === md?.duration)
  );
}

export class DisplayServer {
  private http: Server | null = null;
  /** Each open screen: the token it was let in under, its id, and the control line it last heard. */
  private readonly clients = new Map<
    ServerResponse,
    { token: string; screen: string | null; control: string | null }
  >();
  /** Each screen's last few commands, for the rate cap. */
  private readonly sent = new Map<string, number[]>();
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

  /** What the rate cap remembers (for the tests). */
  get rateKeys(): number {
    return this.sent.size;
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
          this.deps.log(`Second screen stopped: ${e.message}`);
          this.stop();
          this.deps.failed?.(e.message);
        });
        const a = server.address();
        this.listening = { port: typeof a === "object" && a ? a.port : port, host };
        this.ping = setInterval(() => void this.pingScreens(), PING_MS);
        this.deps.log(`Second screen is on, port ${this.listening.port}`);
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
    if (this.listening) this.deps.log("Second screen is off");
    this.listening = null;
    this.kept.clear();
    this.sent.clear();
  }

  /** Every open screen let go, the server still listening: after a new address, each screen's
   *  reconnect meets the "open the address" page. The analysis keys go with them (at a stop too),
   *  so no page opened after hears of a track asked about before. */
  closeScreens(): void {
    for (const c of this.clients.keys()) c.end();
    this.clients.clear();
    this.trackKeys.clear();
    this.http?.closeAllConnections();
  }

  /** What the streamer reports reaches every open page, reduced. */
  push(msg: PushMessage): void {
    if (this.clients.size === 0) return;
    const out = displayPush(msg, this.art);
    if (out) this.send(`data: ${JSON.stringify(out)}\n\n`);
    // what a screen may do follows the switches, the source and the queue
    if (CONTROL_KINDS.has(msg.kind)) this.pushControl();
  }

  /** Each open screen hears where it stands, when that changed since it last heard. */
  pushControl(): void {
    for (const [c, client] of this.clients) {
      const line = this.controlLine(client.screen);
      if (line === client.control) continue;
      client.control = line;
      if (!this.write(c, `event: control\ndata: ${clockedLine(line, Date.now())}\n\n`))
        this.clients.delete(c);
    }
  }

  /** Every few seconds: a screen let in under an address since replaced (its request read the
   *  old token a moment before the new one was stored) is let go; the rest hear the ping. */
  private async pingScreens(): Promise<void> {
    const token = await this.deps.token().catch(() => null);
    if (token == null) return;
    for (const [c, { token: under }] of this.clients)
      if (!sameToken(under, token)) {
        this.clients.delete(c);
        c.end();
      }
    this.send("event: ping\ndata: 1\n\n");
  }

  private send(line: string): void {
    for (const c of this.clients.keys()) if (!this.write(c, line)) this.clients.delete(c);
  }

  /** Where a screen stands, as sent: its queue's pictures by an id this server handed out. Written
   *  with the app's clock (clockedLine), which this leaves out so a line is compared without it. */
  private controlLine(screen: string | null): string {
    return JSON.stringify(displayControlLine(this.deps.controlFor(screen), this.art));
  }

  /** One screen's line, or false for a screen that stopped reading (it is let go). */
  private write(c: ServerResponse, line: string): boolean {
    if (c.writableLength > MAX_UNREAD_BYTES) {
      c.destroy();
      return false;
    }
    c.write(line);
    return true;
  }

  /** A picture's page address: the id is noted so /art/<id> can serve it, the address never. */
  private readonly art = (url: string): string => {
    const id = artIdOf(url);
    this.artIds.delete(id);
    this.artIds.set(id, url);
    while (this.artIds.size > MAX_ART_IDS) this.artIds.delete(this.artIds.keys().next().value!);
    return `/art/${id}`;
  };

  private base(
    res: ServerResponse,
    status: number,
    headers: Record<string, string | string[]> = {},
  ): void {
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
      // the one write route, with its own checks
      if (req.method === "POST" && req.url === CONTROL_PATH) return await this.control(req, res);
      if (req.method !== "GET" && req.method !== "HEAD") {
        this.base(res, 405, { allow: "GET, HEAD" });
        return void res.end();
      }
      const url = urlOf(req);
      if (!url || !hostAllowed(req.headers.host, "network")) return this.refuse(res, 400);
      if (HOME_ICONS.has(url.pathname))
        return this.file(res, url.pathname.slice(1), { "cache-control": "public, max-age=86400" });
      const token = await this.deps.token();
      const given = url.searchParams.get("t");
      // the first visit: the token from the address becomes a cookie, and the address loses it
      if (given != null) {
        if (!sameToken(given, token)) return this.refuse(res, 401, NO_ADDRESS);
        // and the browser's own id, kept when it already has one
        this.base(res, 303, {
          location: "/",
          "set-cookie": [
            cookieLine(COOKIE, token),
            ...(screenOf(req) ? [] : [cookieLine(SCREEN_COOKIE, newScreenId())]),
          ],
        });
        return void res.end();
      }
      if (!sameToken(cookieOf(req, COOKIE) ?? "", token)) return this.refuse(res, 401, NO_ADDRESS);
      admitted = true;
      const path = url.pathname;
      if (path === "/" || path === "/index.html")
        return this.file(res, "display.html", {
          "content-security-policy": PAGE_CSP,
          // a screen opened before screens had ids is given one now
          ...(screenOf(req) ? {} : { "set-cookie": cookieLine(SCREEN_COOKIE, newScreenId()) }),
        });
      if (path === "/manifest.webmanifest") return this.manifest(res, token);
      if (path === "/api/snapshot")
        return this.json(res, displaySnapshot(this.deps.snapshot(), this.art));
      if (path === "/api/live") return this.live(req, res, token);
      if (path === "/api/lyrics") return await this.lyrics(res, url);
      if (path === "/api/track") return await this.track(res, url);
      if (path === "/api/analysis") return this.storedAnalysis(res, url);
      const art = /^\/art\/([0-9a-f]{24})$/.exec(path);
      if (art) return await this.picture(res, art[1], url.searchParams.get("size"));
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

  private json(res: ServerResponse, body: unknown, status = 200): void {
    this.base(res, status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  /** The web app description a tablet's Home Screen reads: TastyTunes, standalone, black, its
   *  start address carrying the token (the header comment's ON THE HOME SCREEN). */
  private manifest(res: ServerResponse, token: string): void {
    this.base(res, 200, { "content-type": "application/manifest+json" });
    res.end(
      JSON.stringify({
        name: "TastyTunes",
        short_name: "TastyTunes",
        start_url: `/?t=${encodeURIComponent(token)}`,
        scope: "/",
        display: "standalone",
        background_color: "#000000",
        theme_color: "#000000",
        icons: [
          { src: "/app-icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/app-icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      }),
    );
  }

  /** THE ONE WRITE ROUTE: a screen's verb, past every check (the header comment's list). */
  private async control(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host, "network")) return this.refuse(res, 400);
    const origin = req.headers.origin;
    if (!origin || origin !== `http://${req.headers.host}`) return this.refuse(res, 403);
    if (req.headers[CONTROL_HEADER] !== "control") return this.refuse(res, 403);
    if (!/^application\/json(;|$)/.test(req.headers["content-type"] ?? ""))
      return this.refuse(res, 415);
    if (!sameToken(cookieOf(req, COOKIE) ?? "", await this.deps.token()))
      return this.refuse(res, 401);
    const screen = screenOf(req);
    if (!screen) return this.refuse(res, 403);
    const body = (await bodyOf(req, MAX_CONTROL_BODY)) as {
      verb?: unknown;
      id?: unknown;
      secs?: unknown;
      minutes?: unknown;
      touch?: unknown;
    } | null;
    if (!body || !isDisplayVerb(body.verb)) return this.refuse(res, 400);
    const verb = body.verb;
    // a queue row or a preset is played by its id, a whole number, and no other verb takes one
    const id = typeof body.id === "number" && Number.isSafeInteger(body.id) ? body.id : undefined;
    const takesId = verb === "playQueue" || verb === "playPreset";
    if (takesId && id === undefined) return this.refuse(res, 400);
    // a seek goes to a point in the track, in seconds from its start, and no other verb takes one
    const secs =
      typeof body.secs === "number" && Number.isFinite(body.secs) && body.secs >= 0
        ? body.secs
        : undefined;
    if (verb === "seek" && secs === undefined) return this.refuse(res, 400);
    // a playlist is played by its own id, the app's (letters, digits and dashes)
    const playlist = verb === "playPlaylist" && isPlaylistId(body.id) ? body.id : undefined;
    if (verb === "playPlaylist" && playlist === undefined) return this.refuse(res, 400);
    // the sleep timer runs for one of the window's lengths or to the end of the track, and no
    // other verb takes one
    const minutes = verb === "sleep" && isSleepChoice(body.minutes) ? body.minutes : undefined;
    if (verb === "sleep" && minutes === undefined) return this.refuse(res, 400);
    if (!this.withinRate(screen, verb)) return this.json(res, { refused: "busy" }, 429);
    const name = screenName(req.headers["user-agent"] ?? "", body.touch === true);
    const answer = this.deps.steer(screen, name, verb, {
      id: takesId ? id : undefined,
      secs: verb === "seek" ? secs : undefined,
      playlist,
      minutes,
    });
    this.json(res, answer, "done" in answer ? 200 : answer.refused === "nothing" ? 409 : 403);
    // the screen hears where it stands now (an ask raised, say)
    this.pushControl();
  }

  /** Within the rate cap: CONTROL_RATE for every verb, VOLUME_RATE for a volume step. */
  private withinRate(screen: string, verb: DisplayVerb): boolean {
    const now = Date.now();
    const volume = verb === "volumeUp" || verb === "volumeDown";
    const kinds = volume ? [`${screen}`, `${screen}:volume`] : [`${screen}`];
    const caps = volume ? [CONTROL_RATE, VOLUME_RATE] : [CONTROL_RATE];
    const recent = kinds.map((k, i) =>
      (this.sent.get(k) ?? []).filter((at) => now - at < caps[i].ms),
    );
    if (recent.some((r, i) => r.length >= caps[i].count)) return false;
    // moved to the end as it is heard, so the oldest is the least recently heard
    kinds.forEach((k, i) => {
      this.sent.delete(k);
      this.sent.set(k, [...recent[i], now]);
    });
    // a volume step adds two: down to the bound however many a stream of made-up ids brings
    while (this.sent.size > MAX_RATE_KEYS) this.sent.delete(this.sent.keys().next().value!);
    return true;
  }

  private live(req: IncomingMessage, res: ServerResponse, token: string): void {
    // the screen went while its token was read (handle's await): its close has already been
    // heard, so it would never give its place back
    if (req.destroyed || res.destroyed) return;
    if (this.clients.size >= MAX_SCREENS) {
      this.base(res, 503, { "retry-after": "30" });
      return void res.end();
    }
    this.base(res, 200, { "content-type": "text/event-stream", connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    // the build first: a page from an older one reloads before it is handed a snapshot it may
    // not know how to draw (a scene added since, say)
    res.write(`event: build\ndata: ${JSON.stringify(this.build())}\n\n`);
    const snap = displaySnapshot(this.deps.snapshot(), this.art);
    res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
    const screen = screenOf(req);
    const control = this.controlLine(screen);
    res.write(`event: control\ndata: ${clockedLine(control, Date.now())}\n\n`);
    this.clients.set(res, { token, screen, control });
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
    if (!asksForPlaying(asked, this.deps.snapshot(), { noArtist: true }))
      return this.json(res, null);
    // the page's picture address is an id this server handed out: the query gets the real one
    const art = /^\/art\/([0-9a-f]{24})$/.exec(p.get("art") ?? "");
    const found = await this.deps.trackInfo({
      kind: "track",
      title: asked.title,
      artist: asked.artist || null,
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

  /** The window stored a track's analysis: a page showing that track asks for it now, rather
   *  than at the next track. Only a key handed out with a playing file is named: one of the last
   *  MAX_TRACK_KEYS a page asked about since the screens were last let go (closeScreens), so a page
   *  may hear of a track that played before it opened, never of one no page asked about. */
  analysisStored(key: string): void {
    if (this.clients.size === 0 || !this.trackKeys.has(key)) return;
    this.send(`event: measured\ndata: ${JSON.stringify(key)}\n\n`);
  }

  /** A stored analysis, only by a key handed out with the playing file. */
  private storedAnalysis(res: ServerResponse, url: URL): void {
    const key = url.searchParams.get("key") ?? "";
    this.json(res, this.trackKeys.has(key) ? this.deps.analysis(key) : null);
  }

  /** A picture by the id handed out: its small copy when a list asks for one, else as it is. */
  private async picture(res: ServerResponse, id: string, size: string | null): Promise<void> {
    const url = this.artIds.get(id);
    const got = !url
      ? null
      : isTier(size)
        ? await this.deps.thumb(url, size).catch(() => null)
        : await this.pictureOf(id, url);
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

  /** Which build of the page this server serves: its HTML's hash (the HTML names the hashed
   *  assets, so any change to the page changes it), read once. */
  private buildId: string | null = null;
  private build(): string {
    if (this.buildId == null) {
      try {
        const html = readFileSync(join(this.deps.pageDir, "display.html"));
        this.buildId = createHash("sha256").update(html).digest("hex").slice(0, 16);
      } catch {
        this.buildId = "";
      }
    }
    return this.buildId;
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
