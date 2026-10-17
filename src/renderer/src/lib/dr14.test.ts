/**
 * TT dynamic range (the "DR" integer) on signals whose answer can be worked
 * out by hand.
 *
 * The meter's block RMS is sqrt(2·mean(x²)): the 2× energy factor makes a
 * sine's RMS equal its peak, so a steady sine has no dynamic range at all.
 * DR is then the second-highest block peak over the RMS of the loudest 20%
 * of 3-second blocks, in dB, per channel, averaged and rounded half to even.
 */
import { describe, expect, it } from "vitest";
import { albumDr14, computeDr14 } from "./dr14";
import { sine } from "./__fixtures__/synthAudio";

const FS = 44_100;

/** A −20 dBFS tone with one full-scale sample every second: peak 1.0, RMS 0.1. */
function tonedWithClicks(fs: number, secs = 30): Float32Array {
  const x = sine(1000, -20, secs, fs);
  for (let i = 1000; i < x.length; i += fs) x[i] = 1;
  return x;
}

describe("computeDr14", () => {
  it("reads a steady sine as DR0: with the 2× factor its RMS is its peak", () => {
    expect(computeDr14([sine(1000, -6, 30, FS)], FS)).toBe(0);
    expect(computeDr14([sine(440, -1, 30, FS), sine(440, -1, 30, FS)], FS)).toBe(0);
  });

  it("reads a square wave as −3: the 2× factor puts its RMS 3 dB over its peak", () => {
    const square = new Float32Array(30 * FS).map((_, i) => (Math.floor(i / 22) % 2 ? 0.5 : -0.5));
    expect(computeDr14([square], FS)).toBe(-3);
  });

  it("is the peak over the RMS: a −20 dBFS tone with full-scale clicks reads 20", () => {
    // 20·log10(1.0 / 0.1); the clicks raise the RMS by a hundredth of a dB
    expect(computeDr14([tonedWithClicks(FS)], FS)).toBe(20);
  });

  it("averages only the loudest 20% of blocks", () => {
    // thirty seconds is ten blocks (nine 3 s blocks and the tail): two loud
    // blocks at −10 dBFS with a click each, eight at −40 that cannot count
    const x = sine(1000, -40, 30, FS);
    const block = 3 * (FS + 60); // the reference's block at 44.1 kHz, a little over 3 s
    const loud = sine(1000, -10, (2 * block) / FS, FS);
    x.set(loud.subarray(0, 2 * block));
    x[1000] = 1;
    x[block + 1000] = 1;
    // 20·log10(1.0 / 0.316) = 10; averaging every block would read 17
    expect(computeDr14([x], FS)).toBe(10);
  });

  it("takes the channel mean, rounded", () => {
    expect(computeDr14([tonedWithClicks(FS), sine(1000, -6, 30, FS)], FS)).toBe(10);
  });

  it("reads the same at 48 kHz, where blocks are exactly 3 s", () => {
    expect(computeDr14([tonedWithClicks(48_000)], 48_000)).toBe(20);
  });

  it("reads a track shorter than one block from its only block", () => {
    expect(computeDr14([sine(1000, -6, 2, FS)], FS)).toBe(0);
  });

  it("reads silence as 0, not as infinite range", () => {
    expect(computeDr14([new Float32Array(30 * FS)], FS)).toBe(0);
    expect(computeDr14([], FS)).toBe(0);
    expect(computeDr14([new Float32Array(0)], FS)).toBe(0);
  });
});

describe("albumDr14", () => {
  it("is the mean of the tracks' integer DRs, rounded half to even", () => {
    expect(albumDr14([8, 9])).toBe(8);
    expect(albumDr14([9, 10])).toBe(10);
    expect(albumDr14([7, 8, 12])).toBe(9);
    // a silent interlude's DR0 counts in the mean
    expect(albumDr14([10, 10, 0])).toBe(7);
    expect(albumDr14([])).toBe(0);
  });
});
