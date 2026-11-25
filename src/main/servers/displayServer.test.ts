import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@shared/ipc";
import { DEFAULT_SETTINGS } from "@shared/model";
import {
  LINE_PICTURES_MAX,
  PLAYLISTS_SENT,
  PRESETS_MAX,
  QUEUE_AFTER,
  QUEUE_BEFORE,
  type DisplayControl,
  type DisplayVerb,
} from "@shared/displayControl";
import { asksForPlaying, CONTROL_RATE, DisplayServer, PING_MS, VOLUME_RATE } from "./displayServer";

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
  writeFileSync(join(page, "apple-touch-icon.png"), "png");
  writeFileSync(join(tmpdir(), "outside.txt"), "outside");
  const fetched: string[] = [];
  const asked: string[] = [];
  const logged: string[] = [];
  const steered: Array<{
    screen: string;
    name: string;
    verb: DisplayVerb;
    id?: number;
    secs?: number;
    playlist?: string;
  }> = [];
  const control: { now: DisplayControl } = {
    now: {
      state: "allowed",
      volume: null,
      next: null,
      queue: null,
      presets: null,
      playlists: null,
      wake: null,
      resume: null,
    },
  };
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
    controlFor: () => control.now,
    steer: (screen, name, verb, { id, secs, playlist }) => {
      steered.push({
        screen,
        name,
        verb,
        ...(id !== undefined ? { id } : {}),
        ...(secs !== undefined ? { secs } : {}),
        ...(playlist !== undefined ? { playlist } : {}),
      });
      return { done: true };
    },
  });
  await server.start(0, "127.0.0.1");
  const port = server.port!;
  const get = (
    path: string,
    opts: {
      cookie?: string;
      method?: string;
      host?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ) =>
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
            ...opts.headers,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end(opts.body);
    });
  /** A screen's verb, as the page sends it: its own origin, the header, a JSON body. */
  const steer = (
    verb: unknown,
    opts: {
      cookie?: string;
      headers?: Record<string, string>;
      origin?: string | null;
      id?: unknown;
      secs?: unknown;
    } = {},
  ) =>
    get("/api/control", {
      method: "POST",
      cookie: opts.cookie ?? `${cookie}; tt_screen=${SCREEN}`,
      headers: {
        ...(opts.origin === null ? {} : { origin: opts.origin ?? `http://127.0.0.1:${port}` }),
        "x-tastytunes": "control",
        "content-type": "application/json",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        ...opts.headers,
      },
      body: JSON.stringify({
        verb,
        touch: true,
        ...("id" in opts ? { id: opts.id } : {}),
        ...("secs" in opts ? { secs: opts.secs } : {}),
      }),
    });
  /** /api/live's first bytes, then whether the stream ended. */
  const live = (cookieHeader: string) =>
    new Promise<{ first: string; ended: Promise<void>; more(): string }>((resolve, reject) => {
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
            if (text.includes("event: control")) resolve({ first: text, ended, more: () => text });
          });
        },
      );
      // a stream the server lets go ends this way
      req.on("error", (e) => (e.message === "socket hang up" ? undefined : reject(e)));
      req.end();
    });
  return { get, live, steer, fetched, asked, logged, steered, control, server };
}

