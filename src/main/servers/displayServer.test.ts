import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@shared/ipc";
import { DEFAULT_SETTINGS } from "@shared/model";
import { asksForPlaying, DisplayServer, PING_MS } from "./displayServer";

const TOKEN = "tok-123";
let token = TOKEN;
const snapshot = {
  connection: { phase: "connected", host: "192.168.1.5" },
  settings: { ...DEFAULT_SETTINGS, lastHost: "192.168.1.5" },
  playState: {
    state: "play",
    metadata: {
      title: "Song",
      artist: "Band",
      album: "Record",
      duration: 200,
      art_url: "http://192.168.1.5/a.jpg",
    },
  },
  nowPlaying: null,
  position: null,
  systemPower: { power: "ON" },
} as unknown as Snapshot;

let server: DisplayServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
  token = TOKEN;
});

async function rig(opts: { picture?: (url: string) => Promise<never> } = {}) {
  const page = mkdtempSync(join(tmpdir(), "tt-display-"));
  writeFileSync(join(page, "display.html"), "<html>page</html>");
  mkdirSync(join(page, "assets"));
  writeFileSync(join(page, "assets", "a.js"), "js");
  writeFileSync(join(tmpdir(), "outside.txt"), "outside");
  const fetched: string[] = [];
  const asked: string[] = [];
  const logged: string[] = [];
  server = new DisplayServer({
    snapshot: () => snapshot,
    lyrics: (q) => {
      asked.push(`${q.artist}|${q.title}`);
      return Promise.resolve({ plain: "words" } as never);
    },
    lyricsAllowed: () => true,
    picture:
      opts.picture ??
      ((url) => {
        fetched.push(url);
        return new Promise((r) =>
          setTimeout(() => r({ bytes: Buffer.from("img"), type: "image/jpeg" }), 20),
        );
      }),
    trackInfo: (q) =>
      Promise.resolve(
        q.title === "Song"
          ? {
              node: {
                id: "obj-77",
                parentId: "parent-9",
                title: "Song",
                upnpClass: "object.item.audioItem.musicTrack",
                isContainer: false,
                artUrl: "http://192.168.1.5/a.jpg",
                artist: "Band",
                album: "Record",
                year: "2001",
                trackNumber: 3,
                durationSecs: 200,
                serverUdn: "uuid:nas-1",
              },
              serverName: "Shelf NAS",
            }
          : null,
      ),
    analysis: (key) => (key === "band|record|song|200" ? ({ dr: 9 } as never) : null),
    token: () => Promise.resolve(token),
    pageDir: page,
    log: (text) => logged.push(text),
  });
  await server.start(0, "127.0.0.1");
  const port = server.port!;
  const get = (path: string, opts: { cookie?: string; method?: string; host?: string } = {}) =>
    new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          // a fresh connection each time, as a page's reconnect after the server let it go
          agent: false,
          method: opts.method ?? "GET",
          headers: {
            ...(opts.cookie ? { cookie: opts.cookie } : {}),
            ...(opts.host ? { host: opts.host } : {}),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  /** /api/live's first bytes, then whether the stream ended. */
  const live = (cookieHeader: string) =>
    new Promise<{ first: string; ended: Promise<void> }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/live",
          agent: false,
          headers: { cookie: cookieHeader },
        },
        (res) => {
          let text = "";
          const ended = new Promise<void>((done) => {
            res.on("end", done);
            res.on("close", done);
            res.on("error", () => done());
          });
          res.on("data", (c: Buffer) => {
            text += c.toString();
            if (text.includes("event: snapshot")) resolve({ first: text, ended });
          });
        },
      );
      // a stream the server lets go ends this way
      req.on("error", (e) => (e.message === "socket hang up" ? undefined : reject(e)));
      req.end();
    });
  return { get, live, fetched, asked, logged };
}

const cookie = `tt_display=${TOKEN}`;

