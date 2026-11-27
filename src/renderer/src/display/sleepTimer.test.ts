import { describe, expect, it } from "vitest";
import { SLEEP_DURATIONS } from "@shared/model";
import {
  badgeChangesIn,
  SHEET_MARGIN,
  SHEET_WIDTH,
  sheetPlace,
  sleepBadge,
  sleepChoices,
  sleepCountdown,
  sleepThen,
} from "./sleepTimer";

const MIN = 60_000;
const NOW = 1_700_000_000_000;

describe("the moon's badge", () => {
  it("shows the minutes left, rounded up, or the end of the track", () => {
    expect(sleepBadge(NOW + 30 * MIN, NOW)).toBe("30m");
    expect(sleepBadge(NOW + 29 * MIN + 1, NOW)).toBe("30m");
    expect(sleepBadge(NOW + 22 * MIN + 30_000, NOW)).toBe("23m");
    expect(sleepBadge(NOW + 1, NOW)).toBe("1m");
    expect(sleepBadge(NOW - 5_000, NOW)).toBe("0m");
    expect(sleepBadge(null, NOW)).toBe("track");
  });

  it("changes once a minute, at the moment its minutes go down", () => {
    const firesAt = NOW + 22 * MIN + 30_000;
    const wait = badgeChangesIn(firesAt, NOW);
    expect(wait).toBe(30_000);
    expect(sleepBadge(firesAt, NOW + wait - 1)).toBe("23m");
    expect(sleepBadge(firesAt, NOW + wait)).toBe("22m");
    // from there, a whole minute to the next
    expect(badgeChangesIn(firesAt, NOW + wait)).toBe(MIN);
    // never sooner than a moment, never later than a minute, past the end too
    for (const left of [1, 59_999, MIN, MIN + 1, 0, -1, -MIN])
      expect(badgeChangesIn(NOW + left, NOW)).toBeGreaterThan(0);
    for (const left of [1, 59_999, MIN, MIN + 1, 0, -1, -MIN])
      expect(badgeChangesIn(NOW + left, NOW)).toBeLessThanOrEqual(MIN);
  });
});

describe("the sheet", () => {
  it("counts down as the window's timer does, or says End of track", () => {
    expect(sleepCountdown(NOW + 23 * MIN + 10_000, NOW)).toBe("23:10");
    expect(sleepCountdown(NOW + 9_000, NOW)).toBe("0:09");
    expect(sleepCountdown(NOW + 119 * MIN + 59_000, NOW)).toBe("1:59:59");
    expect(sleepCountdown(NOW - 3_000, NOW)).toBe("0:00");
    expect(sleepCountdown(null, NOW)).toBe("End of track");
  });

  it("says what the app will do then, by its own setting", () => {
    expect(sleepThen("standby")).toBe("Then standby, as set in TastyTunes.");
    expect(sleepThen("pause")).toBe("Then pause, as set in TastyTunes.");
  });

  it("offers the window's lengths, and End of track only where it is offered", () => {
    const sleep = { action: "standby" as const, endOfTrack: false, armed: null };
    expect(sleepChoices(sleep)).toEqual(SLEEP_DURATIONS);
    expect(sleepChoices({ ...sleep, endOfTrack: true }).map((c) => c.minutes)).toEqual([
      15,
      30,
      45,
      60,
      90,
      120,
      "track",
    ]);
    expect(sleepChoices({ ...sleep, endOfTrack: true }).at(-1)?.label).toBe("End of track");
  });

  it("sits centered over its button, kept inside the screen's edges", () => {
    // a tablet: over the moon, wherever the row puts it
    expect(sheetPlace(600, 1180)).toEqual({ left: 600 - SHEET_WIDTH / 2, width: SHEET_WIDTH });
    // the moon near the right edge: held SHEET_MARGIN in from it
    expect(sheetPlace(1150, 1180)).toEqual({
      left: 1180 - SHEET_WIDTH - SHEET_MARGIN,
      width: SHEET_WIDTH,
    });
    // and the left
    expect(sheetPlace(40, 1180).left).toBe(SHEET_MARGIN);
    // a phone: narrower, inside both margins
    expect(sheetPlace(300, 360)).toEqual({ left: SHEET_MARGIN, width: 360 - 2 * SHEET_MARGIN });
  });
});
