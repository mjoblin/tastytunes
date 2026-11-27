import { afterEach, describe, expect, it, vi } from "vitest";
import { dropWhenAway, holdPress, STANDBY_HOLD_MS, type PageAway } from "./hold";

afterEach(() => {
  vi.useRealTimers();
});

function rig() {
  vi.useFakeTimers();
  const said: string[] = [];
  const press = holdPress(STANDBY_HOLD_MS, {
    full: () => said.push("full"),
    held: () => said.push("held"),
    short: () => said.push("short"),
    dropped: () => said.push("dropped"),
  });
  return { press, said };
}

/** A page whose window and document can be sent away by the test. */
function page(): PageAway & { hide(): void; shown(): void; send(type: string): void } {
  const win = new EventTarget();
  const shownNow: { visibilityState: DocumentVisibilityState } = { visibilityState: "visible" };
  const doc = Object.assign(new EventTarget(), shownNow);
  return {
    win,
    doc,
    hide() {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    shown() {
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    send: (type) => void win.dispatchEvent(new Event(type)),
  };
}

describe("a press held for standby", () => {
  it("fills at the hold and sends at the lift, once", () => {
    const { press, said } = rig();
    press.down();
    vi.advanceTimersByTime(STANDBY_HOLD_MS - 1);
    expect(said).toEqual([]);
    vi.advanceTimersByTime(1);
    // full: nothing is sent until the finger lifts
    expect(said).toEqual(["full"]);
    press.lift();
    expect(said).toEqual(["full", "held"]);
    // the leave after the lift, and a lift after that, add nothing
    press.leave();
    press.lift();
    vi.advanceTimersByTime(STANDBY_HOLD_MS * 2);
    expect(said).toEqual(["full", "held"]);
  });

  it("sends nothing for a full press whose lift never comes", () => {
    const { press, said } = rig();
    press.down();
    vi.advanceTimersByTime(60 * 60_000);
    expect(said).toEqual(["full"]);
  });

  it("sends nothing for a full press that leaves the disc, or that the browser takes", () => {
    const { press, said } = rig();
    press.down();
    vi.advanceTimersByTime(STANDBY_HOLD_MS);
    press.leave();
    press.lift();
    expect(said).toEqual(["full", "dropped"]);
  });

  it("never acts on a tap: a lift before the hold is the short press, and nothing follows", () => {
    const { press, said } = rig();
    press.down();
    vi.advanceTimersByTime(120);
    press.lift();
    vi.advanceTimersByTime(STANDBY_HOLD_MS * 2);
    expect(said).toEqual(["short"]);
  });

  it("is short once, however the press ends before the hold (a leave, then its lift)", () => {
    const { press, said } = rig();
    press.down();
    vi.advanceTimersByTime(STANDBY_HOLD_MS - 1);
    press.leave();
    press.lift();
    vi.advanceTimersByTime(STANDBY_HOLD_MS);
    expect(said).toEqual(["short"]);
  });

  it("drops a press however far it got, and its lift then sends nothing", () => {
    const { press, said } = rig();
    press.down();
    vi.advanceTimersByTime(200);
    press.drop();
    vi.advanceTimersByTime(STANDBY_HOLD_MS * 2);
    press.down();
    vi.advanceTimersByTime(STANDBY_HOLD_MS);
    press.drop();
    press.lift();
    press.drop();
    expect(said).toEqual(["dropped", "full", "dropped"]);
  });

  it("starts the hold again at each press", () => {
    const { press, said } = rig();
    press.down();
    vi.advanceTimersByTime(STANDBY_HOLD_MS - 100);
    press.lift();
    press.down();
    vi.advanceTimersByTime(STANDBY_HOLD_MS - 1);
    expect(said).toEqual(["short"]);
    vi.advanceTimersByTime(1);
    press.lift();
    expect(said).toEqual(["short", "full", "held"]);
  });

  it("says nothing once let go", () => {
    const { press, said } = rig();
    press.down();
    press.stop();
    vi.advanceTimersByTime(STANDBY_HOLD_MS * 2);
    press.lift();
    press.leave();
    press.drop();
    expect(said).toEqual([]);
  });

  it("an end with no press is nothing", () => {
    const { press, said } = rig();
    press.lift();
    press.leave();
    press.drop();
    expect(said).toEqual([]);
  });
});

describe("a press when the page goes away", () => {
  it("sends nothing for a full press while the page is hidden, nor at a lift after", () => {
    const { press, said } = rig();
    const p = page();
    dropWhenAway(press, p);
    press.down();
    vi.advanceTimersByTime(STANDBY_HOLD_MS);
    p.hide();
    press.lift();
    expect(said).toEqual(["full", "dropped"]);
  });

  it("ends the press when the page is left or loses focus", () => {
    for (const type of ["pagehide", "blur"]) {
      const { press, said } = rig();
      const p = page();
      dropWhenAway(press, p);
      press.down();
      vi.advanceTimersByTime(100);
      p.send(type);
      vi.advanceTimersByTime(STANDBY_HOLD_MS * 2);
      press.lift();
      expect(said, type).toEqual(["dropped"]);
    }
  });

  it("leaves a press alone once it stops listening, and a page still shown alone", () => {
    const { press, said } = rig();
    const p = page();
    const unwatch = dropWhenAway(press, p);
    press.down();
    // shown again, or still shown: a visibilitychange to visible is nothing
    p.shown();
    unwatch();
    p.send("blur");
    p.hide();
    vi.advanceTimersByTime(STANDBY_HOLD_MS);
    press.lift();
    expect(said).toEqual(["full", "held"]);
  });
});