describe("Display on other screens' server", () => {
  it("lets in only the address's token, trades it for a cookie, and takes it out of the address", async () => {
    const { get } = await rig();
    expect((await get("/")).status).toBe(401);
    expect((await get("/?t=wrong")).status).toBe(401);
    const first = await get(`/?t=${TOKEN}`);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/");
    expect(String(first.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(first.headers["set-cookie"])).toContain("SameSite=Strict");
    const page = await get("/", { cookie });
    expect(page.status).toBe(200);
    expect(page.body).toBe("<html>page</html>");
    expect(String(page.headers["content-security-policy"])).toContain("default-src 'self'");
  });

  it("answers GET only", async () => {
    const { get } = await rig();
    expect((await get("/api/snapshot", { cookie, method: "POST" })).status).toBe(405);
    expect((await get("/api/snapshot", { cookie, method: "PUT" })).status).toBe(405);
  });

  it("serves the reduced snapshot, with pictures by id", async () => {
    const { get } = await rig();
    const res = await get("/api/snapshot", { cookie });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("192.168.1.5");
    const art = (JSON.parse(res.body) as Snapshot).playState?.metadata?.art_url ?? "";
    expect(art).toMatch(/^\/art\/[0-9a-f]{24}$/);
  });

  it("serves only the pictures it handed out, and never fetches an address it is given", async () => {
    const { get, fetched } = await rig();
    expect((await get(`/art/${"0".repeat(24)}`, { cookie })).status).toBe(404);
    expect((await get("/art/x?u=http://evil.example/a.jpg", { cookie })).status).toBe(404);
    const snap = JSON.parse((await get("/api/snapshot", { cookie })).body) as Snapshot;
    const pic = await get(snap.playState!.metadata!.art_url!, { cookie });
    expect(pic.status).toBe(200);
    expect(pic.headers["content-type"]).toBe("image/jpeg");
    expect(fetched).toEqual(["http://192.168.1.5/a.jpg"]);
  });

  it("serves the built page's files and nothing outside it", async () => {
    const { get } = await rig();
    expect((await get("/assets/a.js", { cookie })).body).toBe("js");
    expect((await get("/assets/../../outside.txt", { cookie })).status).toBe(404);
    expect((await get("/assets/%2e%2e/%2e%2e/outside.txt", { cookie })).status).toBe(404);
    expect((await get("/settings.json", { cookie })).status).toBe(404);
  });

  it("opens every live connection with the reduced snapshot, so a reconnect is whole", async () => {
    const { live } = await rig();
    const { first } = await live(cookie);
    expect(first).toContain("event: snapshot");
    expect(first).toContain('"title":"Song"');
    expect(first).not.toContain("192.168.1.5");
  });

  it("lets every open screen go at a new address, and their reconnect is refused", async () => {
    const { live, get } = await rig();
    const { ended } = await live(cookie);
    expect(server!.screens).toBe(1);
    token = "tok-456";
    server!.closeScreens();
    await ended;
    expect(server!.screens).toBe(0);
    expect((await get("/api/live", { cookie })).status).toBe(401);
    expect((await get("/api/snapshot", { cookie: "tt_display=tok-456" })).status).toBe(200);
  });

  it("lets a screen go at the next ping when it was let in under an address since replaced", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { live } = await rig();
      const stale = await live(cookie);
      // its request read the old token a moment before the new one was stored: still open
      token = "tok-456";
      const fresh = await live("tt_display=tok-456");
      expect(server!.screens).toBe(2);
      vi.advanceTimersByTime(PING_MS);
      await stale.ended;
      expect(server!.screens).toBe(1);
      let ended = false;
      void fresh.ended.then(() => (ended = true));
      await new Promise((r) => setTimeout(r, 50));
      expect(ended).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks up lyrics only for the track that is playing", async () => {
    const { get, asked } = await rig();
    const playing = await get("/api/lyrics?artist=Band&title=Song&album=Record&duration=200", {
      cookie,
    });
    expect(JSON.parse(playing.body)).toEqual({ plain: "words" });
    const other = await get("/api/lyrics?artist=Someone&title=Anything", { cookie });
    expect(JSON.parse(other.body)).toBeNull();
    expect(asked).toEqual(["Band|Song"]);
  });

  it("serves a picture as a picture only, fetched once however many ask", async () => {
    const { get, fetched } = await rig();
    const snap = JSON.parse((await get("/api/snapshot", { cookie })).body) as Snapshot;
    const path = snap.playState!.metadata!.art_url!;
    const [a, b] = await Promise.all([get(path, { cookie }), get(`${path}?x=2`, { cookie })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(String(a.headers["content-security-policy"])).toContain("sandbox");
    expect((await get(path, { cookie })).status).toBe(200);
    expect(fetched).toEqual(["http://192.168.1.5/a.jpg"]);
  });

  it("answers a picture it couldn't fetch as missing, never a hung request", async () => {
    const { get, logged } = await rig({ picture: () => Promise.reject(new Error("timed out")) });
    const snap = JSON.parse((await get("/api/snapshot", { cookie })).body) as Snapshot;
    expect((await get(snap.playState!.metadata!.art_url!, { cookie })).status).toBe(404);
    expect(logged.filter((l) => l.includes("failed"))).toEqual([]);
  });

  it("refuses a malformed cookie or address, and a public host, without a log line", async () => {
    const { get, logged } = await rig();
    expect((await get("/", { cookie: "tt_display=%" })).status).toBe(401);
    expect((await get("//[", { cookie })).status).toBe(400);
    expect((await get("/", { cookie, host: "evil.example.com" })).status).toBe(400);
    expect((await get("/", { cookie, host: "studio-mac.local:8556" })).status).toBe(200);
    expect(logged.filter((l) => !l.startsWith("Display on other screens"))).toEqual([]);
  });

  it("asks the guard again each visit, the built assets never", async () => {
    const { get } = await rig();
    expect(String((await get("/assets/a.js", { cookie })).headers["cache-control"])).toContain(
      "immutable",
    );
  });
});

describe("the scenes' analysis on a page", () => {
  it("names the playing file with an opaque id and none of its server's, and only that file", async () => {
    const { get } = await rig();
    const res = await get("/api/track?title=Song&artist=Band&album=Record&duration=200", {
      cookie,
    });
    const node = (JSON.parse(res.body) as { node: Record<string, unknown> }).node;
    expect(node).toMatchObject({ title: "Song", artist: "Band", durationSecs: 200 });
    expect(res.body).not.toMatch(/obj-77|parent-9|uuid:nas-1|Shelf NAS|192\.168/);
    const other = await get("/api/track?title=Anything&artist=Someone", { cookie });
    expect(JSON.parse(other.body)).toBeNull();
  });

  it("hands over a stored analysis only by a key it gave out with the playing file", async () => {
    const { get } = await rig();
    const key = encodeURIComponent("band|record|song|200");
    expect(JSON.parse((await get(`/api/analysis?key=${key}`, { cookie })).body)).toBeNull();
    await get("/api/track?title=Song&artist=Band&album=Record&duration=200", { cookie });
    expect(JSON.parse((await get(`/api/analysis?key=${key}`, { cookie })).body)).toEqual({
      dr: 9,
    });
  });
});

describe("a lyrics request for the playing track", () => {
  const md = { title: "Song", artist: "Band", album: "Record", duration: 200 };
  const snap = { playState: { metadata: md }, nowPlaying: null } as unknown as Snapshot;
  it("matches the page's own query, and nothing else", () => {
    expect(
      asksForPlaying({ artist: "Band", title: "Song", album: "Record", duration: 200 }, snap),
    ).toBe(true);
    expect(
      asksForPlaying({ artist: "Band", title: "Song", album: null, duration: null }, snap),
    ).toBe(true);
    expect(
      asksForPlaying({ artist: "Band", title: "Other", album: null, duration: null }, snap),
    ).toBe(false);
    expect(
      asksForPlaying({ artist: "Band", title: "Song", album: null, duration: 199 }, snap),
    ).toBe(false);
    expect(asksForPlaying({ artist: "", title: "", album: null, duration: null }, snap)).toBe(
      false,
    );
  });

  it("takes a title alone for the playing file only when the streamer names no artist", () => {
    const bare = {
      playState: { metadata: { title: "Field Recording", artist: null, album: "Tapes" } },
      nowPlaying: { display: { line1: "Field Recording", line2: null } },
    } as unknown as Snapshot;
    const q = { artist: "", title: "Field Recording", album: "Tapes", duration: null };
    expect(asksForPlaying(q, bare, { noArtist: true })).toBe(true);
    // lyrics keep their rule: never without an artist
    expect(asksForPlaying(q, bare)).toBe(false);
    // a track with an artist is never asked for without one
    expect(asksForPlaying({ ...q, title: "Song", album: null }, snap, { noArtist: true })).toBe(
      false,
    );
  });
});
