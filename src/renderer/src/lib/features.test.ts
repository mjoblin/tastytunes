/**
 * The beat grid (trackBeats) on synthetic kick tracks at known tempos.
 *
 * The tracker reads the onset envelope at 100 frames a second, so a tempo is
 * a whole number of 10 ms frames per beat: 120 bpm (50 frames) and 150 bpm
 * (40) are exact, and 90 bpm (66.7 frames) can only read 89.6 or 90.9. The
 * tolerances below are that grid, stated where it applies.
 */
import { describe, expect, it } from "vitest";
import { trackBeats, type Beats } from "./features";
import { analyzeOnsets, ONSET_HOP_MS } from "./onsets";
import { drumTrack } from "./__fixtures__/synthAudio";

const FS = 44_100;
const FRAME = ONSET_HOP_MS / 1000;

/** The beat grid of a synthetic track, which these tracks always have. */
function beatsOf(samples: Float32Array, fs = FS): Beats {
  const { onsets, flux } = analyzeOnsets([samples], fs);
  const beats = trackBeats(flux, onsets);
  if (!beats) throw new Error("expected a beat grid");
  return beats;
}

/** How far each beat is from the nearest point of a grid starting at `t0` every `period`. */
const offGrid = (times: Float32Array, t0: number, period: number): number[] =>
  Array.from(times, (t) => {
    const k = Math.round((t - t0) / period);
    return Math.abs(t - (t0 + k * period));
  });

describe("trackBeats: the tempo", () => {
  it("reads a steady 120 bpm kick exactly, with full confidence", () => {
    const beats = beatsOf(drumTrack(120, 30, FS).samples);
    expect(beats.bpm).toBe(120);
    expect(beats.confidence).toBeGreaterThan(0.9);
  });

  it("reads 100 bpm exactly and 90 bpm to the nearest frame of beat period", () => {
    expect(beatsOf(drumTrack(100, 30, FS).samples).bpm).toBe(100);
    // 66.7 frames a beat: the lag is 66 or 67 frames, 90.9 or 89.6 bpm
    expect(Math.abs(beatsOf(drumTrack(90, 30, FS).samples).bpm - 90)).toBeLessThan(1.5);
  });

  it("reads the same at 48 and 96 kHz", () => {
    for (const fs of [48_000, 96_000])
      expect(beatsOf(drumTrack(120, 30, fs).samples, fs).bpm).toBe(120);
  });

  it("gives no grid for a track under eight seconds, or with no onsets", () => {
    const short = analyzeOnsets([drumTrack(120, 6, FS).samples], FS);
    expect(trackBeats(short.flux, short.onsets)).toBeNull();
    const silent = analyzeOnsets([new Float32Array(10 * FS)], FS);
    expect(trackBeats(silent.flux, silent.onsets)).toBeNull();
  });
});

describe("trackBeats: the beat times", () => {
  it("puts every beat on the kicks' grid, within one frame, across the whole track", () => {
    const track = drumTrack(120, 30, FS);
    const beats = beatsOf(track.samples);
    expect(Math.max(...offGrid(beats.times, track.kicks[0], 0.5))).toBeLessThanOrEqual(FRAME);
    // one beat per kick at least (the grid may run on past the last kick)
    expect(beats.times.length).toBeGreaterThanOrEqual(track.kicks.length);
    expect(beats.times[0]).toBeCloseTo(track.kicks[0], 2);
  });

  it("spaces the beats one period apart", () => {
    const beats = beatsOf(drumTrack(100, 30, FS).samples);
    const gaps = Array.from(beats.times.subarray(1), (t, i) => t - beats.times[i]);
    for (const gap of gaps) expect(Math.abs(gap - 0.6)).toBeLessThanOrEqual(FRAME);
  });
});

describe("trackBeats: THE OCTAVE CHECK", () => {
  // Above 130 bpm the autocorrelation cannot tell a beat from its
  // subdivision; what tells them apart is whether anything sits between the
  // grid's beats. 150 bpm is used because its period is a whole number of
  // frames (40), so the check, and not the lag grid, decides.
  it("reads a bare fast pulse, with nothing between the beats, at half", () => {
    const track = drumTrack(150, 30, FS);
    const beats = beatsOf(track.samples);
    expect(beats.bpm).toBe(75);
    // every other kick, and still on them
    expect(Math.max(...offGrid(beats.times, track.kicks[0], 0.4))).toBeLessThanOrEqual(FRAME);
    const gaps = Array.from(beats.times.subarray(1), (t, i) => t - beats.times[i]);
    for (const gap of gaps) expect(Math.abs(gap - 0.8)).toBeLessThanOrEqual(FRAME);
  });

  it("keeps a fast pulse whose gaps are filled (hats on the off-beats)", () => {
    expect(beatsOf(drumTrack(150, 30, FS, { hats: true }).samples).bpm).toBe(150);
  });

  it("never touches a tempo at or under 130 bpm", () => {
    expect(beatsOf(drumTrack(125, 30, FS).samples).bpm).toBe(125);
  });
});

describe("trackBeats: the downbeat", () => {
  it("is the beat phase (mod 4) the loud kicks fall on", () => {
    for (const accent of [0, 2]) {
      const beats = beatsOf(drumTrack(120, 30, FS, { accent }).samples);
      expect(beats.downbeat, `accent on ${accent}`).toBe(accent);
    }
  });

  it("is −1 when every kick is alike and the kicks do not say", () => {
    expect(beatsOf(drumTrack(120, 30, FS).samples).downbeat).toBe(-1);
  });
});
