import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamerCommand } from "@shared/ipc";
import type { ZoneNowPlaying, ZonePlayState } from "@shared/smoip";
import { NowPlayingBridge, type StreamerView } from "./nowPlayingBridge";
import { HOLD_MS } from "./nowPlayingRules";

const FAKE = join(__dirname, "__fixtures__", "fakeNowPlayingHelper.mjs");
const CONTROLS: ZoneNowPlaying = {
  controls: ["play_pause", "track_next", "track_previous", "seek"],
} as unknown as ZoneNowPlaying;
const playing = (over: Record<string, unknown> = {}, state = "play"): ZonePlayState =>
  ({
    state,
    queue_id: 7,
    metadata: {
      class: "md.track",
      source: "MEDIA_PLAYER",
      title: "Song",
      artist: "Band",
      album: "LP",
      duration: 240,
      art_url: null,
      ...over,
    },
  }) as unknown as ZonePlayState;

let bridge: NowPlayingBridge | null = null;
afterEach(() => {
  bridge?.stop();
  bridge = null;
});

function rig(opts: {
  hello?: string;
  then?: string;
  die?: string;
  view?: Partial<StreamerView>;
  external?: boolean;
  artFile?: (url: string) => Promise<string | null>;
}) {
  const clock = { offset: 0 };
  let gaveUp = 0;
  const record = join(mkdtempSync(join(tmpdir(), "tt-np-")), "lines");
  const view: StreamerView = {
    connected: true,
    powerOn: true,
    playState: playing(),
    nowPlaying: CONTROLS,
    position: 10,
    ...opts.view,
  };
  const fired: StreamerCommand[] = [];
  const logs: string[] = [];
  const args = [FAKE, "--record", record];
  if (opts.hello) args.push("--hello", opts.hello);
  if (opts.then) args.push("--then", opts.then);
  if (opts.die) args.push("--die", opts.die);
  bridge = new NowPlayingBridge({
    command: { file: process.execPath, args },
    view: () => view,
    claimExternal: () => opts.external ?? false,
    fire: (c) => fired.push(c),
    activate: () => logs.push("activated"),
    artFile: opts.artFile ?? (() => Promise.resolve(null)),
    fallbackArt: "/icon.png",
    log: (t) => logs.push(t),
    now: () => Date.now() + clock.offset,
    gaveUp: () => gaveUp++,
  });
  const lines = (): Array<Record<string, unknown>> =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { bridge, view, fired, logs, lines, clock, gaveUps: () => gaveUp };
}

