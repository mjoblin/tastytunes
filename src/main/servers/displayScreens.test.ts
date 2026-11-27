import { describe, expect, it } from "vitest";
import type { DisplayScreen } from "@shared/displayControl";
import { carriedNone, withCarried } from "../data/savedChecks";
import {
  ASK_GAP_MS,
  ASK_LAPSE_MS,
  isStoredScreen,
  MAX_ASKS_WAITING,
  MAX_SCREENS_KEPT,
  NEW_SCREEN_HOLD_MS,
  NOT_NOW_MS,
  ScreenBook,
  storedScreens,
} from "./displayScreens";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

/** A book over a stored list, a clock and timers the test moves on (`later` runs what is due);
 *  `early` fires every timer that many milliseconds short, as a real one can. */
function book(early = 0) {
  let stored: DisplayScreen[] = [];
  let now = 1_000;
  let changes = 0;
  let timers: Array<{ at: number; fn: () => void }> = [];
  const b = new ScreenBook({
    load: () => stored,
    save: (s) => (stored = s),
    now: () => now,
    changed: () => changes++,
    later: (fn, ms) => timers.push({ at: now + ms - early, fn }),
  });
  return {
    b,
    stored: () => stored,
    changes: () => changes,
    later: (ms: number) => {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
    },
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
    for (const id of made.slice(0, MAX_ASKS_WAITING)) b.answer(id, true);
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
    later(NEW_SCREEN_HOLD_MS);
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
      later(NEW_SCREEN_HOLD_MS);
    }
    expect(stored()).toHaveLength(MAX_SCREENS_KEPT);
    expect(stored().filter((s) => s.allowed)).toHaveLength(Math.ceil((MAX_SCREENS_KEPT + 3) / 2));
  });

  it("takes down an ask nobody answers, and the screen's next tap asks again", () => {
    const { b, later, changes, stored } = book();
    b.ask(A, "iPad · Safari", true);
    later(ASK_GAP_MS);
    b.ask(B, "iPad · Safari", true);
    expect(changes()).toBe(2);
    later(ASK_LAPSE_MS - ASK_GAP_MS);
    // the prompt moves on to the next, and the windows hear it without anything else happening
    expect(changes()).toBe(3);
    expect(b.list().asking?.id).toBe(B);
    expect(b.stateOf(A, true)).toBe("ask");
    expect(b.ask(A, "iPad · Safari", true)).toBe("asking");
    later(ASK_GAP_MS);
    expect(b.list().asking?.id).toBe(A);
    // nothing was recorded for it
    expect(stored()).toEqual([]);
  });

  it("takes down an ask whose timer fires a little early, and tells the windows", () => {
    const { b, later, changes } = book(1);
    b.ask(A, "iPad · Safari", true);
    expect(changes()).toBe(1);
    later(ASK_LAPSE_MS - 1);
    // by the clock it has a millisecond to go, and no other timer would take it down
    expect(changes()).toBe(2);
    expect(b.list().asking).toBeNull();
    expect(b.stateOf(A, true)).toBe("ask");
    expect(b.ask(A, "iPad · Safari", true)).toBe("asking");
  });

  it("never lets an earlier ask's timer take down the same screen's later ask", () => {
    const { b, later, changes } = book(1);
    b.ask(A, "iPad · Safari", true);
    b.remove(A);
    later(ASK_GAP_MS);
    expect(b.ask(A, "iPad · Safari", true)).toBe("asking");
    const before = changes();
    later(ASK_LAPSE_MS - ASK_GAP_MS);
    // the first ask's timer has fired; the second ask stands until its own
    expect(changes()).toBe(before);
    expect(b.list().asking?.id).toBe(A);
    later(ASK_GAP_MS);
    expect(b.list().asking).toBeNull();
    expect(changes()).toBe(before + 1);
  });

  it("lets a stale ask lapse, so the owner's tap isn't kept waiting behind it", () => {
    const { b, later } = book();
    const made = Array.from({ length: MAX_ASKS_WAITING }, (_, i) =>
      i.toString(16).padStart(32, "0"),
    );
    for (const id of made) {
      b.ask(id, "Screen", true);
      later(ASK_GAP_MS);
    }
    expect(b.ask(A, "iPad · Safari", true)).toBe("busy");
    later(ASK_LAPSE_MS);
    expect(b.ask(A, "iPad · Safari", true)).toBe("asking");
    expect(b.list().asking?.id).toBe(A);
  });

  it("holds every screen it has never seen for a while after a Not now, and no other", () => {
    const { b, later } = book();
    b.ask(B, "TV", true);
    b.answer(B, false);
    later(NOT_NOW_MS);
    b.ask(A, "Screen", true);
    b.answer(A, false);
    later(ASK_GAP_MS);
    // a made-up screen can't raise the next prompt the moment one is turned down
    expect(b.ask(C, "iPad · Safari", true)).toBe("busy");
    expect(b.list().asking).toBeNull();
    // a screen the app knows, its own hold passed, still asks
    expect(b.ask(B, "TV", true)).toBe("asking");
    b.answer(B, true);
    later(NEW_SCREEN_HOLD_MS - ASK_GAP_MS - 1);
    expect(b.ask(C, "iPad · Safari", true)).toBe("busy");
    later(1);
    expect(b.ask(C, "iPad · Safari", true)).toBe("asking");
  });

  it("lifts the hold on new screens with a new address", () => {
    const { b, later } = book();
    b.ask(A, "Screen", true);
    b.answer(A, false);
    b.clear();
    later(ASK_GAP_MS);
    expect(b.ask(C, "iPad · Safari", true)).toBe("asking");
  });

  it("reads back only screens it could have kept", () => {
    expect(isStoredScreen({ id: A, name: "iPad", firstSeen: 1, allowed: true })).toBe(true);
    expect(isStoredScreen({ id: "x", name: "iPad", firstSeen: 1, allowed: true })).toBe(false);
    expect(isStoredScreen({ id: A, name: "", firstSeen: 1, allowed: true })).toBe(false);
    expect(isStoredScreen({ id: A, name: "iPad", firstSeen: "1", allowed: true })).toBe(false);
    expect(isStoredScreen({ id: A, name: "iPad", firstSeen: 1, allowed: "yes" })).toBe(false);
  });
});

