/**
 * The beat grid (trackBeats) on synthetic kick tracks at known tempos.
 *
 * The tracker reads the onset envelope at 100 frames a second, so a tempo is
 * a whole number of 10 ms frames per beat: 120 bpm (50 frames) and 150 bpm
 * (40) are exact, and 90 bpm (66.7 frames) can only read 89.6 or 90.9. The
 * tolerances below are that grid, stated where it applies. Then the octave
 * check on onset patterns, and the drop detector (findDrops) on feature strips.
 */
import { describe, expect, it } from "vitest";
import { dropClears, findDrops, trackBeats, type Beats } from "./features";
import type { Strip } from "./featureStrip";
import { analyzeOnsets, ONSET_HOP_MS, type Onsets } from "./onsets";
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

describe("trackBeats: the octave check on onset patterns", () => {
  // two minutes of onsets, every 0.37 s: what sits between the grid's beats
  // decides whether a fast winner is read at half
  type Event = [at: number, strength: number, type: number];
  const synth = (events: Event[]): Onsets => {
    const ev = events.sort((a, b) => a[0] - b[0]);
    return {
      at: Float32Array.from(ev, (e) => e[0]),
      strength: Float32Array.from(ev, (e) => e[1]),
      type: Uint8Array.from(ev, (e) => e[2]),
    };
  };
  const beatsFrom = (events: Event[]): Beats => {
    const beats = trackBeats(new Float32Array(12200), synth(events));
    if (!beats) throw new Error("expected a beat grid");
    return beats;
  };

  it("reads a strummed ballad at the level it is tapped, its grid on the accents", () => {
    // the accents every 0.74 s, nothing between
    const ballad: Event[] = [];
    for (let t = 1, i = 0; t < 120; t += 0.37, i++) ballad.push([t, i % 2 === 0 ? 0.9 : 0.55, 0]);
    const beats = beatsFrom(ballad);
    expect(Math.abs(beats.bpm - 81.1)).toBeLessThan(2);
    expect(beats.times.length).toBeGreaterThan(140);
    expect(beats.times.length).toBeLessThan(180);
  });

  it("keeps the tempo of fast rock with hats between its beats", () => {
    // a kick or a snare every 0.37 s, a hat at every midpoint
    const rock: Event[] = [];
    for (let t = 1, i = 0; t < 120; t += 0.37, i++) {
      rock.push([t, 0.9, i % 2 === 0 ? 0 : 1]);
      rock.push([t + 0.185, 0.5, 2]);
    }
    const beats = beatsFrom(rock);
    expect(Math.abs(beats.bpm - 162.2)).toBeLessThan(3);
    expect(beats.times.length).toBeGreaterThan(300);
  });
});

describe("findDrops and dropClears: a riser before the slam", () => {
  // a strip in Forests' shape at 10 frames a second: forty seconds of beat,
  // nine tenths of a second of it reduced (chill, never breath), a second of
  // near silence (the gasp), half a second of riser with the level up and the
  // bass out, then the slam; and the same lull with the gasp filled in
  const strip = (gasp: boolean): Strip => {
    const frames: [loud: number, bass: number][] = [];
    const push = (loud: number, bass: number) => frames.push([loud, bass]);
    for (let i = 0; i < 400; i++) push(0.8, i % 5 === 0 ? 0.92 : 0.45);
    for (let i = 0; i < 9; i++) push(0.7, 0.5);
    for (let i = 0; i < 10; i++) push(gasp ? 0.3 : 0.7, gasp ? 0.1 : 0.5);
    for (let i = 0; i < 5; i++) push(0.74, 0.5);
    for (let i = 0; i < 100; i++) push(0.86, i % 5 === 0 ? 0.95 : 0.5);
    const n = frames.length;
    const loud = new Uint8Array(n);
    const bands = new Uint8Array(n * 6);
    frames.forEach(([l, b], i) => {
      loud[i] = Math.round(l * 255);
      bands[i * 6] = Math.round(b * 255);
      for (let k = 1; k < 6; k++) bands[i * 6 + k] = Math.round(l * 200);
    });
    return { fps: 10, loud, bands };
  };
  const noOnsets: Onsets = {
    at: new Float32Array(0),
    strength: new Float32Array(0),
    type: new Uint8Array(0),
  };
  /** The one drop's readings, rounded as they are reported, and the tiers it clears. */
  const read = (gasp: boolean) => {
    const d = findDrops(strip(gasp), noOnsets, null);
    expect(d.at).toHaveLength(1);
    return {
      breath: +d.breath[0].toFixed(1),
      cut: +d.cut[0].toFixed(2),
      normal: dropClears(d, 0, "normal"),
      loose: dropClears(d, 0, "loose"),
    };
  };

  it("reads a near silence past the riser, and the drop clears Normal by its breath", () => {
    const d = read(true);
    expect(d.breath).toBeGreaterThanOrEqual(1);
    expect(d.normal).toBe(true);
  });

  it("reads no breath and no cut in the same lull with the gasp filled in, clearing Loose alone", () => {
    const d = read(false);
    expect(d.breath).toBe(0);
    expect(d.cut).toBe(0);
    expect(d.normal).toBe(false);
    expect(d.loose).toBe(true);
  });
});
