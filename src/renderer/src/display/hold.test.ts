import { afterEach, describe, expect, it, vi } from "vitest";
import { holdPress, STANDBY_HOLD_MS } from "./hold";

afterEach(() => {
  vi.useRealTimers();
});

function rig() {
  vi.useFakeTimers();
  const said: string[] = [];
  const press = holdPress(STANDBY_HOLD_MS, {
    held: () => said.push("held"),
    short: () => said.push("short"),
  });
  return { press, said };
}

describe("a press held for standby", () => {
  it("acts once, when it has lasted the hold", () => {
    const { press, said } = rig();
    press.down();
    vi.advanceTimersByTime(STANDBY_HOLD_MS - 1);
    expect(said).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(["held"]);
    // the lift after it, and a leave after that, add nothing
    press.end();
    press.end();
    vi.advanceTimersByTime(STANDBY_HOLD_MS * 2);
    expect(said).toEqual(["held"]);
  });

  it("never acts on a tap: a press that ends first is short, and nothing follows", () => {
    const { press, said } = rig();
    press.down();
    vi.advanceTimersByTime(120);
    press.end();
    vi.advanceTimersByTime(STANDBY_HOLD_MS * 2);
    expect(said).toEqual(["short"]);
  });

  it("is short once, however the press ends (a leave, then its lift)", () => {
    const { press, said } = rig();
    press.down();
    vi.advanceTimersByTime(STANDBY_HOLD_MS - 1);
    press.end();
    press.end();
    expect(said).toEqual(["short"]);
  });

  it("starts the hold again at each press", () => {
    const { press, said } = rig();
    press.down();
    vi.advanceTimersByTime(STANDBY_HOLD_MS - 100);
    press.end();
    press.down();
    vi.advanceTimersByTime(STANDBY_HOLD_MS - 1);
    expect(said).toEqual(["short"]);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(["short", "held"]);
  });

  it("says nothing once let go", () => {
    const { press, said } = rig();
    press.down();
    press.stop();
    vi.advanceTimersByTime(STANDBY_HOLD_MS * 2);
    press.end();
    expect(said).toEqual([]);
  });

  it("an end with no press is nothing", () => {
    const { press, said } = rig();
    press.end();
    expect(said).toEqual([]);
  });
});
