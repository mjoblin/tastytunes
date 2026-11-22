import { beforeEach, describe, expect, it, vi } from "vitest";

// a stable build (the rc soak can't see what only a stable build does), packaged, its checks on
vi.mock("../../../package.json", () => ({ version: "1.0.0" }));
const updater = vi.hoisted(() => {
  const handlers = new Map<string, (arg?: unknown) => void>();
  return {
    handlers,
    autoUpdater: {
      on: (name: string, fn: (arg?: unknown) => void) => handlers.set(name, fn),
      checkForUpdates: vi.fn<() => Promise<unknown>>(),
      quitAndInstall: vi.fn(),
    },
  };
});
vi.mock("electron-updater", () => ({ default: { autoUpdater: updater.autoUpdater } }));
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => "/tmp" } }));
vi.mock("../data/persist", () => ({ getSettings: () => ({ updateCheck: true }) }));
vi.mock("../netlog", () => ({ noteRequest: vi.fn() }));
vi.mock("./devOverride", () => ({ devOverride: () => undefined }));

const emit = (name: string, arg?: unknown): void => updater.handlers.get(name)?.(arg);

beforeEach(() => {
  vi.resetModules();
  updater.handlers.clear();
});

describe("the updater's errors, on a stable build", () => {
  it("leaves a downloaded update as it is when a later check fails", async () => {
    const { startUpdater, checkUpdatesNow, currentUpdateState } = await import("./updater");
    startUpdater(() => {});
    emit("update-available", { version: "1.0.1" });
    emit("update-downloaded");
    expect(currentUpdateState().phase).toBe("downloaded");
    // electron-updater says a failed check through "error" before its promise rejects
    updater.autoUpdater.checkForUpdates.mockImplementationOnce(() => {
      emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
      return Promise.reject(new Error("net::ERR_INTERNET_DISCONNECTED"));
    });
    checkUpdatesNow();
    await new Promise((r) => setTimeout(r, 0));
    expect(currentUpdateState().phase).toBe("downloaded");
  });

  it("says a failure that arrives after the download with no check in flight (macOS's validation)", async () => {
    const { startUpdater, currentUpdateState } = await import("./updater");
    startUpdater(() => {});
    emit("update-available", { version: "1.0.1" });
    emit("update-downloaded");
    emit("error", new Error("Could not get code signature for running application"));
    expect(currentUpdateState().phase).toBe("error");
  });
});