const cookie = `tt_display=${TOKEN}`;
const SCREEN = "0123456789abcdef0123456789abcdef";

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

  it("hands the home screen its icons to anyone, and its description only to a page let in", async () => {
    const { get } = await rig();
    const icon = await get("/apple-touch-icon.png");
    expect(icon.status).toBe(200);
    expect(icon.body).toBe("png");
    expect((await get("/manifest.webmanifest")).status).toBe(401);
    const m = await get("/manifest.webmanifest", { cookie });
    expect(m.status).toBe(200);
    expect(String(m.headers["content-type"])).toContain("application/manifest+json");
    const app = JSON.parse(m.body) as { start_url: string; display: string; scope: string };
    // a home-screen app keeps its own cookies: its start address carries the token
    expect(app.start_url).toBe(`/?t=${TOKEN}`);
    expect(app.display).toBe("standalone");
    expect(app.scope).toBe("/");
    // nothing else outside the token's door
    expect((await get("/assets/a.js")).status).toBe(401);
  });

  it("answers GET, and one POST route alone", async () => {
    const { get } = await rig();
    expect((await get("/api/snapshot", { cookie, method: "POST" })).status).toBe(405);
    expect((await get("/api/snapshot", { cookie, method: "PUT" })).status).toBe(405);
    expect((await get("/api/control?x=1", { cookie, method: "POST" })).status).toBe(405);
    expect((await get("/api/control", { cookie, method: "PUT" })).status).toBe(405);
    expect((await get("/api/control", { cookie })).status).toBe(404);
  });

  it("gives each browser an id of its own at its first visit, and keeps the one it has", async () => {
    const { get } = await rig();
    const first = await get(`/?t=${TOKEN}`);
    const cookies = first.headers["set-cookie"] as string[];
    const id = /tt_screen=([0-9a-f]{32}); Path=\/; HttpOnly; SameSite=Strict/.exec(
      cookies.join("\n"),
    );
    expect(id).not.toBeNull();
    const again = await get(`/?t=${TOKEN}`, { cookie: `tt_screen=${id![1]}` });
    expect(String(again.headers["set-cookie"])).not.toContain("tt_screen");
    // a screen opened before screens had ids is given one with the page
    expect(String((await get("/", { cookie })).headers["set-cookie"])).toMatch(
      /tt_screen=[0-9a-f]{32}/,
    );
    expect(
      (await get("/", { cookie: `${cookie}; tt_screen=${SCREEN}` })).headers["set-cookie"],
    ).toBeUndefined();
  });

  it("takes a verb only from its own page: the origin, the header, JSON, the token and the id", async () => {
    const { steer, steered } = await rig();
    expect((await steer("next", { origin: "http://evil.example" })).status).toBe(403);
    expect((await steer("next", { origin: null })).status).toBe(403);
    expect((await steer("next", { origin: "null" })).status).toBe(403);
    expect((await steer("next", { headers: { "x-tastytunes": "nope" } })).status).toBe(403);
    expect((await steer("next", { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await steer("next", { cookie: `tt_screen=${SCREEN}` })).status).toBe(401);
    expect((await steer("next", { cookie })).status).toBe(403);
    expect((await steer("next", { cookie: `${cookie}; tt_screen=short` })).status).toBe(403);
    expect(steered).toEqual([]);
    const done = await steer("next");
    expect(done.status).toBe(200);
    expect(JSON.parse(done.body)).toEqual({ done: true });
    // named from its browser: an iPad's Safari says it is a Mac, and the page says it has touch
    expect(steered).toEqual([{ screen: SCREEN, name: "iPad · Safari", verb: "next" }]);
  });

  it("knows a fixed list of verbs and nothing else", async () => {
    const { steer, steered } = await rig();
    for (const v of ["setVolumePercent", "recallPreset", "playQueueId", 7, null])
      expect((await steer(v)).status).toBe(400);
    expect(steered).toEqual([]);
  });

  it("seeks to a point in seconds from the start only, and passes no seconds with any other verb", async () => {
    const { steer, steered } = await rig();
    expect((await steer("seek")).status).toBe(400);
    expect((await steer("seek", { secs: "90" })).status).toBe(400);
    expect((await steer("seek", { secs: -1 })).status).toBe(400);
    expect((await steer("seek", { secs: null })).status).toBe(400);
    expect((await steer("seek", { secs: 90.4 })).status).toBe(200);
    expect((await steer("next", { secs: 90 })).status).toBe(200);
    expect(steered.map((x) => [x.verb, x.secs])).toEqual([
      ["seek", 90.4],
      ["next", undefined],
    ]);
  });

  it("plays a queue row by a whole-number id only, and passes no id with any other verb", async () => {
    const { steer, steered } = await rig();
    expect((await steer("playQueue")).status).toBe(400);
    expect((await steer("playQueue", { id: "7" })).status).toBe(400);
    expect((await steer("playQueue", { id: 7.5 })).status).toBe(400);
    expect((await steer("playQueue", { id: 7 })).status).toBe(200);
    expect((await steer("next", { id: 7 })).status).toBe(200);
    expect(steered.map((x) => [x.verb, x.id])).toEqual([
      ["playQueue", 7],
      ["next", undefined],
    ]);
  });

  it("keeps every picture a whole line names answerable, the playing cover's too", async () => {
    const { live, control, get } = await rig();
    const pic = (kind: string, i: number): string => `http://192.168.1.5/${kind}/${i}.jpg`;
    const rows = QUEUE_BEFORE + 1 + QUEUE_AFTER;
    control.now = {
      state: "allowed",
      volume: null,
      next: null,
      queue: Array.from({ length: rows }, (_, i) => ({
        id: i + 1,
        title: `T${i}`,
        artist: null,
        album: null,
        duration: 200,
        art: pic("q", i),
        playing: i === QUEUE_BEFORE,
      })),
      presets: Array.from({ length: PRESETS_MAX }, (_, i) => ({
        id: i + 1,
        name: `P${i}`,
        art: pic("p", i),
        lit: false,
        dead: false,
      })),
      playlists: Array.from({ length: PLAYLISTS_SENT }, (_, i) => ({
        id: `pl-${i}`,
        name: `L${i}`,
        art: pic("l", i),
        tracks: 3,
        secs: null,
        loading: null,
      })),
      wake: null,
      resume: null,
    };
    const opened = await live(`${cookie}; tt_screen=${SCREEN}`);
    // a line this long arrives in pieces: wait for the control event's end
    await vi.waitFor(() =>
      expect(opened.more().slice(opened.more().indexOf("event: control"))).toMatch(/\}\n\n/),
    );
    const ids = [
      ...new Set([...opened.more().matchAll(/\/art\/([0-9a-f]{24})/g)].map((m) => m[1])),
    ];
    // the playing cover (the snapshot's) and every row, preset and playlist
    expect(ids.length).toBe(1 + rows + PRESETS_MAX + PLAYLISTS_SENT);
    expect(rows + PRESETS_MAX + PLAYLISTS_SENT).toBeLessThanOrEqual(LINE_PICTURES_MAX);
    const statuses: number[] = [];
    for (let at = 0; at < ids.length; at += 50)
      statuses.push(
        ...(await Promise.all(
          ids.slice(at, at + 50).map(async (id) => (await get(`/art/${id}`, { cookie })).status),
        )),
      );
    expect(statuses.filter((st) => st !== 200)).toEqual([]);
  });

  it("sends a screen its queue with pictures by an id it handed out, never the address", async () => {
    const { live, control, get } = await rig();
    control.now = {
      state: "allowed",
      volume: null,
      next: null,
      queue: [
        {
          id: 4,
          title: "Song",
          artist: "Band",
          album: "Record",
          duration: 200,
          art: "http://192.168.1.5/q.jpg",
          playing: true,
        },
      ],
      presets: [
        { id: 3, name: "Radio", art: "http://192.168.1.5/p3.jpg", lit: false, dead: false },
      ],
      playlists: [
        {
          id: "0b8e2c4a-1f2d-4c3b-9a8e-7d6c5b4a3f21",
          name: "Sunday",
          art: "http://192.168.1.5/pl.jpg",
          tracks: 12,
          secs: 2880,
          loading: null,
        },
      ],
      wake: null,
      resume: null,
    };
    const opened = await live(`${cookie}; tt_screen=${SCREEN}`);
    expect(opened.first).not.toContain("192.168.1.5");
    expect(opened.first).not.toContain("p3.jpg");
    expect(opened.first).not.toContain("pl.jpg");
    const id = /"art":"\/art\/([0-9a-f]{24})"/.exec(opened.first)?.[1];
    expect(id).toBeDefined();
    expect((await get(`/art/${id}`, { cookie })).status).toBe(200);
  });

  it("plays a preset by a whole-number id only; Wake and picking up take none", async () => {
    const { steer, steered } = await rig();
    expect((await steer("playPreset")).status).toBe(400);
    expect((await steer("playPreset", { id: "2" })).status).toBe(400);
    expect((await steer("playPreset", { id: 2 })).status).toBe(200);
    expect((await steer("wake", { id: 2 })).status).toBe(200);
    expect((await steer("resume")).status).toBe(200);
    expect(steered.map((x) => [x.verb, x.id])).toEqual([
      ["playPreset", 2],
      ["wake", undefined],
      ["resume", undefined],
    ]);
  });

  it("plays a playlist by its own id only, letters, digits and dashes; no other verb takes one", async () => {
    const { steer, steered } = await rig();
    const id = "0b8e2c4a-1f2d-4c3b-9a8e-7d6c5b4a3f21";
    expect((await steer("playPlaylist")).status).toBe(400);
    expect((await steer("playPlaylist", { id: 7 })).status).toBe(400);
    expect((await steer("playPlaylist", { id: "../x" })).status).toBe(400);
    expect((await steer("playPlaylist", { id: "a".repeat(65) })).status).toBe(400);
    expect((await steer("playQueue", { id })).status).toBe(400);
    expect((await steer("playPlaylist", { id })).status).toBe(200);
    // stopping one on its way in takes nothing
    expect((await steer("stopPlaylist", { id })).status).toBe(200);
    expect(steered.map((x) => [x.verb, x.playlist, x.id])).toEqual([
      ["playPlaylist", id, undefined],
      ["stopPlaylist", undefined, undefined],
    ]);
  });

  it("caps one screen's commands, the volume's more tightly", async () => {
    const { steer, steered } = await rig();
    for (let i = 0; i < VOLUME_RATE.count; i++) expect((await steer("volumeUp")).status).toBe(200);
    expect((await steer("volumeUp")).status).toBe(429);
    for (let i = VOLUME_RATE.count; i < CONTROL_RATE.count; i++)
      expect((await steer("next")).status).toBe(200);
    expect((await steer("next")).status).toBe(429);
    expect(steered).toHaveLength(CONTROL_RATE.count);
  });

  it("names the build of the page it serves on every live connection", async () => {
    const { live } = await rig();
    const opened = await live(cookie);
    expect(opened.first).toMatch(/event: build\ndata: "[0-9a-f]{16}"\n\n/);
  });

  it("tells each open screen where it stands when it opens, and again when that changes", async () => {
    const { live, control, server } = await rig();
    control.now = {
      state: "ask",
      volume: null,
      next: null,
      queue: null,
      presets: null,
      playlists: null,
      wake: null,
      resume: null,
    };
    const opened = await live(`${cookie}; tt_screen=${SCREEN}`);
    expect(opened.first).toContain('event: control\ndata: {"state":"ask"');
    control.now = {
      state: "off",
      volume: null,
      next: null,
      queue: null,
      presets: null,
      playlists: null,
      wake: null,
      resume: null,
    };
    server.pushControl();
    await new Promise((r) => setTimeout(r, 50));
    expect(opened.more()).toContain('event: control\ndata: {"state":"off"');
    // said once: the same again sends nothing
    const before = opened.more().length;
    server.pushControl();
    await new Promise((r) => setTimeout(r, 50));
    expect(opened.more().length).toBe(before);
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
