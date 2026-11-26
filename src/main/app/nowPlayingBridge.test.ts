import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamerCommand } from "@shared/ipc";
import type { ZoneNowPlaying, ZonePlayState } from "@shared/smoip";
import { HELLO_MS, NowPlayingBridge, type StreamerView } from "./nowPlayingBridge";
import { HOLD_MS, PENDING_MS } from "./nowPlayingRules";

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

/** Another app's play, or a streaming service's: no queue. */
const other = (source: string, title: string | null, state = "play"): ZonePlayState => ({
  ...playing({ source, title }, state),
  queue_id: null,
});

let bridge: NowPlayingBridge | null = null;
afterEach(() => {
  bridge?.stop();
  bridge = null;
});

function rig(opts: {
  hello?: string;
  then?: string;
  on?: string;
  quiet?: boolean;
  die?: string;
  view?: Partial<StreamerView>;
  external?: boolean;
  claimDemo?: boolean;
  artFile?: (url: string) => Promise<string | null>;
}) {
  const clock = { offset: 0 };
  let gaveUp = 0;
  const record = join(mkdtempSync(join(tmpdir(), "tt-np-")), "lines");
  const view: StreamerView = {
    connected: true,
    powerOn: true,
    demo: false,
    playState: playing(),
    nowPlaying: CONTROLS,
    position: 10,
    ...opts.view,
  };
  const fired: StreamerCommand[] = [];
  const logs: string[] = [];
  const counted: string[] = [];
  const args = [FAKE, "--record", record];
  if (opts.hello) args.push("--hello", opts.hello);
  if (opts.then) args.push("--then", opts.then);
  if (opts.on) args.push("--on", opts.on);
  if (opts.quiet) args.push("--quiet");
  if (opts.die) args.push("--die", opts.die);
  bridge = new NowPlayingBridge({
    command: { file: process.execPath, args },
    view: () => view,
    claimExternal: () => opts.external ?? false,
    claimDemo: opts.claimDemo,
    fire: (c) => fired.push(c),
    activate: () => logs.push("activated"),
    artFile: opts.artFile ?? (() => Promise.resolve(null)),
    fallbackArt: "/icon.png",
    log: (t, c) => (c ? counted : logs).push(t),
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
  return { bridge, view, fired, logs, counted, lines, clock, args, gaveUps: () => gaveUp };
}

/** A claim made: the first info is in. */
async function claimed(r: ReturnType<typeof rig>) {
  r.bridge.start();
  await vi.waitFor(() => expect(r.lines().length).toBe(1), { timeout: 5_000 });
}

/** The helper is up, nothing claimed yet. */
async function up(r: ReturnType<typeof rig>) {
  r.bridge.start();
  await vi.waitFor(() => expect(r.logs).toContain("the helper is up"), { timeout: 5_000 });
}

/** The claims made so far, as the log says them (written as each is made). */
const claims = (r: ReturnType<typeof rig>) =>
  r.logs.filter((l) => l.startsWith("claimed Now Playing"));

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

  it("leaves another app's play alone, even with a preset recalled over it, and claims the play the recall starts", async () => {
    const r = rig({ view: { playState: other("TIDAL", "Song") } });
    await up(r);
    r.bridge.update();
    expect(claims(r)).toEqual([]);
    // what played as the recall went out is not the recall's play
    r.bridge.recalled();
    r.view.position = 30;
    r.bridge.update();
    expect(claims(r)).toEqual([]);
    r.view.playState = other("TIDAL", "Mix Track");
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines()[0]).toMatchObject({ t: "info", title: "Mix Track" }), {
      timeout: 5_000,
    });
    expect(claims(r)).toEqual(["claimed Now Playing (external on TIDAL)"]);
  });

  it.each([
    ["on its own source, over a paused album", "TIDAL", "pause"],
    ["on the album's source, over a playing album", "MEDIA_PLAYER", "play"],
  ])("claims the play a preset recalled here starts %s", async (_, source, albumState) => {
    const r = rig({ view: { playState: playing({}, albumState) } });
    // the album is the streamer's own queue, claimed as such
    await claimed(r);
    r.bridge.recalled();
    // the recall's first moment names nothing; then the preset's play, another app's by kind
    r.view.playState = other(source, null, "connecting");
    r.bridge.update();
    r.view.playState = other(source, "Mix Track");
    r.bridge.update();
    await vi.waitFor(
      () => expect(r.lines().at(-1)).toMatchObject({ t: "info", title: "Mix Track" }),
      { timeout: 5_000 },
    );
  });

  it("leaves a phone's AirPlay alone through a recall, and claims the recall's own play when it comes", async () => {
    const r = rig({ view: { playState: other("AIRPLAY", "Phone Song") } });
    await up(r);
    r.bridge.recalled();
    r.view.position = 30;
    r.bridge.update();
    expect(claims(r)).toEqual([]);
    r.view.playState = other("TIDAL", "Mix Track");
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines()[0]).toMatchObject({ t: "info", title: "Mix Track" }), {
      timeout: 5_000,
    });
  });

  it("claims the play of a preset recalled a second time, never another app's in between", async () => {
    const r = rig({ view: { playState: playing({}, "pause") } });
    await claimed(r);
    r.bridge.recalled();
    r.view.playState = other("TIDAL", "Mix Track");
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines().at(-1)).toMatchObject({ title: "Mix Track" }), {
      timeout: 5_000,
    });
    // a phone takes over: another app's play, let go
    r.view.playState = other("AIRPLAY", "Phone Song");
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines().at(-1)).toEqual({ t: "release" }), { timeout: 5_000 });
    // the same preset again: not the phone's play, but the one it starts
    const made = claims(r).length;
    r.bridge.recalled();
    r.bridge.update();
    expect(claims(r).length).toBe(made);
    r.view.playState = other("TIDAL", "Mix Track");
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines().at(-1)).toMatchObject({ title: "Mix Track" }), {
      timeout: 5_000,
    });
    expect(claims(r).at(-1)).toBe("claimed Now Playing (external on TIDAL)");
  });

  it("claims nothing for a recall that came to nothing, once its wait is over", async () => {
    const r = rig({ view: { playState: other("AIRPLAY", "Phone Song") } });
    await up(r);
    r.bridge.recalled();
    r.clock.offset = PENDING_MS + 1;
    r.view.playState = other("AIRPLAY", "Another Phone Song");
    r.bridge.update();
    expect(claims(r)).toEqual([]);
  });

  it("claims a preset recalled from standby when its play comes, never on the pause a wake re-announces", async () => {
    const r = rig({
      view: {
        powerOn: false,
        playState: { state: "not_ready" } as unknown as ZonePlayState,
        nowPlaying: { controls: [] } as unknown as ZoneNowPlaying,
      },
    });
    await up(r);
    // noted before the wake re-announces what the streamer held (frames that come late)
    r.bridge.recalled();
    r.view.powerOn = true;
    r.view.playState = playing({ title: null }, "stop");
    r.bridge.update();
    r.view.playState = playing({}, "pause");
    r.view.nowPlaying = CONTROLS;
    r.bridge.update();
    // the held album is the streamer's own queue, claimed as such
    await vi.waitFor(() => expect(r.lines()[0]).toMatchObject({ title: "Song", playing: false }), {
      timeout: 5_000,
    });
    r.view.playState = other("TIDAL", "Mix Track");
    r.bridge.update();
    await vi.waitFor(
      () => expect(r.lines().at(-1)).toMatchObject({ title: "Mix Track", playing: true }),
      { timeout: 5_000 },
    );
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

  it("claims a disc as the streamer's own play, its track named by now_playing", async () => {
    const r = rig({
      view: {
        playState: {
          state: "play",
          queue_id: null,
          metadata: {
            class: "md.track.cd",
            source: "CD",
            title: "Tracks: 10 Length: 37:39",
            artist: "Band",
            album: "LP",
            duration: 200,
          },
        } as unknown as ZonePlayState,
        nowPlaying: {
          controls: ["play_pause", "track_next", "track_previous", "seek"],
          display: { class: "digital.cd", line1: "Side One", line2: "Band", line3: "LP" },
        } as unknown as ZoneNowPlaying,
      },
    });
    await claimed(r);
    expect(r.lines()[0]).toMatchObject({ title: "Side One", artist: "Band", album: "LP" });
    expect(r.logs.join(" ")).toContain("claimed Now Playing (queue on CD)");
  });

  it("keeps the tile playing, with its buttons, through a skip's buffering", async () => {
    const r = rig({});
    await claimed(r);
    r.view.playState = playing({ title: "Next" }, "buffering");
    r.view.nowPlaying = { controls: ["play_pause"] } as unknown as ZoneNowPlaying;
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines().length).toBe(2), { timeout: 5_000 });
    expect(r.lines()[1]).toMatchObject({
      title: "Next",
      playing: true,
      can: { toggle: true, next: true, previous: true, seek: true },
    });
    // a pause is shown as one
    r.view.playState = playing({ title: "Next" }, "pause");
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines().at(-1)).toMatchObject({ playing: false }), {
      timeout: 5_000,
    });
    expect(r.lines().at(-1)).toMatchObject({ can: { next: false, seek: false } });
  });

  it("claims nothing on a new connection until the streamer has said what plays and whether it is on", async () => {
    const r = rig({});
    await claimed(r);
    r.view.connected = false;
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines().at(-1)).toEqual({ t: "release" }), { timeout: 5_000 });
    // the socket's own reconnect: the cache still holds what played before the drop
    r.view.connected = true;
    r.bridge.connected();
    r.bridge.heardFrom("playState");
    r.bridge.update();
    expect(r.lines().length).toBe(2);
    r.bridge.heardFrom("power");
    await vi.waitFor(() => expect(r.lines().at(-1)).toMatchObject({ t: "info" }), {
      timeout: 5_000,
    });
  });

  it("starts a helper slow to say hello again, on the restart ladder, rather than giving up", async () => {
    const r = rig({ quiet: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      r.bridge.start();
      // the next start says hello
      r.args.splice(r.args.indexOf("--quiet"), 1);
      vi.advanceTimersByTime(HELLO_MS);
      vi.advanceTimersByTime(1_000);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(r.logs).toContain("the helper is up"), { timeout: 5_000 });
    expect(r.logs).toContain("the helper didn't say hello in time: starting it again");
    expect(r.gaveUps()).toBe(0);
    expect(r.bridge.gaveUp).toBe(false);
  });

  it("starts a new track at play_state's position, not the last track's, and follows the push again once it moves", async () => {
    const r = rig({});
    await claimed(r);
    r.view.position = 238;
    r.view.playState = { ...playing({ title: "Next" }), position: 0 };
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines().length).toBe(2), { timeout: 5_000 });
    expect(r.lines()[1]).toMatchObject({ title: "Next", elapsed: 0 });
    r.view.position = 30;
    r.bridge.update();
    await vi.waitFor(() => expect(r.lines().at(-1)).toMatchObject({ elapsed: 30 }), {
      timeout: 5_000,
    });
  });

  it("sends nothing for a key that comes after letting go", async () => {
    const r = rig({ then: "cmd pause", on: "release" });
    await claimed(r);
    r.view.powerOn = false;
    r.bridge.update();
    await vi.waitFor(
      () => expect(r.logs).toContain("pause from the system: not claimed, nothing sent"),
      {
        timeout: 5_000,
      },
    );
    expect(r.fired).toEqual([]);
  });

  it("logs the helper's own lines, at most one a second", async () => {
    const r = rig({ then: "log error The parameter is incorrect.\nlog error again" });
    await claimed(r);
    await vi.waitFor(
      () => expect(r.counted).toEqual(["the helper says: error The parameter is incorrect."]),
      { timeout: 5_000 },
    );
  });

  it("leaves the built-in demo alone, unless told to claim it", async () => {
    const r = rig({ view: { demo: true } });
    r.bridge.start();
    await vi.waitFor(() => expect(r.logs).toContain("the helper is up"), { timeout: 5_000 });
    r.bridge.update();
    expect(r.lines()).toEqual([]);
    r.bridge.stop();
    const told = rig({ view: { demo: true }, claimDemo: true });
    await claimed(told);
    expect(told.lines()[0]).toMatchObject({ t: "info", title: "Song" });
  });
});
