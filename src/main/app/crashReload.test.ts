import { describe, expect, it } from "vitest";
import { CRASH_MAX_RELOADS, CRASH_WINDOW_MS, takeReload } from "./crashReload";

describe("takeReload: a dead renderer reloads, but never in a loop", () => {
  it("allows three reloads in a minute and refuses the fourth", () => {
    const times: number[] = [];
    const t0 = 1_000_000;
    for (let i = 0; i < CRASH_MAX_RELOADS; i++) expect(takeReload(times, t0 + i * 1000)).toBe(true);
    expect(takeReload(times, t0 + 5000)).toBe(false);
    expect(times).toHaveLength(CRASH_MAX_RELOADS);
  });

  it("allows another once the oldest reload is more than a minute old", () => {
    const times = [0, 10_000, 20_000];
    expect(takeReload(times, CRASH_WINDOW_MS + 1)).toBe(true);
    expect(times).toEqual([10_000, 20_000, CRASH_WINDOW_MS + 1]);
  });
});
