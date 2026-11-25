import { describe, expect, it } from "vitest";
import { MeasureStream, measureTrack } from "../measure";
import { featuresFromStored, featuresToStored } from "../features";
import { feed, Tape } from "./tape";
import { drumTrack, noise } from "../__fixtures__/synthAudio";

// ANALYSIS WITH NO SIZE LIMIT (0.14.0): the measures read a tape that holds a little of the track
// at a time. On the round's first cut, before the strip's loudness fix, every field matched the
// old whole-track code's to the bit, at 44.1 to 192 kHz, mono to six channels, in pieces from 999
// frames to the whole track; these hold the pieces to the whole from now on.

const track = (rate: number, secs: number, channels: number): Float32Array[] => {
  const l = drumTrack(118, secs, rate, { hats: true }).samples;
  const rnd = noise(3);
  const out = [l];
  for (let c = 1; c < channels; c++)
    out.push(l.map((v, i) => v * (0.9 - c * 0.1) + (rnd() - 0.5) * 0.04 + 0.1 * Math.sin(i / 40)));
  return out;
};

describe("the measurement in pieces", () => {
  for (const [rate, ch, secs] of [
    [44100, 2, 9],
    [192000, 2, 3],
    [48000, 6, 3],
  ] as const)
    it(`is the whole track's, to the bit (${rate} Hz, ${ch} channels)`, () => {
      const chans = track(rate, secs, ch);
      const whole = measureTrack(chans, rate, true, 1200);
      for (const piece of [999, 4096, 1 << 23]) {
        const m = new MeasureStream(rate, ch, chans[0].length, true, 1200);
        feed(m.sinks, chans, piece);
        expect(m.measured()).toEqual(whole);
      }
    });

  // the honesty rule (S53, S68): a decode at another rate than the file's own still draws the
  // waveform, but DR, loudness and the scenes' share are withheld, never approximated
  it("withholds DR, loudness and the scenes' share at a rate not the file's own", () => {
    const chans = track(44100, 6, 2);
    const own = measureTrack(chans, 44100, true, 600);
    const other = measureTrack(chans, 44100, false, 600);
    expect(own.dr).toBeGreaterThan(0);
    expect(own.lufs).not.toBeNull();
    expect(other.dr).toBe(0);
    expect([other.lufs, other.lra, other.truePeakDb, other.loudHist]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect([other.strip, other.onsets, other.features]).toEqual([null, null, null]);
    expect(other.peak).toEqual(own.peak);
    expect(other.peakDb).toBe(own.peakDb);
  });

  it("draws the waveform's buckets as the file arrives", () => {
    const chans = track(44100, 6, 2);
    const m = new MeasureStream(44100, 2, chans[0].length, true, 600);
    // a tape that has had half the track: about half the buckets are ready
    const tape = new Tape(2, chans[0].length);
    tape.push(chans.map((c) => c.subarray(0, c.length / 2)));
    for (const s of m.sinks) s.take(tape);
    const so = m.envelopes();
    expect(so.ready).toBeGreaterThan(250);
    expect(so.ready).toBeLessThan(350);
  });
});

describe("a long track's stored times", () => {
  it("keep beats past 10:55 and drops past 109 minutes", () => {
    const chans = track(44100, 8, 2);
    const f = measureTrack(chans, 44100, true, 600).features!;
    const beats = Float32Array.from({ length: 2000 }, (_, i) => 0.5 + i * 0.5);
    const long = {
      ...f,
      beats: { bpm: 120, confidence: 0.9, downbeat: 0, times: beats },
      drops: {
        ...f.drops,
        at: Float32Array.of(120, 7000.3),
        buildFrom: Float32Array.of(100, 6990.1),
        strength: Float32Array.of(0.5, 0.9),
        chill: Float32Array.of(1, 2),
        breath: Float32Array.of(1, 2),
        cut: Float32Array.of(0.1, 0.2),
      },
    };
    const back = featuresFromStored(
      JSON.parse(JSON.stringify(featuresToStored(long))) as ReturnType<typeof featuresToStored>,
    );
    expect(back.beats?.times[1999]).toBeCloseTo(1000, 2);
    expect(back.beats?.times[1500]).toBeCloseTo(750.5, 2);
    expect(Array.from(back.drops.at)).toEqual(
      [120, Math.fround(7000.3)].map((t) => Math.fround(Math.round(t * 10) / 10)),
    );
    expect(back.drops.buildFrom[1]).toBeCloseTo(6990.1, 3);
  });
});
