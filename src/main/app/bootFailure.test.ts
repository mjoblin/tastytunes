import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { quit: vi.fn(), getPath: () => "/tmp" },
  dialog: { showMessageBox: vi.fn(() => Promise.resolve({ response: 2 })) },
  shell: { openExternal: vi.fn(() => Promise.resolve()), showItemInFolder: vi.fn() },
}));
vi.mock("electron", () => ({ default: electron, ...electron }));
const updater = vi.hoisted(() => ({
  updateOffered: vi.fn((): string | null => null),
  updateFromMain: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("./updater", () => updater);
vi.mock("./appLog", () => ({ appLog: () => ({ write: vi.fn() }), revealLog: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  electron.dialog.showMessageBox.mockClear();
  electron.shell.openExternal.mockClear();
  updater.updateFromMain.mockClear();
});

describe("each late start-up step in its own try", () => {
  it("runs the steps after one that throws, and says only the first failure", async () => {
    const { lateStep } = await import("./bootFailure");
    const ran: string[] = [];
    lateStep("one", () => {
      throw new Error("one broke");
    });
    lateStep("two", () => ran.push("two"));
    lateStep("three", () => {
      throw new Error("three broke");
    });
    lateStep("four", () => Promise.reject(new Error("four broke")));
    lateStep("five", () => ran.push("five"));
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toEqual(["two", "five"]);
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    // the running form: the rest of the app stays
    expect(electron.dialog.showMessageBox.mock.calls[0]).toEqual([
      expect.objectContaining({ message: "Part of TastyTunes couldn't start." }),
    ]);
    expect(electron.app.quit).not.toHaveBeenCalled();
  });
});

describe("the window that never came up", () => {
  it("offers the known update itself, and installs it from main", async () => {
    updater.updateOffered.mockReturnValue("1.0.1");
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const { windowStuck } = await import("./bootFailure");
    await windowStuck("never-ready");
    expect(electron.dialog.showMessageBox.mock.calls[0]).toEqual([
      expect.objectContaining({
        message: "The TastyTunes window didn't open.",
        buttons: ["Update and Restart", "Show the Log", "Close"],
      }),
    ]);
    expect(updater.updateFromMain).toHaveBeenCalled();
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
    // once a session
    await windowStuck("stopped");
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("points at the latest version when none is known", async () => {
    updater.updateOffered.mockReturnValue(null);
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const { windowStuck } = await import("./bootFailure");
    await windowStuck("stopped");
    expect(electron.dialog.showMessageBox.mock.calls[0]).toEqual([
      expect.objectContaining({
        message: "The TastyTunes window stopped.",
        buttons: ["Get the Latest Version", "Show the Log", "Close"],
      }),
    ]);
    expect(updater.updateFromMain).not.toHaveBeenCalled();
    expect(electron.shell.openExternal).toHaveBeenCalledWith(
      expect.stringMatching(/\/releases\/latest$/),
    );
  });
});
