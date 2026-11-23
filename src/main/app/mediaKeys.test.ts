/**
 * The media keys: on a Mac without the Accessibility permission they can't be bound, and the state
 * says so; once the permission is there they are bound again on the next look; the permission is
 * only ever checked, never asked for (asking shows a system dialog).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sys = vi.hoisted(() => ({
  trusted: false,
  takes: true,
  settings: { mediaKeys: true },
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
  sys.settings = { mediaKeys: true };
  // as macOS does: without the permission the media keys don't register
  electron.globalShortcut.register.mockImplementation(
    () => sys.takes && (process.platform !== "darwin" || sys.trusted),
  );
  electron.systemPreferences.isTrustedAccessibilityClient.mockImplementation(() => sys.trusted);
});
afterEach(() => {
  onSystem(realPlatform);
  vi.clearAllMocks();
});

describe("the media keys on a Mac", () => {
  it("say they need the permission, and bind once it is there", () => {
    onSystem("darwin");
    syncMediaKeys();
    expect(mediaKeysState()).toEqual({ on: true, bound: false, needsPermission: true });
    // still not granted: no second try
    electron.globalShortcut.register.mockClear();
    refreshMediaKeys();
    expect(electron.globalShortcut.register).not.toHaveBeenCalled();
    sys.trusted = true;
    expect(refreshMediaKeys()).toEqual({ on: true, bound: true, needsPermission: false });
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
    expect(mediaKeysState()).toEqual({ on: true, bound: true, needsPermission: false });
    expect(electron.systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalled();
  });

  it("say they're unbound, with no permission to give, when another app holds them", () => {
    onSystem("win32");
    sys.takes = false;
    syncMediaKeys();
    expect(mediaKeysState()).toEqual({ on: true, bound: false, needsPermission: false });
  });

  it("are neither bound nor wanted when the setting is off", () => {
    onSystem("darwin");
    sys.settings = { mediaKeys: false };
    syncMediaKeys();
    expect(electron.globalShortcut.register).not.toHaveBeenCalled();
    expect(refreshMediaKeys()).toEqual({ on: false, bound: false, needsPermission: false });
  });
});
