import { describe, expect, it } from "vitest";
import type { ZoneNowPlaying, ZonePlayState } from "../smoip";
import {
  canSleepAtTrackEnd,
  SLEEP_DURATIONS,
  sleepActionOf,
  sleepTimerFor,
  sleepTrackKey,
} from "./schedules";

const ps = (over: Record<string, unknown> = {}, md: Record<string, unknown> = {}): ZonePlayState =>
  ({
    state: "play",
    queue_id: 7,
    metadata: { title: "Song", artist: "Band", duration: 200, class: "stream.media", ...md },
    ...over,
  }) as unknown as ZonePlayState;

describe("the sleep timer's one list and its rules", () => {
  it("offers the same six lengths everywhere, in order", () => {
    expect(SLEEP_DURATIONS.map((d) => d.minutes)).toEqual([15, 30, 45, 60, 90, 120]);
    expect(SLEEP_DURATIONS.map((d) => d.label)).toEqual([
      "15 min",
      "30 min",
      "45 min",
      "1 hr",
      "1.5 hr",
      "2 hr",
    ]);
  });

  it("reads the stored action with a guard: an unset or unknown one is standby", () => {
    expect(sleepActionOf("pause")).toBe("pause");
    expect(sleepActionOf("standby")).toBe("standby");
    expect(sleepActionOf(undefined)).toBe("standby");
    expect(sleepActionOf("off")).toBe("standby");
  });

  it("offers the end of the track for a track with a length, never a station", () => {
    expect(canSleepAtTrackEnd(ps(), null)).toBe(true);
    // a length from now_playing's progress where play_state has none
    const np = { display: { progress: { duration: 180 } } } as unknown as ZoneNowPlaying;
    expect(canSleepAtTrackEnd(ps({}, { duration: null }), np)).toBe(true);
    expect(canSleepAtTrackEnd(ps({}, { duration: null }), null)).toBe(false);
    expect(canSleepAtTrackEnd(ps({}, { duration: 0 }), null)).toBe(false);
    expect(canSleepAtTrackEnd(ps({}, { class: "stream.radio" }), null)).toBe(false);
    expect(canSleepAtTrackEnd(ps({}, { station: "Radio 3" }), null)).toBe(false);
    // a station named only by now_playing's class
    const radio = { display: { class: "stream.radio" } } as unknown as ZoneNowPlaying;
    expect(canSleepAtTrackEnd(ps({}, { class: null }), radio)).toBe(false);
    // nothing identifiable playing
    expect(canSleepAtTrackEnd(ps({ queue_id: null }, { title: null }), null)).toBe(false);
    expect(canSleepAtTrackEnd(null, null)).toBe(false);
  });

  it("arms a length from now, or the end of the playing track by its key", () => {
    const now = 1_700_000_000_000;
    expect(sleepTimerFor(45, "pause", ps(), now)).toEqual({
      action: "pause",
      minutes: 45,
      firesAt: now + 45 * 60_000,
      trackKey: null,
    });
    expect(sleepTimerFor("track", "standby", ps(), now)).toEqual({
      action: "standby",
      minutes: null,
      firesAt: null,
      trackKey: sleepTrackKey(ps()),
    });
  });
});