describe("the Now Playing bridge", () => {
  it("claims a queue play once the helper says hello, with what a reader sees", async () => {
    const r = rig({});
    r.bridge.start();
    await vi.waitFor(() => expect(r.lines().length).toBe(1), { timeout: 5_000 });
    expect(r.lines()[0]).toMatchObject({
      t: "info",
      title: "Song",
      artist: "Band",
      album: "LP",
      duration: 240,
      elapsed: 10,
      playing: true,
      live: false,
      art: "/icon.png",
      can: { toggle: true, next: true, previous: true, seek: true, stop: false },
    });
    // nothing changed: nothing sent again
    r.bridge.update();
    r.bridge.update();
    expect(r.lines().length).toBe(1);
  });

  it("refuses a helper that doesn't speak its protocol", async () => {
    const r = rig({ hello: "hello something-else 9" });
    r.bridge.start();
    await vi.waitFor(() => expect(r.logs.join(" ")).toContain("not one this app speaks to"), {
      timeout: 5_000,
    });
    expect(r.bridge.running).toBe(false);
    expect(r.lines()).toEqual([]);
  });

  it("turns a key press into the play button's toggle", async () => {
    const r = rig({ then: "cmd pause" });
    r.bridge.start();
    await vi.waitFor(() => expect(r.fired).toEqual([{ type: "togglePlayback" }]), {
      timeout: 5_000,
    });
  });

  it("lets go at once on standby", async () => {
    const r = rig({});
    r.bridge.start();
    await vi.waitFor(() => expect(r.lines().length).toBe(1), { timeout: 5_000 });
    r.view.powerOn = false;
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines().at(-1)).toEqual({ t: "release" }), { timeout: 5_000 });
  });

  it("leaves another app's play alone, unless a preset recalled here started it", async () => {
    const r = rig({
      view: { playState: playing({ class: "stream.service.tidal", source: "TIDAL" }) },
    });
    (r.view.playState as unknown as { queue_id: null }).queue_id = null;
    r.bridge.start();
    await vi.waitFor(() => expect(r.logs).toContain("the helper is up"), { timeout: 5_000 });
    r.bridge.update();
    expect(r.lines()).toEqual([]);
    r.bridge.recalled();
    await vi.waitFor(() => expect(r.lines()[0]).toMatchObject({ t: "info", title: "Song" }), {
      timeout: 5_000,
    });
  });

  it("shows radio as live, with no length and no skipping", async () => {
    const r = rig({
      view: {
        playState: {
          state: "play",
          queue_id: null,
          metadata: { class: "stream.radio", station: "FIP", title: "A Song", source: "IR" },
        } as unknown as ZonePlayState,
        nowPlaying: { controls: ["play_pause", "stop"] } as unknown as ZoneNowPlaying,
      },
    });
    r.bridge.start();
    await vi.waitFor(() => expect(r.lines().length).toBe(1), { timeout: 5_000 });
    expect(r.lines()[0]).toMatchObject({
      title: "A Song",
      artist: "FIP",
      live: true,
      can: { next: false, seek: false, stop: true },
    });
    expect(r.lines()[0]).not.toHaveProperty("duration");
  });

  it("gives up on a helper that ends before its hello, says why, and hands the keys back", async () => {
    const r = rig({ die: "error: Windows' media controls aren't available here (0x80040154)" });
    r.bridge.start();
    await vi.waitFor(() => expect(r.gaveUps()).toBe(1), { timeout: 5_000 });
    expect(r.bridge.gaveUp).toBe(true);
    expect(r.logs.join(" ")).toContain("ended before its hello (2: error: Windows' media controls");
    // not started again until the setting is turned off and on
    r.bridge.start();
    expect(r.bridge.running).toBe(false);
    r.bridge.stop();
    expect(r.bridge.gaveUp).toBe(false);
  });

  it("holds a claim through a lagging title without blanking the tile, and only for a while", async () => {
    const r = rig({});
    r.bridge.start();
    await vi.waitFor(() => expect(r.lines().length).toBe(1), { timeout: 5_000 });
    r.view.playState = playing({ title: null });
    r.bridge.update();
    expect(r.lines().length).toBe(1);
    r.clock.offset = HOLD_MS;
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines().at(-1)).toEqual({ t: "release" }), { timeout: 5_000 });
  });

  it("lets go at the hold's check even when the timer fires before the clock says it's time", async () => {
    const r = rig({});
    r.bridge.start();
    await vi.waitFor(() => expect(r.lines().length).toBe(1), { timeout: 5_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      r.view.playState = playing({ title: null });
      r.bridge.update();
      // a busy main process: the callback reads a little less wall time than its delay
      r.clock.offset = -50;
      vi.advanceTimersByTime(HOLD_MS);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(r.lines().at(-1)).toEqual({ t: "release" }), { timeout: 5_000 });
    expect(r.logs.join(" ")).toContain("let go of Now Playing");
  });

  it("lets go when the streamer moves to an input with nothing to steer", async () => {
    const r = rig({});
    r.bridge.start();
    await vi.waitFor(() => expect(r.lines().length).toBe(1), { timeout: 5_000 });
    r.view.playState = playing({ title: null, source: "AIRPLAY", class: null }, "ready");
    r.view.nowPlaying = { controls: [] } as unknown as ZoneNowPlaying;
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines().at(-1)).toEqual({ t: "release" }), { timeout: 5_000 });
  });

  it("never claims a preset for an input, even one recalled here", async () => {
    const r = rig({
      view: {
        playState: playing({ title: null, source: "ANALOG", class: null }),
        nowPlaying: { controls: [] } as unknown as ZoneNowPlaying,
      },
    });
    r.bridge.start();
    await vi.waitFor(() => expect(r.logs).toContain("the helper is up"), { timeout: 5_000 });
    r.bridge.recalled();
    r.bridge.update();
    expect(r.lines()).toEqual([]);
  });

  it("waits a moment for a new track's sleeve rather than showing the icon first", async () => {
    const r = rig({
      view: { playState: playing({ art_url: "http://h/a.jpg" }) },
      artFile: () => new Promise((done) => setTimeout(() => done("/sleeve.jpg"), 150)),
    });
    r.bridge.start();
    await vi.waitFor(() => expect(r.lines().length).toBe(1), { timeout: 5_000 });
    expect(r.lines()[0]).toMatchObject({ art: "/sleeve.jpg" });
  });

  it("shows a track without its sleeve when the picture can't be had", async () => {
    const r = rig({
      view: { playState: playing({ art_url: "http://h/a.jpg" }) },
      artFile: () => Promise.reject(new Error("timed out")),
    });
    r.bridge.start();
    await vi.waitFor(() => expect(r.lines().length).toBe(1), { timeout: 5_000 });
    expect(r.lines()[0]).toMatchObject({ art: "/icon.png" });
  });
});
