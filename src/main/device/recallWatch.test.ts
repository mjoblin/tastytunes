import { describe, expect, it } from "vitest";
import { DEAD_RECALL_MS, RecallWatch } from "./recallWatch";

/** A watch over a fake clock: `sig` is what plays, `awake` the streamer's power. */
function rig(): {
  w: RecallWatch;
  dead: number[];
  state: { sig: string; awake: boolean };
  tick(ms: number): void;
} {
  const state = { sig: "a", awake: true };
  const dead: number[] = [];
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const w = new RecallWatch({
    signature: () => state.sig,
    awake: () => state.awake,
    onDead: (id) => dead.push(id),
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { live: boolean }).live = false;
    },
  });
  const tick = (ms: number): void => {
    now += ms;
    for (const t of timers)
      if (t.live && t.at <= now) {
        t.live = false;
        t.fn();
      }
  };
  return { w, dead, state, tick };
}

describe("a preset recall that loaded nothing, decided once", () => {
  it("comes to nothing 8 s after the recall when nothing that plays changed", () => {
    const { w, dead, tick } = rig();
    w.recalled(24, false);
    tick(DEAD_RECALL_MS - 1);
    expect(dead).toEqual([]);
    tick(1);
    expect(dead).toEqual([24]);
  });

  it("is a recall that worked once what plays changes", () => {
    const { w, dead, state, tick } = rig();
    w.recalled(24, false);
    tick(3000);
    state.sig = "b";
    w.onPlayback();
    tick(DEAD_RECALL_MS);
    expect(dead).toEqual([]);
  });

  it("waits for the streamer to wake before its 8 s start", () => {
    const { w, dead, state, tick } = rig();
    state.awake = false;
    w.recalled(24, false);
    tick(DEAD_RECALL_MS + 3000);
    expect(dead).toEqual([]);
    state.awake = true;
    w.onAwake();
    tick(DEAD_RECALL_MS - 1);
    expect(dead).toEqual([]);
    tick(1);
    expect(dead).toEqual([24]);
  });

  it("never watches a recall of what already plays, and a new recall replaces the last", () => {
    const { w, dead, tick } = rig();
    w.recalled(5, true);
    tick(DEAD_RECALL_MS * 2);
    expect(dead).toEqual([]);
    w.recalled(6, false);
    tick(2000);
    w.recalled(7, false);
    tick(DEAD_RECALL_MS);
    expect(dead).toEqual([7]);
  });

  it("stops watching when told to", () => {
    const { w, dead, tick } = rig();
    w.recalled(9, false);
    w.cancel();
    tick(DEAD_RECALL_MS * 2);
    expect(dead).toEqual([]);
  });
});
