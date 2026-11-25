/**
 * Open at login: offered on macOS and Windows and not on Linux; registered by the installed app
 * only; read from the system, so a Windows item Task Manager turned off reads off and a macOS item
 * waiting for approval reads on with the approval asked for; a launch at login known by its
 * argument (Windows) or by macOS itself; such a launch starts in the tray only when the menu bar
 * icon is there; and under the suite's flag a stand-in, never the system's item.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: () => "/tmp",
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
    setAppUserModelId: vi.fn(),
  },
}));
vi.mock("electron", () => ({ default: electron, app: electron.app }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adoptAppIdentity,
  APP_USER_MODEL_ID,
  LEGACY_LOGIN_NAME,
  LOGIN_ARG,
  loginItemState,
  openedAtLogin,
  setOpenAtLogin,
  startsInTray,
} from "./loginItem";

const realPlatform = process.platform;
const onSystem = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", { value: platform });
};
afterEach(() => {
  onSystem(realPlatform);
  electron.app.isPackaged = false;
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("where it is offered", () => {
  it("is not offered on Linux", () => {
    onSystem("linux");
    electron.app.isPackaged = true;
    expect(loginItemState().available).toBe("no");
    setOpenAtLogin(true);
    expect(electron.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("is shown but never registered from a development run", () => {
    for (const platform of ["darwin", "win32"] as const) {
      onSystem(platform);
      expect(loginItemState()).toEqual({
        available: "installed-only",
        on: false,
        needsApproval: false,
      });
      setOpenAtLogin(true);
    }
    expect(electron.app.setLoginItemSettings).not.toHaveBeenCalled();
  });
});

describe("Windows", () => {
  it("reads on only when the item is there and Task Manager has not turned it off", () => {
    onSystem("win32");
    electron.app.isPackaged = true;
    electron.app.getLoginItemSettings.mockReturnValue({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
    });
    expect(loginItemState().on).toBe(true);
    expect(electron.app.getLoginItemSettings).toHaveBeenCalledWith({ args: [LOGIN_ARG] });
    electron.app.getLoginItemSettings.mockReturnValue({
      openAtLogin: true,
      executableWillLaunchAtLogin: false,
    });
    expect(loginItemState().on).toBe(false);
  });

  it("registers with its argument, and turns a Task Manager switch back on", () => {
    onSystem("win32");
    electron.app.isPackaged = true;
    electron.app.getLoginItemSettings.mockReturnValue({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
    });
    setOpenAtLogin(true);
    expect(electron.app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: [LOGIN_ARG],
      enabled: true,
    });
  });
});

describe("macOS", () => {
  it("reads an item waiting for approval as on, with the approval asked for", () => {
    onSystem("darwin");
    electron.app.isPackaged = true;
    electron.app.getLoginItemSettings.mockReturnValue({
      openAtLogin: false,
      status: "requires-approval",
    });
    expect(loginItemState()).toEqual({ available: "yes", on: true, needsApproval: true });
    electron.app.getLoginItemSettings.mockReturnValue({ openAtLogin: true, status: "enabled" });
    expect(loginItemState()).toEqual({ available: "yes", on: true, needsApproval: false });
    electron.app.getLoginItemSettings.mockReturnValue({
      openAtLogin: false,
      status: "not-registered",
    });
    expect(loginItemState().on).toBe(false);
  });

  it("registers through the system's own call", () => {
    onSystem("darwin");
    electron.app.isPackaged = true;
    electron.app.getLoginItemSettings.mockReturnValue({
      openAtLogin: false,
      status: "not-registered",
    });
    setOpenAtLogin(false);
    expect(electron.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
  });
});

describe("a launch at login", () => {
  it("is known by its argument on any system", () => {
    onSystem("win32");
    expect(openedAtLogin(["TastyTunes.exe", LOGIN_ARG])).toBe(true);
    expect(openedAtLogin(["TastyTunes.exe"])).toBe(false);
  });

  it("is known by macOS itself in the installed app", () => {
    onSystem("darwin");
    electron.app.isPackaged = true;
    electron.app.getLoginItemSettings.mockReturnValue({ wasOpenedAtLogin: true });
    expect(openedAtLogin(["TastyTunes"])).toBe(true);
    electron.app.isPackaged = false;
    expect(openedAtLogin(["Electron"])).toBe(false);
  });

  it("starts in the tray only when the menu bar icon is there", () => {
    expect(startsInTray(true, true)).toBe(true);
    expect(startsInTray(true, false)).toBe(false);
    expect(startsInTray(false, true)).toBe(false);
    expect(startsInTray(false, false)).toBe(false);
  });
});

describe("under the suite's flag", () => {
  it("keeps a stand-in and never touches the system's item", async () => {
    vi.stubEnv("TASTYTUNES_LOGIN_ITEM_TEST", "1");
    vi.resetModules();
    const fresh = await import("./loginItem");
    expect(fresh.loginItemState()).toEqual({ available: "yes", on: false, needsApproval: false });
    expect(fresh.setOpenAtLogin(true).on).toBe(true);
    expect(fresh.loginItemState().on).toBe(true);
    expect(electron.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(electron.app.getLoginItemSettings).not.toHaveBeenCalled();
  });
});

describe("the app's identity on Windows", () => {
  it("is the appId the installer gives its shortcuts", () => {
    const yml = readFileSync(join(__dirname, "../../../electron-builder.yml"), "utf8");
    expect(yml).toMatch(new RegExp(`^appId: ${APP_USER_MODEL_ID.replace(/\./g, "\\.")}$`, "m"));
    expect(LEGACY_LOGIN_NAME).toBe("electron.app.TastyTunes");
  });

  it("is set on Windows only", () => {
    onSystem("darwin");
    adoptAppIdentity();
    expect(electron.app.setAppUserModelId).not.toHaveBeenCalled();
    onSystem("win32");
    adoptAppIdentity();
    expect(electron.app.setAppUserModelId).toHaveBeenCalledWith(APP_USER_MODEL_ID);
  });

  it("moves a login item written under the old name, read before the identity changes", () => {
    onSystem("win32");
    electron.app.isPackaged = true;
    const order: string[] = [];
    electron.app.getLoginItemSettings.mockImplementation(() => {
      order.push("read");
      return { openAtLogin: true, executableWillLaunchAtLogin: false };
    });
    electron.app.setAppUserModelId.mockImplementation(() => order.push("identity"));
    adoptAppIdentity();
    expect(order).toEqual(["read", "identity"]);
    expect(electron.app.setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: false, name: LEGACY_LOGIN_NAME, args: [LOGIN_ARG] }],
      // Task Manager had turned it off: it stays off under the new name
      [{ openAtLogin: true, args: [LOGIN_ARG], enabled: false }],
    ]);
  });

  it("writes nothing when there was no login item, or in a development run", () => {
    onSystem("win32");
    electron.app.isPackaged = true;
    electron.app.getLoginItemSettings.mockReturnValue({ openAtLogin: false });
    adoptAppIdentity();
    electron.app.isPackaged = false;
    adoptAppIdentity();
    expect(electron.app.setLoginItemSettings).not.toHaveBeenCalled();
  });
});