describe("a later version's screens", () => {
  it("are kept at their places, a field this version doesn't read with its screen, a wrapped list read through", () => {
    const known = { id: A, name: "iPad · Safari", firstSeen: 5, allowed: true, scene: "later" };
    const later = { id: "e".repeat(64), name: "TV", firstSeen: 6, allowed: true };
    const carried = carriedNone();
    const setAside: string[] = [];
    const rows = storedScreens({ format: 2, items: [later, known, 7] }, setAside, carried);
    expect(rows).toEqual([known]);
    expect(setAside).toEqual(["display screens: [2] was a number, left out"]);
    expect(carried.notes).toEqual(["[0] isn't a screen this version reads, kept as it was"]);
    expect(withCarried(rows, carried)).toEqual({ format: 2, items: [later, known] });
    expect(storedScreens("screens", setAside, carriedNone())).toEqual([]);
    expect(setAside.at(-1)).toBe("display screens: not a list");
  });

  it("keeps a known screen's field this version doesn't read through its next ask and answer", () => {
    let stored: DisplayScreen[] = [
      { id: A, name: "iPad", firstSeen: 5, allowed: false, scene: "later" } as DisplayScreen,
    ];
    const b = new ScreenBook({
      load: () => stored,
      save: (s) => (stored = s),
      now: () => 1_000_000,
      changed: () => {},
      later: () => {},
    });
    expect(b.ask(A, "iPad · Safari", true)).toBe("asking");
    b.answer(A, true);
    expect(stored).toEqual([
      { id: A, name: "iPad · Safari", firstSeen: 5, allowed: true, scene: "later" },
    ]);
  });
});
