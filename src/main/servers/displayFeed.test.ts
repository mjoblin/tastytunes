import { describe, expect, it } from "vitest";
import type { Snapshot } from "@shared/ipc";
import { DEFAULT_SETTINGS } from "@shared/model";
import {
  artIdOf,
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

  it("carries Display's own settings and the look, the rest at their defaults, the scene the Sleeve", () => {
    const s = displaySettings(snap.settings);
    expect(s.displayLyrics).toBe(false);
    expect(s.theme).toBe("light");
    expect(s.displayScene).toBe("sleeve");
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
});
