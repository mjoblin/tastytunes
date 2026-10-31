/**
 * Catch-up on resume: which missed schedule a wake offers (pickCatchUp).
 *
 * The three rules are the user's decisions (a 10-minute window, a turn-off is
 * never caught up, only the latest miss is offered), and each is a one-line
 * edit away from being silently inverted. The clock is synthetic: a schedule
 * due at 07:00 today, the machine asleep from just before it.
 */
import { describe, expect, it } from "vitest";
import type { Schedule } from "@shared/model";
import { CATCH_UP_WINDOW_MS, pickCatchUp } from "./scheduler";

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
