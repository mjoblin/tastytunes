import { describe, expect, it } from "vitest";
import type { DisplayScreen } from "@shared/displayControl";
import {
  ASK_GAP_MS,
  isStoredScreen,
  MAX_ASKS_WAITING,
  MAX_SCREENS_KEPT,
  NOT_NOW_MS,
  ScreenBook,
} from "./displayScreens";

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
    const { b, later } = book();
    b.ask(A, "iPad · Safari", true);
    later(ASK_GAP_MS);
    b.ask(B, "TV", true);
    expect(b.list().asking?.id).toBe(A);
    b.answer(A, false);
    expect(b.list().asking?.id).toBe(B);
  });

  it("lets made-up screens raise no more than MAX_ASKS_WAITING asks, recording nothing past it", () => {
    const { b, later, changes } = book();
    const made = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(32, "0"));
    const answers = made.map((id) => {
      later(ASK_GAP_MS);
      return b.ask(id, "Screen", true);
    });
    expect(answers.filter((a) => a === "asking")).toHaveLength(MAX_ASKS_WAITING);
    expect(answers.slice(MAX_ASKS_WAITING).every((a) => a === "busy")).toBe(true);
    expect(changes()).toBe(MAX_ASKS_WAITING);
    // a refused one is still free to ask once the app has answered the others
    for (const id of made.slice(0, MAX_ASKS_WAITING)) b.answer(id, false);
    later(ASK_GAP_MS);
    expect(b.ask(made[MAX_ASKS_WAITING], "Screen", true)).toBe("asking");
  });

  it("raises a new ask at most once in ASK_GAP_MS across all screens", () => {
    const { b, later } = book();
    expect(b.ask(A, "iPad · Safari", true)).toBe("asking");
    later(ASK_GAP_MS - 1);
    expect(b.ask(B, "TV", true)).toBe("busy");
    expect(b.stateOf(B, true)).toBe("ask");
    later(1);
    expect(b.ask(B, "TV", true)).toBe("asking");
  });

  it("drops a turned-down screen's hold once it has passed", () => {
    const { b, later } = book();
    b.ask(A, "TV", true);
    b.answer(A, false);
    later(ASK_GAP_MS);
    b.ask(B, "Phone", true);
    b.answer(B, false);
    expect(b.heldOff).toBe(2);
    later(NOT_NOW_MS);
    expect(b.stateOf(A, true)).toBe("ask");
    expect(b.heldOff).toBe(1);
    b.ask(A, "TV", true);
    expect(b.heldOff).toBe(0);
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
    const { b, stored, later } = book();
    b.ask(A, "iPad", true);
    b.answer(A, true);
    later(ASK_GAP_MS);
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
    const { b, later } = book();
    b.ask(A, "iPad", true);
    b.answer(A, true);
    later(ASK_GAP_MS);
    expect(b.ask(B, "TV", true)).toBe("asking");
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
      later(ASK_GAP_MS);
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
