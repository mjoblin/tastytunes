import { describe, expect, it } from "vitest";
import type { DisplayScreen } from "@shared/displayControl";
import { isStoredScreen, MAX_SCREENS_KEPT, NOT_NOW_MS, ScreenBook } from "./displayScreens";

const A = "a".repeat(32);
const B = "b".repeat(32);

function book() {
  let stored: DisplayScreen[] = [];
  let now = 1_000;
  let changes = 0;
  const b = new ScreenBook({
    load: () => stored,
    save: (s) => (stored = s),
    now: () => now,
    changed: () => changes++,
  });
  return {
    b,
    stored: () => stored,
    changes: () => changes,
    later: (ms: number) => (now += ms),
  };
}

describe("the screens that may control", () => {
  it("is off for every screen while the switch is off", () => {
    const { b } = book();
    expect(b.stateOf(A, false)).toBe("off");
    expect(b.ask(A, "iPad · Safari", false)).toBe("off");
    expect(b.list().asking).toBeNull();
  });

  it("asks once for a screen's first tap, and keeps the answer by its id", () => {
    const { b, stored, changes } = book();
    expect(b.stateOf(A, true)).toBe("ask");
    expect(b.ask(A, "iPad · Safari", true)).toBe("asking");
    expect(b.ask(A, "iPad · Safari", true)).toBe("asking");
    expect(changes()).toBe(1);
    expect(b.list().asking).toMatchObject({ id: A, name: "iPad · Safari" });
    b.answer(A, true);
    expect(b.stateOf(A, true)).toBe("allowed");
    expect(b.stateOf(B, true)).toBe("ask");
    expect(stored()).toEqual([{ id: A, name: "iPad · Safari", firstSeen: 1_000, allowed: true }]);
    expect(b.list().asking).toBeNull();
  });

  it("asks about one screen at a time, oldest first", () => {
    const { b } = book();
    b.ask(A, "iPad · Safari", true);
    b.ask(B, "TV", true);
    expect(b.list().asking?.id).toBe(A);
    b.answer(A, false);
    expect(b.list().asking?.id).toBe(B);
  });

  it("after Not now, doesn't ask again for a while, and Settings can still allow it", () => {
    const { b, later } = book();
    b.ask(A, "TV", true);
    b.answer(A, false);
    expect(b.stateOf(A, true)).toBe("declined");
    expect(b.ask(A, "TV", true)).toBe("declined");
    later(NOT_NOW_MS + 1);
    expect(b.stateOf(A, true)).toBe("ask");
    b.answer(A, true);
    expect(b.stateOf(A, true)).toBe("allowed");
    expect(b.list().screens).toEqual([{ id: A, name: "TV", firstSeen: 1_000, allowed: true }]);
  });

  it("forgets a removed screen, whose next tap asks again; a new address ends every approval", () => {
    const { b, stored } = book();
    b.ask(A, "iPad", true);
    b.answer(A, true);
    b.ask(B, "TV", true);
    b.answer(B, true);
    b.remove(A);
    expect(b.stateOf(A, true)).toBe("ask");
    expect(b.stateOf(B, true)).toBe("allowed");
    b.clear();
    expect(stored()).toEqual([]);
    expect(b.stateOf(B, true)).toBe("ask");
  });

  it("drops its asks when the switch goes off, and keeps the answers", () => {
    const { b } = book();
    b.ask(A, "iPad", true);
    b.answer(A, true);
    b.ask(B, "TV", true);
    b.dropAsks();
    expect(b.list().asking).toBeNull();
    expect(b.stateOf(A, true)).toBe("allowed");
  });

  it("keeps at most a few dozen, letting the oldest turned down go first", () => {
    const { b, stored, later } = book();
    for (let i = 0; i < MAX_SCREENS_KEPT + 3; i++) {
      const id = i.toString(16).padStart(32, "0");
      b.ask(id, `screen ${i}`, true);
      b.answer(id, i % 2 === 0);
      later(1);
    }
    expect(stored()).toHaveLength(MAX_SCREENS_KEPT);
    expect(stored().filter((s) => s.allowed)).toHaveLength(Math.ceil((MAX_SCREENS_KEPT + 3) / 2));
  });

  it("reads back only screens it could have kept", () => {
    expect(isStoredScreen({ id: A, name: "iPad", firstSeen: 1, allowed: true })).toBe(true);
    expect(isStoredScreen({ id: "x", name: "iPad", firstSeen: 1, allowed: true })).toBe(false);
    expect(isStoredScreen({ id: A, name: "", firstSeen: 1, allowed: true })).toBe(false);
    expect(isStoredScreen({ id: A, name: "iPad", firstSeen: "1", allowed: true })).toBe(false);
    expect(isStoredScreen({ id: A, name: "iPad", firstSeen: 1, allowed: "yes" })).toBe(false);
  });
});
