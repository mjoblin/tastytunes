/**
 * EBU R128 loudness against the standard's own test signals.
 *
 * EBU Tech 3341 (loudness) and Tech 3342 (loudness range) define their test
 * vectors as plain sine tones in segments, so they can be generated here
 * exactly rather than shipped as files; the expected readings and the
 * tolerances are the documents' own (±0.1 LU for integrated loudness, ±1 LU
 * for the loudness range, +0.2/−0.4 dB for true peak).
 */
import { describe, expect, it } from "vitest";
import { integrateLoudnessHistograms, LOUD_HIST_STEP } from "@shared/model";
import { computeR128 } from "./r128";
import { concat, sine } from "./__fixtures__/synthAudio";

const FS = 48_000;

/** A stereo pair of one signal (both channels identical). */
const stereo = (x: Float32Array): Float32Array[] => [x, x];

/** A 1 kHz tone, `secs` long, at `dbfs`. */
const tone = (dbfs: number, secs: number, fs = FS): Float32Array => sine(1000, dbfs, secs, fs);

/** Integrated loudness, which these signals always have. */
function lufsOf(chans: Float32Array[], fs = FS): number {
  const { lufs } = computeR128(chans, fs);
  if (lufs == null) throw new Error("expected a loudness");
  return lufs;
}

function expectWithin(actual: number | null, expected: number, tolerance: number): void {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual ?? NaN) - expected)).toBeLessThanOrEqual(tolerance);
}

describe("integrated loudness", () => {
  it("a 0 dBFS 1 kHz sine on one channel reads −3.01 LUFS", () => {
    // BS.1770's calibration point: the sine's mean square is 1/2 (−3.01 dB)
    // and the −0.691 offset cancels the K-filter's gain at 1 kHz
    const lufs = lufsOf([tone(0, 20)]);
    expectWithin(lufs, -3.01, 0.1);
    // exactly, this K-filter gains 0.654 dB at 1000 Hz (the offset is its
    // nominal 0.691), so the reading is −3.047; a drift from that is a change
    // to the filter, not rounding
    expectWithin(lufs, -3.047, 0.005);
  });

  it("a silent second channel adds nothing", () => {
    const x = tone(0, 20);
    expect(lufsOf([x, new Float32Array(x.length)])).toBe(lufsOf([x]));
  });

  it("derives the K-filter for the file's own sample rate", () => {
    // the same tone reads the same at 44.1, 48 and 96 kHz
    const at48 = lufsOf([tone(0, 20)]);
    for (const fs of [44_100, 96_000]) expectWithin(lufsOf([tone(0, 20, fs)], fs), at48, 0.01);
  });

  it("Tech 3341 case 1: stereo 1 kHz at −23 dBFS reads −23 LUFS", () => {
    // two channels at −23 dBFS: each reads −26, and their energies add
    expectWithin(lufsOf(stereo(tone(-23, 20))), -23, 0.1);
  });

  it("Tech 3341 case 3: the relative gate drops the quiet ends (−36, −23, −36)", () => {
    const x = concat(tone(-36, 10), tone(-23, 60), tone(-36, 10));
    expectWithin(lufsOf(stereo(x)), -23, 0.1);
  });

  it("Tech 3341 case 4: the absolute gate drops what is under −70 (−72, −36, −23, −36, −72)", () => {
    const x = concat(tone(-72, 10), tone(-36, 10), tone(-23, 60), tone(-36, 10), tone(-72, 10));
    expectWithin(lufsOf(stereo(x)), -23, 0.1);
  });

  it("Tech 3341 case 5: loudness averages energy, not decibels (−26, −20, −26)", () => {
    // the middle third is 6 dB (four times the energy) louder: the mean of
    // 1, 4, 1 is 2, 3 dB over −26
    const x = concat(tone(-26, 20), tone(-20, 20.1), tone(-26, 20));
    expectWithin(lufsOf(stereo(x)), -23, 0.1);
  });

  it("weights the surround channels (Ls, Rs) at 1.41, per BS.1770", () => {
    const x = tone(0, 20);
    const z = new Float32Array(x.length);
    const inLeft = lufsOf([x, z, z, z, z]);
    const inLs = lufsOf([z, z, z, x, z]);
    expectWithin(inLs - inLeft, 10 * Math.log10(1.41), 0.001);
  });

  it("has no loudness for silence, or for less than one 400 ms block", () => {
    expect(computeR128([new Float32Array(10 * FS)], FS)).toMatchObject({
      lufs: null,
      lra: null,
      truePeakDb: null,
    });
    expect(computeR128([tone(0, 0.3)], FS).lufs).toBeNull();
    expect(computeR128([new Float32Array(0)], FS).lufs).toBeNull();
  });

  it("its block histogram integrates back to the same loudness, to half a bin", () => {
    // the album value is built from these histograms (shared/model)
    const { lufs, hist } = computeR128(stereo(concat(tone(-30, 10), tone(-18, 20))), FS);
    expectWithin(integrateLoudnessHistograms([hist]), lufs ?? NaN, LOUD_HIST_STEP / 2);
  });
});

describe("loudness range (Tech 3342)", () => {
  // each case: 20 s segments of a stereo 1 kHz tone; the expected LRA is the
  // spread between the quiet and loud levels the 10th–95th percentiles see
  const cases = [
    { name: "case 1: −20 then −30", levels: [-20, -30], expected: 10 },
    { name: "case 2: −20 then −15", levels: [-20, -15], expected: 5 },
    { name: "case 3: −40 then −20", levels: [-40, -20], expected: 20 },
    { name: "case 4: −50, −35, −20, −35, −50", levels: [-50, -35, -20, -35, -50], expected: 15 },
  ];

  it.each(cases)("$name reads $expected LU", ({ levels, expected }) => {
    const x = concat(...levels.map((db) => tone(db, 20)));
    expectWithin(computeR128(stereo(x), FS).lra, expected, 1);
  });

  it("a steady tone has no range", () => {
    expectWithin(computeR128(stereo(tone(-23, 20)), FS).lra, 0, 0.1);
  });
});

describe("true peak", () => {
  it("finds the inter-sample peak a sample-peak meter misses", () => {
    // a 12 kHz tone at 48 kHz (a quarter of the rate) sampled 45° off its
    // crest lands every sample at ±0.707: a sample peak of −3.01 dBFS on a
    // waveform that reaches 0 dBFS between the samples
    const x = sine(12_000, 0, 5, FS, Math.PI / 4);
    const samplePeak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expectWithin(20 * Math.log10(samplePeak), -3.01, 0.01);
    const tp = computeR128(stereo(x), FS).truePeakDb ?? NaN;
    expect(tp).toBeLessThanOrEqual(0.2);
    expect(tp).toBeGreaterThanOrEqual(-0.4);
  });

  it("is the sample peak when the samples already hold the crest", () => {
    expectWithin(computeR128([tone(-6, 5)], FS).truePeakDb, -6, 0.01);
  });
});
