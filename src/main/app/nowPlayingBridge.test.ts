import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamerCommand } from "@shared/ipc";
import type { ZoneNowPlaying, ZonePlayState } from "@shared/smoip";
import { NowPlayingBridge, type StreamerView } from "./nowPlayingBridge";

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
  view?: Partial<StreamerView>;
  external?: boolean;
}) {
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
  bridge = new NowPlayingBridge({
    command: { file: process.execPath, args },
    view: () => view,
    claimExternal: () => opts.external ?? false,
    fire: (c) => fired.push(c),
    activate: () => logs.push("activated"),
    artFile: () => Promise.resolve(null),
    fallbackArt: "/icon.png",
    log: (t) => logs.push(t),
    now: () => Date.now(),
  });
  const lines = (): Array<Record<string, unknown>> =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { bridge, view, fired, logs, lines };
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
});
