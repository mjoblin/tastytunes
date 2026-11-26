/**
 * The media keys: on a Mac without the Accessibility permission they can't be bound, and the state
 * says so; once the permission is there they are bound again on the next look; the permission is
 * only ever checked, never asked for (asking shows a system dialog). With the system's Now Playing
 * the helper carries them while it is up, the shortcuts otherwise, never both and never twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sys = vi.hoisted(() => ({
  trusted: false,
  takes: true,
  settings: { mediaKeys: true },
  helper: false,
  /** The helper has said hello and not gone down since. */
  up: false,
  /** The keys bound now, and how often one was bound while already bound. */
  held: new Set<string>(),
  twice: 0,
}));
const electron = vi.hoisted(() => ({
  app: { on: vi.fn() },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  systemPreferences: { isTrustedAccessibilityClient: vi.fn() },
}));
vi.mock("electron", () => electron);
vi.mock("../data/persist", () => ({ getSettings: () => sys.settings }));
vi.mock("./runtime", () => ({ deviceManager: { fire: vi.fn() } }));
const np = vi.hoisted(() => ({ sync: vi.fn(), running: vi.fn() }));
vi.mock("./nowPlaying", () => ({ syncNowPlaying: np.sync, nowPlayingRunning: np.running }));

import {
  mediaKeysState,
  openAccessibilitySettings,
  refreshMediaKeys,
  syncMediaKeys,
} from "./mediaKeys";

const realPlatform = process.platform;
const onSystem = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", { value: platform });
};

beforeEach(() => {
  sys.trusted = false;
  sys.takes = true;
  sys.helper = false;
  sys.up = false;
  sys.twice = 0;
  np.sync.mockImplementation(() => sys.helper);
  np.running.mockImplementation(() => sys.helper && sys.up);
  // as macOS does: without the permission the media keys don't register
  electron.globalShortcut.register.mockImplementation((accelerator: string) => {
    if (!(sys.takes && (process.platform !== "darwin" || sys.trusted))) return false;
    if (sys.held.has(accelerator)) sys.twice++;
    sys.held.add(accelerator);
    return true;
  });
  electron.globalShortcut.unregisterAll.mockImplementation(() => sys.held.clear());
  electron.systemPreferences.isTrustedAccessibilityClient.mockImplementation(() => sys.trusted);
  // each test starts with nothing bound: the setting off lets every key go
  sys.settings = { mediaKeys: false };
  syncMediaKeys();
  sys.settings = { mediaKeys: true };
  vi.clearAllMocks();
});
afterEach(() => {
  onSystem(realPlatform);
  vi.clearAllMocks();
});

describe("the media keys on a Mac", () => {
  it("say they need the permission, and bind once it is there", () => {
    onSystem("darwin");
    syncMediaKeys();
    expect(mediaKeysState()).toEqual({
      on: true,
      bound: false,
      needsPermission: true,
      system: false,
    });
    // still not granted: no second try
    electron.globalShortcut.register.mockClear();
    refreshMediaKeys();
    expect(electron.globalShortcut.register).not.toHaveBeenCalled();
    sys.trusted = true;
    expect(refreshMediaKeys()).toEqual({
      on: true,
      bound: true,
      needsPermission: false,
      system: false,
    });
  });

  it("only ever check the permission, never ask for it", () => {
    onSystem("darwin");
    syncMediaKeys();
    refreshMediaKeys();
    mediaKeysState();
    const asks = electron.systemPreferences.isTrustedAccessibilityClient.mock.calls;
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every(([prompt]) => prompt === false)).toBe(true);
  });

  it("open System Settings' Accessibility pane", async () => {
    onSystem("darwin");
    await openAccessibilitySettings();
    expect(electron.shell.openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
  });
});

describe("a media key pressed", () => {
  it("goes out through fire(), which logs a failure", async () => {
    onSystem("win32");
    syncMediaKeys();
    const playPause = electron.globalShortcut.register.mock.calls.find(
      ([accelerator]) => accelerator === "MediaPlayPause",
    );
    (playPause?.[1] as () => void)();
    const { deviceManager } = await import("./runtime");
    expect(deviceManager.fire).toHaveBeenCalledWith({ type: "togglePlayback" });
  });
});

