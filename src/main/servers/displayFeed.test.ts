import { describe, expect, it } from "vitest";
import type { Snapshot } from "@shared/ipc";
import { DEFAULT_SETTINGS, type MediaIndexStatus } from "@shared/model";
import {
  artIdOf,
  clockedLine,
  displayIndexes,
  displayPush,
  displaySettings,
  displaySnapshot,
  HELD_SETTINGS,
  SHOWN_SETTINGS,
} from "./displayFeed";

const art = (url: string): string => `/art/${artIdOf(url)}`;

const snap = {
  connection: { phase: "connected", host: "192.168.1.5" },
  devices: [
    { host: "192.168.1.5", friendlyName: "Lounge", model: "Evo", udn: "u", descriptionUrl: "" },
  ],
  settings: {
    ...DEFAULT_SETTINGS,
    displayScene: "tide",
    displayLyrics: false,
    theme: "light",
    lastHost: "192.168.1.5",
    knownDevices: [
      { udn: "u", host: "192.168.1.5", friendlyName: "Lounge", model: "Evo", lastSeenAt: 1 },
    ],
    displayServer: { enabled: true, port: 8556 },
  },
  playState: { state: "play", metadata: { title: "Song", art_url: "http://192.168.1.5/art?id=9" } },
  nowPlaying: {
    display: { line1: "Song", art_url: "http://192.168.1.5/art?id=9", art_file: "/mnt/usb/a.jpg" },
  },
  position: { position: 12 },
  systemPower: { power: "ON" },
  systemInfo: { udn: "u", name: "Lounge" },
  logs: [{ at: 1, level: "info", scope: "x", text: "secret" }],
  recents: [{ title: "x" }],
  favorites: [{ kind: "album" }],
} as unknown as Snapshot;

