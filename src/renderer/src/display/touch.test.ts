import { describe, expect, it } from "vitest";
import { SETTLING_MS, swallows } from "./touch";

describe("a touch that only shows the buttons", () => {
  it("is the first touch, wherever it lands", () => {
    expect(swallows(false, 0, true)).toBe(true);
    expect(swallows(false, 10_000, false)).toBe(true);
  });

  it("is a quick second tap on a control still fading in", () => {
    expect(swallows(true, 0, true)).toBe(true);
    expect(swallows(true, SETTLING_MS - 1, true)).toBe(true);
  });

  it("presses a control once it has faded in", () => {
    expect(swallows(true, SETTLING_MS, true)).toBe(false);
    expect(swallows(true, 4_000, true)).toBe(false);
  });

  it("leaves a quick tap away from the controls to put them away", () => {
    expect(swallows(true, 100, false)).toBe(false);
  });
});
