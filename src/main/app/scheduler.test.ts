/**
 * Catch-up on resume: which missed schedule a wake offers (pickCatchUp).
 *
 * The three rules are the user's decisions (a 10-minute window, a turn-off is
 * never caught up, only the latest miss is offered), and each is a one-line
 * edit away from being silently inverted. The clock is synthetic: a schedule
 * due at 07:00 today, the machine asleep from just before it.
 *
 * Then the tick and the offer on a fake clock, over a device manager that
 * holds only its connection and the log, and another streamer reached on a
 * background connection that answers when the test says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schedule } from "@shared/model";

const sys = vi.hoisted(() => ({
  settings: {
    schedules: [] as unknown[],
    knownDevices: [] as Array<{ udn: string; host: string }>,
    lastHost: null as string | null,
  },
}));
/** Another streamer's background connection: ready() waits for answer() once held. */
const other = vi.hoisted(() => {
  let open: (ok: boolean) => void = () => {};
  let answered = Promise.resolve(true);
  return {
    hold: (): void => {
      answered = new Promise((r) => (open = r));
    },
    answer: (ok: boolean): void => open(ok),
    remote: {
      ready: () => answered,
      cache: { playState: null, presets: null },
      command: vi.fn(async () => {}),
      preAmpVolume: () => null,
      fadeInTo: async () => {},
    },
  };
});
vi.mock("electron", () => ({ Notification: { isSupported: () => false } }));
vi.mock("../data/persist", () => ({ getSettings: () => sys.settings }));
vi.mock("../device/remoteStreamer", () => ({
  remoteStreamers: { get: () => other.remote, forget: () => {} },
}));

import {
  CATCH_UP_WINDOW_MS,
  catchUpOnResume,
  noteSuspend,
  pickCatchUp,
  startScheduler,
} from "./scheduler";

const DAYS = [0, 1, 2, 3, 4, 5, 6];

const at = (h: number, m: number): number => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

const sched = (o: Partial<Schedule> = {}): Schedule => ({
  id: "a",
  enabled: true,
  time: "07:00",
  days: DAYS,
  action: "on",
  presetId: 1,
  volumePercent: 25,
  ...o,
});

/** Woken at 07:nowM, asleep since 06:sleptM. */
const pick = (list: Schedule[], nowM: number, sleptM: number) =>
  pickCatchUp(list, { now: at(7, nowM), sleptAt: at(6, sleptM) });

describe("pickCatchUp", () => {
  it("has a 10-minute window", () => {
    expect(CATCH_UP_WINDOW_MS).toBe(600_000);
  });

  it("offers a miss inside the window", () => {
    expect(pick([sched()], 4, 55)).not.toBeNull();
  });

  it("does not offer a miss past the window", () => {
    expect(pick([sched()], 11, 55)).toBeNull();
  });

  it("never offers a missed turn-off", () => {
    expect(pick([sched({ action: "standby" })], 4, 55)).toBeNull();
  });

  it("collapses two misses to the latest", () => {
    const early = sched({ id: "early" });
    const late = sched({ id: "late", time: "07:05" });
    expect(pick([early, late], 6, 55)?.schedule.id).toBe("late");
  });

  it("does not catch up a miss from before the sleep", () => {
    expect(pickCatchUp([sched()], { now: at(7, 4), sleptAt: at(7, 2) })).toBeNull();
  });
});

/** A moment on one fixed day, for the fake clock. */
const on = (h: number, m: number, sec = 0): number => new Date(2026, 0, 5, h, m, sec).getTime();

/** The window's device manager: its connection, its streamer's udn, and what it was told. */
function windowDm(phase: "connected" | "connecting") {
  return {
    connectionNow: { phase } as { phase: string },
    snapshot: () => ({ systemInfo: { udn: "window-udn" }, devices: [] }),
    streamerNow: { playState: null, presets: null },
    discover: async () => {},
    log: vi.fn(),
    setMissedSchedule: vi.fn(),
    command: vi.fn(async () => {}),
    preAmpVolume: () => null,
    fadeInTo: async () => {},
  };
}

describe("the tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(on(7, 0, 5));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("says in the log when the window's streamer wasn't connected all through the minute", async () => {
    sys.settings.schedules = [sched({ id: "dark" })];
    const dm = windowDm("connecting");
    startScheduler(dm as never);
    // the first check at 07:00:08, then every 15 s: each in the minute waits for the connection
    await vi.advanceTimersByTimeAsync(45_000);
    expect(dm.log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(dm.log).toHaveBeenCalledWith(
      "warn",
      "schedule",
      "the streamer wasn't connected: the schedule at 07:00 didn't run",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dm.log).toHaveBeenCalledTimes(1);
    expect(dm.command).not.toHaveBeenCalled();
  });

  it("says nothing when the streamer comes back within the minute and the schedule runs", async () => {
    sys.settings.schedules = [sched({ id: "back" })];
    const dm = windowDm("connecting");
    startScheduler(dm as never);
    await vi.advanceTimersByTimeAsync(3_000);
    dm.connectionNow = { phase: "connected" };
    await vi.advanceTimersByTimeAsync(12_000);
    expect(dm.command).toHaveBeenCalledWith({ type: "power", power: "ON" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dm.log).not.toHaveBeenCalled();
  });
});

describe("the offer after a wake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    other.remote.command.mockClear();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("is the only answer to another streamer's schedule, though the tick comes while it reaches it", async () => {
    // woken at 07:00:05, inside the minute of a schedule for another streamer
    vi.setSystemTime(on(7, 0, 5));
    sys.settings.schedules = [
      sched({ id: "kitchen", streamer: { udn: "kitchen-udn", name: "Kitchen" } }),
    ];
    sys.settings.knownDevices = [{ udn: "kitchen-udn", host: "10.0.0.9" }];
    const dm = windowDm("connected");
    noteSuspend(on(6, 55));
    other.hold();
    startScheduler(dm as never);
    catchUpOnResume(dm as never);
    // the offer picks the schedule at 07:00:07 and waits on Kitchen; the tick comes at 07:00:08
    await vi.advanceTimersByTimeAsync(3_000);
    other.answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(dm.setMissedSchedule).toHaveBeenCalledWith({
      scheduleId: "kitchen",
      dueAt: on(7, 0),
    });
    expect(other.remote.command).not.toHaveBeenCalled();
  });

  it("says in the log when the window's streamer doesn't reconnect in time to offer", async () => {
    vi.setSystemTime(on(7, 4));
    sys.settings.schedules = [sched({ id: "late" })];
    const dm = windowDm("connecting");
    noteSuspend(on(6, 55));
    catchUpOnResume(dm as never);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dm.log).toHaveBeenCalledWith(
      "warn",
      "schedule",
      "the streamer didn't reconnect after the wake: the missed schedule at 07:00 wasn't offered",
    );
    expect(dm.setMissedSchedule).not.toHaveBeenCalled();
  });
});
