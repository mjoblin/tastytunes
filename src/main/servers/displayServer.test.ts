import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@shared/ipc";
import { DEFAULT_SETTINGS, playKey } from "@shared/model";
import {
  LINE_PICTURES_MAX,
  PLAYLISTS_SENT,
  PRESETS_MAX,
  QUEUE_AFTER,
  QUEUE_BEFORE,
  type DisplayControl,
  type DisplayVerb,
} from "@shared/displayControl";
import {
  asksForPlaying,
  CONTROL_RATE,
  DisplayServer,
  MAX_RATE_KEYS,
  PING_MS,
  playingCoverKey,
  playingRadioSong,
  VOLUME_RATE,
} from "./displayServer";

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

async function rig(
  opts: {
    picture?: (url: string) => Promise<never>;
    thumb?: (url: string) => Promise<never>;
    token?: () => Promise<string>;
    snap?: Snapshot;
  } = {},
) {
  const page = mkdtempSync(join(tmpdir(), "tt-display-"));
  writeFileSync(join(page, "display.html"), "<html>page</html>");
  mkdirSync(join(page, "assets"));
  writeFileSync(join(page, "assets", "a.js"), "js");
  writeFileSync(join(page, "apple-touch-icon.png"), "png");
  writeFileSync(join(tmpdir(), "outside.txt"), "outside");
  const fetched: string[] = [];
  const thumbs: string[] = [];
  const asked: string[] = [];
  const covers: string[] = [];
  const logged: string[] = [];
  const steered: Array<{
    screen: string;
    name: string;
    verb: DisplayVerb;
    id?: number;
    secs?: number;
    playlist?: string;
    minutes?: number | "track";
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
      standby: false,
      sleep: null,
    },
  };
  server = new DisplayServer({
    snapshot: () => opts.snap ?? snapshot,
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
    thumb:
      opts.thumb ??
      ((url, tier) => {
        thumbs.push(`${tier} ${url}`);
        return Promise.resolve({ bytes: Buffer.from(`small ${tier}`), type: "image/jpeg" });
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
    radioCover: (artist, song) => {
      covers.push(`${artist}|${song}`);
      return Promise.resolve("data:image/png;base64,c29uZw==");
    },
    recentCover: (key) =>
      key === playKey("Song", "Band", "Record") ? "data:image/png;base64,c2F2ZWQ=" : null,
    token: opts.token ?? (() => Promise.resolve(token)),
    pageDir: page,
    log: (text) => logged.push(text),
    controlFor: () => control.now,
    steer: (screen, name, verb, { id, secs, playlist, minutes }) => {
      steered.push({
        screen,
        name,
        verb,
        ...(id !== undefined ? { id } : {}),
        ...(secs !== undefined ? { secs } : {}),
        ...(playlist !== undefined ? { playlist } : {}),
        ...(minutes !== undefined ? { minutes } : {}),
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
      minutes?: unknown;
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
        ...("minutes" in opts ? { minutes: opts.minutes } : {}),
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
  return { get, live, steer, fetched, thumbs, asked, covers, logged, steered, control, server };
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
    // both cookies Lax: sent on a visit from a link on another site, never on its POST or fetch
    const cookies = first.headers["set-cookie"] as string[];
    expect(cookies).toHaveLength(2);
    for (const c of cookies) expect(c).toMatch(/; HttpOnly; SameSite=Lax; /);
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
    const id = /tt_screen=([0-9a-f]{32}); Path=\/; HttpOnly; SameSite=Lax/.exec(cookies.join("\n"));
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
        parked: false,
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
      standby: false,
      sleep: null,
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
          parked: false,
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
      standby: false,
      sleep: null,
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

  it("sets the sleep timer for one of the window's lengths or the end of the track; standby and cancelling take nothing", async () => {
    const { steer, steered } = await rig();
    expect((await steer("sleep")).status).toBe(400);
    for (const minutes of [20, "30", 30.5, -15, 0, "end", null, 7200])
      expect((await steer("sleep", { minutes })).status).toBe(400);
    expect((await steer("sleep", { minutes: 30 })).status).toBe(200);
    expect((await steer("sleep", { minutes: "track" })).status).toBe(200);
    // no other verb takes a length
    expect((await steer("standby", { minutes: 30 })).status).toBe(200);
    expect((await steer("sleepCancel", { minutes: 30 })).status).toBe(200);
    expect(steered.map((x) => [x.verb, x.minutes])).toEqual([
      ["sleep", 30],
      ["sleep", "track"],
      ["standby", undefined],
      ["sleepCancel", undefined],
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

  it("remembers a bounded number of screens for the cap, however many made-up ids arrive", async () => {
    const { steer, server } = await rig();
    // a volume step is two entries a screen: the bound holds against a stream of them
    for (let i = 0; i < MAX_RATE_KEYS; i++) {
      const id = i.toString(16).padStart(32, "0");
      expect((await steer("volumeUp", { cookie: `${cookie}; tt_screen=${id}` })).status).toBe(200);
      expect(server.rateKeys).toBeLessThanOrEqual(MAX_RATE_KEYS);
    }
    expect(server.rateKeys).toBe(MAX_RATE_KEYS);
    // the screen heard last keeps its count: its next steps are still capped
    const last = (MAX_RATE_KEYS - 1).toString(16).padStart(32, "0");
    for (let i = 1; i < VOLUME_RATE.count; i++)
      expect((await steer("volumeUp", { cookie: `${cookie}; tt_screen=${last}` })).status).toBe(
        200,
      );
    expect((await steer("volumeUp", { cookie: `${cookie}; tt_screen=${last}` })).status).toBe(429);
  });

  it("names the build of the page it serves on every live connection, before the snapshot", async () => {
    const { live } = await rig();
    const opened = await live(cookie);
    expect(opened.first).toMatch(/event: build\ndata: "[0-9a-f]{16}"\n\n/);
    // a page from an older build reloads before it is handed anything to draw
    expect(opened.first.indexOf("event: build")).toBeLessThan(
      opened.first.indexOf("event: snapshot"),
    );
  });

  it("keeps no place for a live connection that closed while its token was read", async () => {
    let reading!: () => void;
    const read = new Promise<void>((r) => (reading = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { server } = await rig({
      token: async () => {
        reading();
        await held;
        return TOKEN;
      },
    });
    const req = request({
      host: "127.0.0.1",
      port: server.port!,
      path: "/api/live",
      agent: false,
      headers: { cookie },
    });
    req.on("error", () => {});
    req.end();
    await read;
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.screens).toBe(0);
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
      standby: false,
      sleep: null,
    };
    const before = Date.now();
    const opened = await live(`${cookie}; tt_screen=${SCREEN}`);
    expect(opened.first).toContain('event: control\ndata: {"state":"ask"');
    // with the app's clock as it went out, which a screen counts the sleep timer from
    const line = await vi.waitFor(() => /event: control\ndata: (.*)\n\n/.exec(opened.more())![1]);
    const told = (JSON.parse(line) as { now: number }).now;
    expect(told).toBeGreaterThanOrEqual(before);
    expect(told).toBeLessThanOrEqual(Date.now());
    control.now = {
      state: "off",
      volume: null,
      next: null,
      queue: null,
      presets: null,
      playlists: null,
      wake: null,
      resume: null,
      standby: false,
      sleep: null,
    };
    server.pushControl();
    await new Promise((r) => setTimeout(r, 50));
    expect(opened.more()).toContain('event: control\ndata: {"state":"off"');
    // said once: the same again sends nothing, however the clock has moved since
    const sent = opened.more().length;
    await new Promise((r) => setTimeout(r, 5));
    server.pushControl();
    await new Promise((r) => setTimeout(r, 50));
    expect(opened.more().length).toBe(sent);
  });

  it("tells an open screen of the sleep timer as it is armed", async () => {
    const { live, control, server } = await rig();
    const sleep = { action: "standby" as const, endOfTrack: true, armed: null };
    control.now = { ...control.now, standby: true, sleep };
    const opened = await live(`${cookie}; tt_screen=${SCREEN}`);
    expect(opened.first).toContain('"standby":true');
    control.now = { ...control.now, sleep: { ...sleep, armed: { firesAt: 1_700_000_000_000 } } };
    server.push({
      kind: "sleep",
      sleep: { action: "standby", minutes: 30, firesAt: 1_700_000_000_000, trackKey: null },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(opened.more()).toContain('"armed":{"firesAt":1700000000000}');
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

  it("hands over the log's copy of a cover only for the track that is playing", async () => {
    const { get, covers } = await rig();
    const key = encodeURIComponent(playKey("Song", "Band", "Record"));
    const saved = await get(`/api/cover?key=${key}`, { cookie });
    // handed over as a picture address, as the line's pictures are, serving the copy's bytes
    const address = JSON.parse(saved.body) as string;
    expect(address).toMatch(/^\/art\/[0-9a-f]{24}$/);
    const picture = await get(address, { cookie });
    expect(picture.status).toBe(200);
    expect(picture.headers["content-type"]).toBe("image/png");
    expect(picture.body).toBe("saved");
    const other = await get(
      `/api/cover?key=${encodeURIComponent(playKey("Other", "Band", null))}`,
      {
        cookie,
      },
    );
    expect(JSON.parse(other.body)).toBeNull();
    // off the radio, a song's cover is never asked for
    const radio = await get("/api/cover?artist=Band&song=Song", { cookie });
    expect(JSON.parse(radio.body)).toBeNull();
    expect(covers).toEqual([]);
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

  it("answers a list's row and card with a small copy, the cover and the scenes with the picture", async () => {
    const { get, fetched, thumbs } = await rig();
    const snap = JSON.parse((await get("/api/snapshot", { cookie })).body) as Snapshot;
    const path = snap.playState!.metadata!.art_url!;
    const row = await get(`${path}?size=thumb`, { cookie });
    expect(row.status).toBe(200);
    expect(row.body).toBe("small thumb");
    expect(row.headers["content-type"]).toBe("image/jpeg");
    expect(String(row.headers["content-security-policy"])).toContain("sandbox");
    expect((await get(`${path}?size=card`, { cookie })).body).toBe("small card");
    expect(thumbs).toEqual(["thumb http://192.168.1.5/a.jpg", "card http://192.168.1.5/a.jpg"]);
    expect(fetched).toEqual([]);
    // no size, or one it doesn't make: the picture as it is
    expect((await get(path, { cookie })).body).toBe("img");
    expect((await get(`${path}?size=9999`, { cookie })).body).toBe("img");
    expect(fetched).toEqual(["http://192.168.1.5/a.jpg"]);
    expect(thumbs).toHaveLength(2);
  });

  it("makes a small copy only of a picture it handed out, and answers one it couldn't make as missing", async () => {
    const { get, thumbs } = await rig();
    expect((await get(`/art/${"0".repeat(24)}?size=thumb`, { cookie })).status).toBe(404);
    expect((await get(`/art/${"0".repeat(24)}?size=thumb`)).status).toBe(401);
    expect(thumbs).toEqual([]);
    const failing = await rig({ thumb: () => Promise.reject(new Error("timed out")) });
    const snap = JSON.parse((await failing.get("/api/snapshot", { cookie })).body) as Snapshot;
    const path = snap.playState!.metadata!.art_url!;
    expect((await failing.get(`${path}?size=thumb`, { cookie })).status).toBe(404);
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
    expect(logged.filter((l) => !l.startsWith("Second screen"))).toEqual([]);
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

  it("tells every open page when a library index is ready, by an opaque id alone", async () => {
    const { live, server } = await rig();
    const opened = await live(cookie);
    server.push({
      kind: "mediaIndex",
      statuses: [
        {
          udn: "uuid:nas-1",
          serverName: "Shelf NAS",
          state: "ready",
          strategy: "search",
          tracks: 900,
          albums: 80,
          artists: 40,
          builtAt: 1_700_000_000_000,
          updateId: 7,
        },
        {
          udn: "uuid:usb-2",
          serverName: "Lounge USB",
          state: "building",
          strategy: "browse",
          tracks: 0,
          albums: 0,
          artists: 0,
          builtAt: null,
          updateId: null,
        },
      ],
    });
    await vi.waitFor(() => expect(opened.more()).toContain('"kind":"mediaIndex"'));
    const line = opened.more().slice(opened.more().indexOf('data: {"kind":"mediaIndex"'));
    const msg = JSON.parse(line.slice(6, line.indexOf("\n"))) as {
      statuses: Array<{ udn: string; state: string; builtAt: number | null }>;
    };
    expect(msg.statuses).toHaveLength(1);
    expect(msg.statuses[0]).toMatchObject({ state: "ready", builtAt: 1_700_000_000_000 });
    expect(msg.statuses[0].udn).toMatch(/^[0-9a-f]{24}$/);
    expect(line).not.toMatch(/uuid:|Shelf NAS|Lounge USB/);
  });

  it("tells every open page when the playing file's analysis is stored, and of no other track", async () => {
    const { get, live, server } = await rig();
    const opened = await live(cookie);
    // a track no page asked about is never named
    server.analysisStored("band|record|song|200");
    await get("/api/track?title=Song&artist=Band&album=Record&duration=200", { cookie });
    server.analysisStored("someone|else|other|99");
    server.analysisStored("band|record|song|200");
    await vi.waitFor(() => expect(opened.more()).toContain("event: measured"));
    const said = [...opened.more().matchAll(/event: measured\ndata: (.*)\n\n/g)].map(
      (m) => JSON.parse(m[1]) as string,
    );
    expect(said).toEqual(["band|record|song|200"]);
  });

  it("forgets the keys it gave out when the screens are let go, at a new address or a stop", async () => {
    const { get, live, server } = await rig();
    const key = "band|record|song|200";
    await get("/api/track?title=Song&artist=Band&album=Record&duration=200", { cookie });
    server.closeScreens();
    // a page opened afterwards hears of no track asked about before, and is handed nothing by it
    const opened = await live(cookie);
    server.analysisStored(key);
    await new Promise((r) => setTimeout(r, 50));
    expect(opened.more()).not.toContain("event: measured");
    const asked = await get(`/api/analysis?key=${encodeURIComponent(key)}`, { cookie });
    expect(JSON.parse(asked.body)).toBeNull();
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

describe("the covers past the streamer's picture", () => {
  const station = (title: string | null, art = "https://logo.example/fm.png") =>
    ({
      playState: {
        state: "play",
        metadata: { class: "md.radio.airable", station: "Mock FM", title, art_url: art },
      },
      nowPlaying: null,
    }) as unknown as Snapshot;

  it("reads the playing station's song as the page splits it", () => {
    expect(playingRadioSong(station("Sam Fender feat. Olivia Dean - Rein Me In"))).toEqual({
      artist: "Sam Fender feat. Olivia Dean",
      song: "Rein Me In",
    });
    // a show's name, the station's own message, or nothing announced: no song
    expect(playingRadioSong(station("Breakfast with the Team"))).toBeNull();
    expect(playingRadioSong(station(null))).toBeNull();
    // a library track is no station's song
    expect(playingRadioSong(snapshot)).toBeNull();
  });

  it("asks for a song's cover only while its station plays it", async () => {
    const { get, covers } = await rig({
      snap: station("Lady Gaga & Bruno Mars - Die With A Smile"),
    });
    const p = new URLSearchParams({ artist: "Lady Gaga & Bruno Mars", song: "Die With A Smile" });
    const playing = await get(`/api/cover?${p.toString()}`, { cookie });
    const address = JSON.parse(playing.body) as string;
    expect(address).toMatch(/^\/art\/[0-9a-f]{24}$/);
    expect((await get(address, { cookie })).body).toBe("song");
    const other = await get("/api/cover?artist=Band&song=Song", { cookie });
    expect(JSON.parse(other.body)).toBeNull();
    // a station has no saved cover in the log
    const key = await get(`/api/cover?key=${encodeURIComponent(playKey("Song", "Band", null))}`, {
      cookie,
    });
    expect(JSON.parse(key.body)).toBeNull();
    expect(covers).toEqual(["Lady Gaga & Bruno Mars|Die With A Smile"]);
  });

  it("keys the playing track as the log keys it, and never a station", () => {
    expect(playingCoverKey(snapshot)).toBe(playKey("Song", "Band", "Record"));
    expect(playingCoverKey(station("Band - Song"))).toBeNull();
  });
});