describe("the media keys elsewhere", () => {
  it("bind without asking anything", () => {
    onSystem("win32");
    syncMediaKeys();
    expect(mediaKeysState()).toEqual({
      on: true,
      bound: true,
      needsPermission: false,
      system: false,
    });
    expect(electron.systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalled();
  });

  it("say they're unbound, with no permission to give, when another app holds them", () => {
    onSystem("win32");
    sys.takes = false;
    syncMediaKeys();
    expect(mediaKeysState()).toEqual({
      on: true,
      bound: false,
      needsPermission: false,
      system: false,
    });
  });

  it("are neither bound nor wanted when the setting is off", () => {
    onSystem("darwin");
    sys.settings = { mediaKeys: false };
    syncMediaKeys();
    expect(electron.globalShortcut.register).not.toHaveBeenCalled();
    expect(refreshMediaKeys()).toEqual({
      on: false,
      bound: false,
      needsPermission: false,
      system: false,
    });
  });
});

describe("the media keys through the Mac's Now Playing", () => {
  it("bind no shortcut and want no permission when the helper carries them", () => {
    onSystem("darwin");
    sys.helper = true;
    sys.up = true;
    syncMediaKeys();
    expect(electron.globalShortcut.register).not.toHaveBeenCalled();
    expect(np.sync).toHaveBeenCalledWith(true, expect.any(Function));
    expect(mediaKeysState()).toEqual({
      on: true,
      bound: true,
      needsPermission: false,
      system: true,
    });
    expect(electron.systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalled();
  });

  it("stop the helper when the setting is off", () => {
    onSystem("darwin");
    sys.helper = true;
    sys.settings = { mediaKeys: false };
    syncMediaKeys();
    expect(np.sync).toHaveBeenCalledWith(false, expect.any(Function));
    expect(mediaKeysState()).toMatchObject({ on: false, bound: false, system: true });
  });

  it("go back to the shortcuts when the helper is given up on (it couldn't run here)", () => {
    onSystem("win32");
    sys.helper = true;
    sys.up = true;
    syncMediaKeys();
    expect(electron.globalShortcut.register).not.toHaveBeenCalled();
    const gaveUp = np.sync.mock.calls[0][1] as () => void;
    // given up: the helper no longer carries the keys
    sys.helper = false;
    gaveUp();
    expect(electron.globalShortcut.register).toHaveBeenCalled();
    expect(mediaKeysState()).toEqual({
      on: true,
      bound: true,
      needsPermission: false,
      system: false,
    });
  });

  it("hold the keys with the shortcuts until the helper says hello, and again while it is down", () => {
    onSystem("win32");
    sys.helper = true;
    syncMediaKeys();
    const moved = np.sync.mock.calls[0][1] as () => void;
    // started, not yet up: the shortcuts hold the keys
    expect([...sys.held].sort()).toEqual([
      "MediaNextTrack",
      "MediaPlayPause",
      "MediaPreviousTrack",
      "MediaStop",
    ]);
    expect(mediaKeysState()).toEqual({
      on: true,
      bound: true,
      needsPermission: false,
      system: true,
    });
    // its hello: let go, before it claims anything
    sys.up = true;
    moved();
    expect(sys.held.size).toBe(0);
    expect(mediaKeysState()).toEqual({
      on: true,
      bound: true,
      needsPermission: false,
      system: true,
    });
    // it exits: the shortcuts take the keys back until the restart's hello
    sys.up = false;
    moved();
    expect(sys.held.size).toBe(4);
    sys.up = true;
    moved();
    expect(sys.held.size).toBe(0);
    expect(sys.twice).toBe(0);
  });

  it("never bind a key twice while the helper is down, nor when it is given up on", () => {
    onSystem("win32");
    sys.helper = true;
    syncMediaKeys();
    const moved = np.sync.mock.calls[0][1] as () => void;
    // the setting saved again, and the window brought forward, while the helper starts
    syncMediaKeys();
    refreshMediaKeys();
    // given up after it never said hello: the shortcuts already hold the keys
    sys.helper = false;
    moved();
    expect(electron.globalShortcut.register).toHaveBeenCalledTimes(4);
    expect(sys.held.size).toBe(4);
    expect(sys.twice).toBe(0);
    expect(mediaKeysState()).toEqual({
      on: true,
      bound: true,
      needsPermission: false,
      system: false,
    });
  });

  it("try the shortcuts on a Mac while the helper starts, and want no permission for them", () => {
    onSystem("darwin");
    sys.helper = true;
    syncMediaKeys();
    expect(electron.globalShortcut.register).toHaveBeenCalled();
    expect(mediaKeysState()).toEqual({
      on: true,
      bound: false,
      needsPermission: false,
      system: true,
    });
    const asks = electron.systemPreferences.isTrustedAccessibilityClient.mock.calls;
    expect(asks.every(([prompt]) => prompt === false)).toBe(true);
  });
});
