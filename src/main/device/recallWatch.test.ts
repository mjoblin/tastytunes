import { describe, expect, it } from "vitest";
import type { ZonePlayState } from "@shared/smoip";
import { DEAD_RECALL_MS, RecallWatch, recallSignature } from "./recallWatch";

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

  it("is a recall that worked when what plays changed, even if it changes back before 8 s", () => {
    const { w, dead, state, tick } = rig();
    w.recalled(24, false);
    tick(2000);
    state.sig = "b";
    w.onPlayback();
    tick(2000);
    state.sig = "a";
    w.onPlayback();
    tick(DEAD_RECALL_MS);
    expect(dead).toEqual([]);
  });

  it("checks what plays when the clock ends, so a playback event that never came can't kill it", () => {
    const { w, dead, state, tick } = rig();
    w.recalled(24, false);
    tick(3000);
    state.sig = "b";
    tick(DEAD_RECALL_MS);
    expect(dead).toEqual([]);
  });

  it("stops watching when told to", () => {
    const { w, dead, tick } = rig();
    w.recalled(9, false);
    w.cancel();
    tick(DEAD_RECALL_MS * 2);
    expect(dead).toEqual([]);
  });
});

/** A play state with the fields the signature reads; the rest are the firmware's. */
function ps(
  state: string,
  md: Record<string, unknown> | null,
  queueId: number | null = null,
): ZonePlayState {
  return { state, queue_id: queueId, metadata: md } as unknown as ZonePlayState;
}
const track = (title: string | null, queueId: number | null, state = "pause"): ZonePlayState =>
  ps(
    state,
    title == null
      ? { class: "md.track", source: "MEDIA_PLAYER" }
      : { class: "md.track", source: "MEDIA_PLAYER", title },
    queueId,
  );
const station = (state: string, title: string | null): ZonePlayState =>
  ps(state, { class: "stream.radio", source: "IR", station: "Mock FM 101.5", radio_id: 7, title });

describe("what a recall changes (0.15.0-rc.2, a preset recalled from standby)", () => {
  it("is unmoved by the play state's own transitions: a wake's stop, pause and play of what was held", () => {
    const held = recallSignature(track("She's Leaving You", 8805344, "pause"));
    expect(recallSignature(track("She's Leaving You", 8805344, "stop"))).toBe(held);
    expect(recallSignature(track("She's Leaving You", 8805344, "play"))).toBe(held);
  });

  it("is unmoved by a held station reaching play, or by the station's songs", () => {
    const held = recallSignature(station("connecting", null));
    expect(recallSignature(station("play", "The Midnight Hour"))).toBe(held);
    expect(recallSignature(station("play", "The Next Song"))).toBe(held);
  });

  it("moves when a recall lands: connecting without words, a new entry, a new source or station", () => {
    const held = recallSignature(track("She's Leaving You", 8805344));
    expect(recallSignature(track(null, null, "connecting"))).not.toBe(held);
    expect(recallSignature(track("Woke Up In A Dream", 9000001, "play"))).not.toBe(held);
    expect(recallSignature(station("connecting", null))).not.toBe(held);
    const fm = recallSignature(station("play", "The Midnight Hour"));
    expect(
      recallSignature(
        ps("play", {
          class: "stream.radio",
          source: "IR",
          station: "Other FM",
          radio_id: 8,
          title: "The Midnight Hour",
        }),
      ),
    ).not.toBe(fm);
  });

  it("names a recall dead when the streamer woke into a station that reached play inside the window", () => {
    // the app's sequence from standby: ON, the re-announce, the 2.5 s settle, then the recall; the
    // held station reaches play ~10 s after the wake, 7.5 s into the recall's 8 s
    let playState = station("connecting", null);
    const dead: number[] = [];
    let now = 0;
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    const w = new RecallWatch({
      signature: () => recallSignature(playState),
      awake: () => true,
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
    w.recalled(22, false);
    tick(7500);
    playState = station("play", "The Midnight Hour");
    w.onPlayback();
    tick(DEAD_RECALL_MS - 7500);
    expect(dead).toEqual([22]);
  });
});
