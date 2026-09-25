/**
 * The drum-onset detector on synthetic drums, and its four-byte disk shape.
 *
 * The drums are generated (lib/__fixtures__/synthAudio): a kick is a sine
 * sweeping down to 50 Hz, a hat is noise tilted to the top octaves, so each
 * has an unambiguous type and an exact start time.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeOnsets,
  ONSET_HOP_MS,
  ONSET_TYPES,
  onsetsFromStored,
  onsetsToStored,
} from "./onsets";
import { drumTrack } from "./__fixtures__/synthAudio";

const FS = 44_100;
/** One analysis frame, in seconds: the grid every onset time sits on. */
const FRAME = ONSET_HOP_MS / 1000;

const KICK = ONSET_TYPES.indexOf("kick");
const HAT = ONSET_TYPES.indexOf("hat");

/** How far each time in `times` is from the nearest of `targets`. */
const misses = (times: ArrayLike<number>, targets: number[]): number[] =>
  Array.from(times, (t) => Math.min(...targets.map((x) => Math.abs(x - t))));

describe("analyzeOnsets", () => {
  it("finds every kick once, typed as a kick, within one frame of its start", () => {
    // 90 bpm puts most kicks between two frames, so this also shows the grid
    const track = drumTrack(90, 30, FS);
    const { onsets } = analyzeOnsets([track.samples], FS);
    expect(onsets.at.length).toBe(track.kicks.length);
    expect(Array.from(onsets.type).every((t) => t === KICK)).toBe(true);
    expect(Math.max(...misses(onsets.at, track.kicks))).toBeLessThanOrEqual(FRAME);
  });

  it("types the hats between the kicks as hats", () => {
    const track = drumTrack(120, 30, FS, { hats: true });
    const { onsets } = analyzeOnsets([track.samples], FS);
    const hats = Array.from(onsets.at).filter((_, i) => onsets.type[i] === HAT);
    const kicks = Array.from(onsets.at).filter((_, i) => onsets.type[i] === KICK);
    expect(hats.length).toBe(track.hats.length);
    expect(kicks.length).toBe(track.kicks.length);
    expect(Math.max(...misses(hats, track.hats))).toBeLessThanOrEqual(FRAME);
  });

  it("scales strength to the track's own accents: loud kicks are 1, soft ones less", () => {
    const track = drumTrack(120, 30, FS, { accent: 0 });
    const { onsets } = analyzeOnsets([track.samples], FS);
    const strengths = Array.from(onsets.strength);
    expect(strengths.filter((_, i) => i % 4 === 0).every((s) => s === 1)).toBe(true);
    expect(strengths.filter((_, i) => i % 4 !== 0).every((s) => s > 0 && s < 0.9)).toBe(true);
  });

  it("finds nothing in silence", () => {
    const { onsets, flux } = analyzeOnsets([new Float32Array(10 * FS)], FS);
    expect(onsets.at.length).toBe(0);
    expect(flux.every((v) => v === 0)).toBe(true);
  });

  it("works on the grid at any sample rate (a longer window above 60 kHz)", () => {
    for (const fs of [48_000, 96_000]) {
      const track = drumTrack(120, 20, fs);
      const { onsets } = analyzeOnsets([track.samples], fs);
      expect(onsets.at.length, `${fs} Hz`).toBe(track.kicks.length);
      expect(Math.max(...misses(onsets.at, track.kicks))).toBeLessThanOrEqual(FRAME);
    }
  });
});

describe("the stored shape: four bytes an onset", () => {
  it("round-trips times on the 10 ms grid, types exactly and strengths to 1/255", () => {
    const track = drumTrack(120, 30, FS, { hats: true, accent: 1 });
    const { onsets } = analyzeOnsets([track.samples], FS);
    const stored = onsetsToStored(onsets);
    expect(stored.count).toBe(onsets.at.length);
    const back = onsetsFromStored(stored);
    expect(Array.from(back.type)).toEqual(Array.from(onsets.type));
    for (let i = 0; i < onsets.at.length; i++) {
      expect(back.at[i]).toBeCloseTo(onsets.at[i], 5);
      expect(Math.abs(back.strength[i] - onsets.strength[i])).toBeLessThanOrEqual(0.5 / 255);
    }
  });

  it("reads no more onsets than the bytes hold", () => {
    const stored = onsetsToStored({
      at: Float32Array.from([0.5, 1]),
      strength: Float32Array.from([1, 0.5]),
      type: Uint8Array.from([0, 2]),
    });
    expect(onsetsFromStored({ ...stored, count: 5 }).at.length).toBe(2);
  });
});
