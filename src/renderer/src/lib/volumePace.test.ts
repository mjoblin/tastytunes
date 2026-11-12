import { describe, expect, it } from "vitest";
import { VOLUME_REPEAT_MS, raisePace } from "./volumePace";

describe("raisePace", () => {
  it("lets a held raise step once per interval, however fast the key repeats", () => {
    const pace = raisePace();
    const steps = Array.from({ length: 12 }, (_, i) => pace(i > 0, true, 1000 + i * 33));
    // 12 repeats over 363 ms: the first press, then the one past 200 ms
    expect(steps.filter(Boolean)).toHaveLength(2);
    expect(pace(true, true, 1000 + 11 * 33 + VOLUME_REPEAT_MS)).toBe(true);
  });

  it("never paces a lowering", () => {
    const pace = raisePace();
    expect(pace(false, true, 1000)).toBe(true);
    const downs = Array.from({ length: 12 }, (_, i) => pace(true, false, 1001 + i));
    expect(downs.every(Boolean)).toBe(true);
  });

  it("always lets a fresh press through", () => {
    const pace = raisePace();
    expect(pace(false, true, 1000)).toBe(true);
    expect(pace(false, true, 1010)).toBe(true);
    expect(pace(true, true, 1020)).toBe(false);
  });
});
