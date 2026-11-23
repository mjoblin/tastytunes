/**
 * A link that launches the app: its verb waits for the connection AND for the streamer's power and
 * play state (an ON sent before the power frame can't see the streamer is already on), and a verb
 * that throws or is refused says so as a notice, never as an unhandled rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shown = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  Notification: class {
    static isSupported(): boolean {
      return true;
    }
    constructor(private readonly opts: { body: string }) {}
    show(): void {
      shown.notices.push(this.opts.body);
    }
  },
}));

interface FakeDm {
  connection: { phase: string; host?: string };
  cache: Record<string, unknown>;
}
const dm = vi.hoisted(() => ({
  ...({ connection: { phase: "idle" }, cache: {} } as FakeDm),
  command: vi.fn(() => Promise.resolve()),
  log: vi.fn(),
}));
vi.mock("./runtime", () => ({
  deviceManager: {
    get connectionNow() {
      return dm.connection;
    },
    get streamerNow() {
      return dm.cache;
    },
    command: dm.command,
    log: dm.log,
  },
}));

const inbox = vi.hoisted(() => ({ take: null as null | ((url: string, stole: boolean) => void) }));
vi.mock("./urlInbox", () => ({
  onUrl: (take: (url: string, stole: boolean) => void) => {
    inbox.take = take;
  },
  giveFocusBack: vi.fn(),
}));
vi.mock("./windows", () => ({
  sendMenuCommand: vi.fn(),
  showMainWindow: vi.fn(),
  toggleMiniPlayer: vi.fn(),
}));

import { serveUrlActions } from "./urlActions";

const open = (url: string): void => inbox.take?.(url, false);

describe("a link's verb on a cold start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shown.notices = [];
    dm.connection = { phase: "idle" };
    dm.cache = {};
    dm.command.mockClear();
    serveUrlActions();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits past the socket's opening for the streamer's power and play state", async () => {
    open("tastytunes://power/on");
    await vi.advanceTimersByTimeAsync(1_000);
    dm.connection = { phase: "connected", host: "10.0.0.5" };
    await vi.advanceTimersByTimeAsync(1_000);
    // connected, but the power frame hasn't come: nothing sent yet
    expect(dm.command).not.toHaveBeenCalled();
    dm.cache = { systemPower: { power: "ON" }, playState: { state: "play" } };
    await vi.advanceTimersByTimeAsync(500);
    expect(dm.command).toHaveBeenCalledWith({ type: "power", power: "ON" });
  });

  it("goes ahead once the wait is up when a model never sends its power", async () => {
    dm.connection = { phase: "connected", host: "10.0.0.5" };
    open("tastytunes://toggle-play");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dm.command).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dm.command).toHaveBeenCalledTimes(1);
  });

  it("refuses a bare screen link with its reason", async () => {
    open("tastytunes://screen");
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.notices).toEqual(["Screen takes the name of a screen, such as Queue."]);
  });

  it("turns a verb that throws into a notice", async () => {
    dm.connection = { phase: "connected", host: "10.0.0.5" };
    dm.cache = { systemPower: { power: "ON" }, playState: { state: "play" } };
    Object.defineProperty(dm.cache, "zoneState", {
      get() {
        throw new Error("boom");
      },
    });
    open("tastytunes://toggle-mute");
    await vi.advanceTimersByTimeAsync(500);
    expect(shown.notices).toEqual(["Couldn't run that TastyTunes link."]);
  });
});
