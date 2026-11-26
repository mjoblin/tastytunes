import { describe, expect, it } from "vitest";
import { SETTLING_MS, keptWhole, lapsed, swallows } from "./touch";

describe("a touch that only shows the buttons", () => {
  it("is the first touch, wherever it lands", () => {
    expect(swallows(false, 0, true, true)).toBe(true);
    expect(swallows(false, 10_000, false, true)).toBe(true);
  });

  it("is a quick second tap on a control still fading in", () => {
    expect(swallows(true, 0, true, true)).toBe(true);
    expect(swallows(true, SETTLING_MS - 1, true, true)).toBe(true);
  });

  it("presses a control once it has faded in", () => {
    expect(swallows(true, SETTLING_MS, true, true)).toBe(false);
    expect(swallows(true, 4_000, true, true)).toBe(false);
  });

  it("leaves a quick tap away from the controls to put them away", () => {
    expect(swallows(true, 100, false, true)).toBe(false);
  });

  it("never swallows a mouse's click on a control it could see, however soon", () => {
    expect(swallows(true, 0, true, false)).toBe(false);
    expect(swallows(true, SETTLING_MS - 1, true, false)).toBe(false);
  });
});

describe("a swallowed press on the seek bar", () => {
  // the bar seeks on the finger's lift, not its click: a quick second tap is kept from it whole
  it("never starts a seek while the bar is still fading in", () => {
    expect(keptWhole(swallows(true, 0, true, true), true)).toBe(true);
    expect(keptWhole(swallows(true, SETTLING_MS - 1, true, true), true)).toBe(true);
  });

  it("seeks once the bar has faded in", () => {
    expect(keptWhole(swallows(true, SETTLING_MS, true, true), true)).toBe(false);
  });

  it("never keeps a mouse's press from the bar, however soon", () => {
    expect(keptWhole(swallows(true, 0, true, false), true)).toBe(false);
  });

  it("keeps only the click from a control that acts on its click", () => {
    expect(keptWhole(swallows(true, 0, true, true), false)).toBe(false);
  });
});

describe("a minute with nobody at the screen", () => {
  it("closes a panel or a list left open, a finger down or not", () => {
    expect(lapsed(true, false)).toBe("close");
    expect(lapsed(true, true)).toBe("close");
  });

  it("lets the buttons go after a finger whose lift never came, with nothing open", () => {
    expect(lapsed(false, true)).toBe("hide");
  });

  it("has nothing to let go of otherwise", () => {
    expect(lapsed(false, false)).toBeNull();
  });
});
