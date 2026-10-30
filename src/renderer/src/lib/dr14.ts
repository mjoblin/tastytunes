import { albumDr14, roundHalfEven } from "@shared/model";
import { fed, type Sink, type Tape } from "./stream/tape";

// the album value and the rounding live in shared/model (main records an album the moment
// its last track is measured, 2026-10-12); re-exported for the renderer's callers
export { albumDr14 };
/**
 * TT dynamic range — the "DR" integer of the loudness-war database
 * (dr.loudness-war.info) — ported line-for-line from the reference
 * implementation that community accepts submissions from: dr14_t.meter's
 * compute_dr14 (Simone Riva, GPL-3). The procedure: per channel, split
 * into 3-second blocks; block RMS carries a 2x energy factor (a full-scale
 * sine reads -3 dB); average the loudest 20% of blocks in the power
 * domain; divide the SECOND-highest block peak by that average; the DR is
 * the channel mean of those ratios in dB, rounded to an integer.
 *
 * The reference's quirks are load-bearing and reproduced deliberately —
 * validation (dev/validate-dr.mjs in ops) demands exact integer agreement
 * with the reference source running on identical samples:
 *  - a block is 3 × (rate + 60) samples at exactly 44100 Hz (delta_fs), so 180 samples
 *    wider than 3 s;
 *  - a tail row is always allocated and stays zero when the track divides
 *    evenly into blocks — and those zeros take part in the sorts;
 *  - the tail slice DROPS THE FINAL SAMPLE (the reference's Y[a : N-1]);
 *  - the second-highest peak index wraps numpy-style, so a sub-3s
 *    single-block track reads its only row;
 *  - a channel is zeroed when its loud-block power sits under the 2^-24
 *    silence floor or its ratio exceeds the 24-bit dynamic range;
 *  - the channel mean rounds half-to-even (Python 3's round()).
 * One divergence, documented: a track whose length is exactly one sample
 * past a block boundary crashes the reference (max of an empty slice);
 * here that tail row simply stays zero.
 */

const AUDIO_MIN = 1 / 2 ** 24;
const MAX_DYNAMIC_24BIT = 20 * Math.log10(2 ** 24);

export function computeDr14(channels: readonly Float32Array[], sampleRate: number): number {
  const ch = channels.length;
  if (ch === 0 || channels[0].length === 0) return 0;
  return fed(new Dr14Sink(sampleRate, ch, channels[0].length), channels).dr();
}

/**
 * DR IN PIECES (0.14.0, analysis with no size limit): the same blocks, each channel's sums kept as
 * its samples arrive, in the order and the arithmetic of the whole-track pass, the reference's
 * quirks with them (the tail drops the track's last sample; an empty tail row takes part in the
 * sorts). computeDr14 feeds it the whole track, so there is one way DR is measured.
 */
export class Dr14Sink implements Sink {
  private readonly ch: number;
  private readonly frames: number;
  private readonly blockSamples: number;
  private readonly segCnt: number;
  /** Where the tail row starts: the first sample after the last full block. */
  private readonly tailStart: number;
  private readonly rms: Float64Array[];
  private readonly peaks: Float64Array[];
  private readonly sumSq: Float64Array;
  private readonly max: Float64Array;
  private k = 0;
  constructor(sampleRate: number, channels: number, frames: number) {
    this.ch = channels;
    this.frames = frames;
    const deltaFs = sampleRate === 44100 ? 60 : 0;
    this.blockSamples = 3 * (sampleRate + deltaFs);
    this.segCnt = Math.floor(frames / this.blockSamples) + 1;
    this.tailStart = (this.segCnt - 1) * this.blockSamples;
    this.rms = Array.from({ length: channels }, () => new Float64Array(this.segCnt));
    this.peaks = Array.from({ length: channels }, () => new Float64Array(this.segCnt));
    this.sumSq = new Float64Array(channels);
    this.max = new Float64Array(channels);
  }
  get needs(): number {
    return this.k < this.frames ? this.k : Infinity;
  }
  take(tape: Tape): void {
    const { ch, frames, blockSamples, tailStart, sumSq, max } = this;
    const end = Math.min(tape.end, frames);
    for (let k = this.k; k < end; k++) {
      // the tail row leaves out the track's last sample (the reference's Y[a : N-1])
      if (!(k >= tailStart && k === frames - 1))
        for (let c = 0; c < ch; c++) {
          const v = tape.chan[c][k - tape.base];
          sumSq[c] += v * v;
          const a = Math.abs(v);
          if (a > max[c]) max[c] = a;
        }
      if (k < tailStart && (k + 1) % blockSamples === 0) {
        const i = (k + 1) / blockSamples - 1;
        for (let c = 0; c < ch; c++) {
          this.rms[c][i] = Math.sqrt((2 * sumSq[c]) / blockSamples);
          this.peaks[c][i] = max[c];
          sumSq[c] = 0;
          max[c] = 0;
        }
      }
    }
    this.k = end;
  }
  /** The DR, once every sample is read. */
  dr(): number {
    const { ch, frames, tailStart, segCnt } = this;
    if (ch === 0 || frames === 0) return 0;
    let drSum = 0;
    for (let c = 0; c < ch; c++) {
      const rms = this.rms[c];
      const peaks = this.peaks[c];
      if (tailStart < frames) {
        const n = frames - 1 - tailStart;
        if (n > 0) {
          rms[segCnt - 1] = Math.sqrt((2 * this.sumSq[c]) / n);
          peaks[segCnt - 1] = this.max[c];
        }
      }
      peaks.sort();
      rms.sort();
      let nBlk = Math.floor(segCnt * 0.2);
      if (nBlk === 0) nBlk = 1;
      let rmsSum = 0;
      for (let i = segCnt - nBlk; i < segCnt; i++) rmsSum += rms[i] * rms[i];
      const secondPeak = peaks[segCnt >= 2 ? segCnt - 2 : segCnt - 2 + segCnt];
      let v = -20 * Math.log10(Math.sqrt(rmsSum / nBlk) / secondPeak);
      if (rmsSum < AUDIO_MIN || Math.abs(v) > MAX_DYNAMIC_24BIT) v = 0;
      drSum += v;
    }
    return roundHalfEven(drSum / ch);
  }
}