describe("what a screen on the network may see", () => {
  it("is the playing track and the display settings, nothing of the house", () => {
    const out = displaySnapshot(snap, art);
    const text = JSON.stringify(out);
    expect(text).not.toContain("192.168.1.5");
    expect(text).not.toContain("Lounge");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("/mnt/usb");
    expect(out.devices).toEqual([]);
    expect(out.logs).toEqual([]);
    expect(out.recents).toEqual([]);
    expect(out.favorites).toEqual([]);
    expect(out.systemInfo).toBeNull();
    expect(out.connection).toEqual({ phase: "connected", host: "", demo: undefined });
    expect(out.playState?.metadata?.title).toBe("Song");
    expect(out.position).toEqual({ position: 12 });
    expect(out.systemPower).toEqual({ power: "ON" });
  });

  it("names pictures by id, never by address", () => {
    const out = displaySnapshot(snap, art);
    const id = artIdOf("http://192.168.1.5/art?id=9");
    expect(out.playState?.metadata?.art_url).toBe(`/art/${id}`);
    expect(out.nowPlaying?.display?.art_url).toBe(`/art/${id}`);
    expect(out.nowPlaying?.display?.art_file).toBeNull();
  });

  it("carries Display's own settings and the look, the owner's scene, the rest at their defaults", () => {
    const s = displaySettings(snap.settings);
    expect(s.displayLyrics).toBe(false);
    expect(s.theme).toBe("light");
    expect(s.displayScene).toBe("tide");
    expect(s.lastHost).toBe(DEFAULT_SETTINGS.lastHost);
    expect(s.knownDevices).toEqual(DEFAULT_SETTINGS.knownDevices);
    expect(s.displayServer).toEqual(DEFAULT_SETTINGS.displayServer);
  });

  it("passes on only the pushes a page draws from, reduced", () => {
    expect(displayPush({ kind: "logs", logs: [] } as never, art)).toBeNull();
    expect(displayPush({ kind: "devices", devices: [], discovering: false }, art)).toBeNull();
    const conn = displayPush(
      { kind: "connection", state: { phase: "connected", host: "10.0.0.2" } },
      art,
    );
    expect(JSON.stringify(conn)).not.toContain("10.0.0.2");
    const ps = displayPush({ kind: "playState", data: snap.playState! }, art);
    expect(JSON.stringify(ps)).not.toContain("192.168.1.5");
  });

  it("names every field it passes: one a firmware adds stays in the app", () => {
    const ps = {
      ...snap.playState!,
      owner_email: "a@b.c",
      metadata: { ...snap.playState!.metadata!, account: "x" },
    } as never;
    const out = JSON.stringify(displayPush({ kind: "playState", data: ps }, art));
    expect(out).not.toContain("owner_email");
    expect(out).not.toContain("account");
    const power = displayPush(
      { kind: "systemPower", data: { power: "ON", standby_mode: "ECO_MODE", extra: 1 } as never },
      art,
    );
    expect(power).toEqual({ kind: "systemPower", data: { power: "ON" } });
  });

  it("holds every display setting to a decision: shown to a page, or held back", () => {
    const decided = new Set<string>([...SHOWN_SETTINGS, ...HELD_SETTINGS]);
    const display = Object.keys(DEFAULT_SETTINGS).filter((k) => k.startsWith("display"));
    expect(display.filter((k) => !decided.has(k))).toEqual([]);
    for (const k of SHOWN_SETTINGS) expect(k in DEFAULT_SETTINGS).toBe(true);
  });

  it("tells a page which library indexes are ready, by an opaque id and nothing of their servers", () => {
    const ready: MediaIndexStatus = {
      udn: "uuid:nas-1",
      serverName: "Shelf NAS",
      state: "ready",
      strategy: "search",
      tracks: 900,
      albums: 80,
      artists: 40,
      builtAt: 1_700_000_000_000,
      updateId: 7,
      recentList: { title: "Recently Added", chosen: false },
      recentAt: 1_700_000_100_000,
      failure: "a rebuild that didn't finish",
    };
    const building: MediaIndexStatus = {
      ...ready,
      udn: "uuid:usb-2",
      serverName: "Lounge USB",
      state: "building",
      builtAt: null,
    };
    const out = displayIndexes([ready, building]);
    expect(out).toEqual([
      {
        udn: artIdOf("uuid:nas-1"),
        serverName: "",
        state: "ready",
        strategy: null,
        tracks: 0,
        albums: 0,
        artists: 0,
        builtAt: 1_700_000_000_000,
        updateId: null,
        recentAt: 1_700_000_100_000,
      },
    ]);
    const text = JSON.stringify(
      displayPush({ kind: "mediaIndex", statuses: [ready, building] }, art),
    );
    expect(text).not.toMatch(/uuid:|Shelf NAS|Lounge USB|Recently Added|rebuild/);
    // the snapshot a page opens with says the same, so it starts from where the app is
    const opened = displaySnapshot({ ...snap, mediaIndex: [ready, building] }, art);
    expect(opened.mediaIndex).toEqual(out);
    expect(displaySnapshot(snap, art).mediaIndex).toEqual([]);
  });

  it("changes what a page hears of the indexes when one finishes building, so it asks again", () => {
    const at = (state: MediaIndexStatus["state"], builtAt: number | null): MediaIndexStatus => ({
      udn: "uuid:nas-1",
      serverName: "Shelf NAS",
      state,
      strategy: "search",
      tracks: 900,
      albums: 80,
      artists: 40,
      builtAt,
      updateId: 7,
    });
    // building, then ready: the page's ready set gains it; rebuilt: its builtAt moves
    expect(displayIndexes([at("building", null)])).toEqual([]);
    const first = displayIndexes([at("ready", 1)]);
    const again = displayIndexes([at("ready", 2)]);
    expect(first).toHaveLength(1);
    expect(again[0].builtAt).not.toBe(first[0].builtAt);
    expect(again[0].udn).toBe(first[0].udn);
  });

  it("tells a page the waveforms work here, so its strip and seek bar draw them as the window's do", () => {
    expect(displaySettings({ ...DEFAULT_SETTINGS, waveformSeen: true }).waveformSeen).toBe(true);
    expect(displaySettings({ ...DEFAULT_SETTINGS, waveformSeen: false }).waveformSeen).toBe(false);
  });
});

describe("a control line as written", () => {
  it("adds the app's clock to the line as compared, which stays as it was", () => {
    const line = JSON.stringify({ state: "allowed", volume: { percent: 40, step: null } });
    const written = clockedLine(line, 1_700_000_000_000);
    expect(JSON.parse(written)).toEqual({
      state: "allowed",
      volume: { percent: 40, step: null },
      now: 1_700_000_000_000,
    });
    expect(written.startsWith(line.slice(0, -1))).toBe(true);
  });
});
