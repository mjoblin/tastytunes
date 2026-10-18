import { describe, expect, it } from "vitest";
import { CRASH_MAX_RELOADS, CRASH_WINDOW_MS, reloads, takeReload } from "./crashReload";

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

describe("reloads: only a renderer that failed on its own comes back", () => {
  it("reloads a crash, an out-of-memory and an abnormal exit", () => {
    for (const r of ["crashed", "oom", "abnormal-exit", "launch-failed"])
      expect(reloads(r, false)).toBe(true);
  });

  it("leaves an outside kill and a clean exit alone, and anything while the app quits", () => {
    expect(reloads("killed", false)).toBe(false);
    expect(reloads("clean-exit", false)).toBe(false);
    expect(reloads("crashed", true)).toBe(false);
  });
});
