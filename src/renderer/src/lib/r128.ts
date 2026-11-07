import { LOUD_HIST_BINS, LOUD_HIST_MIN, LOUD_HIST_STEP, LOUD_OFFSET } from "@shared/model";
import { fed, type Sink, type Tape } from "./stream/tape";

/**
 * EBU R128 / ITU-R BS.1770-4 loudness over decoded PCM (0.8.0). One home:
 * K-weighting (a high shelf and a high-pass, coefficients derived for the
 * file's own sample rate), 400 ms blocks at 75 % overlap, the −70 LUFS
 * absolute gate and the −10 LU relative gate → integrated loudness; the
 * loudness range (EBU Tech 3342: 3 s windows at 10 Hz, −20 LU relative gate,
 * 10th to 95th percentile); and the true peak, 4× oversampled around the
 * samples that could exceed it. The gated block histogram rides along so an
 * album integrates across its tracks (shared/model integrateLoudnessHistograms).
 * Validated against ffmpeg's ebur128 on the fixtures (dev/audio-fixtures).
 */
export interface R128 {
  lufs: number | null;
  lra: number | null;
  truePeakDb: number | null;
  hist: number[];
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The two K-weighting stages for a sample rate (the libebur128 derivation). */
function kWeighting(fs: number): [Biquad, Biquad] {
  // stage 1: the high shelf (+4 dB above ~1.5 kHz)
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  const a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // stage 2: the RLB high-pass (~38 Hz)
  const f1 = 38.13547087602444;
  const Q1 = 0.5003270373238773;
  const K1 = Math.tan((Math.PI * f1) / fs);
  const a01 = 1 + K1 / Q1 + K1 * K1;
  const hp: Biquad = {
    b0: 1 / a01,
    b1: -2 / a01,
    b2: 1 / a01,
    a1: (2 * (K1 * K1 - 1)) / a01,
    a2: (1 - K1 / Q1 + K1 * K1) / a01,
  };
  return [shelf, hp];
}

/** Channel weights per BS.1770: L, R, C at 1; Ls, Rs at 1.41. */
const weight = (ch: number, total: number): number =>
  total >= 5 && (ch === 3 || ch === 4) ? 1.41 : 1;

const loudness = (energy: number): number => LOUD_OFFSET + 10 * Math.log10(energy);

/** 4× oversampling with a windowed-sinc, 12 taps per phase: the inter-sample peaks a converter
 *  would reproduce. The three phases' taps, made once. */
const TAPS = 12;
const HALF = TAPS / 2;
const PHASES: number[][] = (() => {
  const phases: number[][] = [];
  for (let ph = 1; ph < 4; ph++) {
    const frac = ph / 4;
    const taps: number[] = [];
    let norm = 0;
    for (let k = -HALF + 1; k <= HALF; k++) {
      const x = k - frac;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      // Blackman–Harris window over the tap span
      const t = (x + HALF) / TAPS;
      const w =
        0.35875 -
        0.48829 * Math.cos(2 * Math.PI * t) +
        0.14128 * Math.cos(4 * Math.PI * t) -
        0.01168 * Math.cos(6 * Math.PI * t);
      taps.push(sinc * w);
      norm += sinc * w;
    }
    phases.push(taps.map((v) => v / norm));
  }
  return phases;
})();

export function computeR128(chans: readonly Float32Array[], sampleRate: number): R128 {
  const frames = chans[0]?.length ?? 0;
  if (frames === 0 || sampleRate <= 0)
    return {
      lufs: null,
      lra: null,
      truePeakDb: null,
      hist: new Array<number>(LOUD_HIST_BINS).fill(0),
    };
  return fed(new R128Sink(sampleRate, chans.length, frames), chans).result();
}

/**
 * LOUDNESS IN PIECES (0.14.0, analysis with no size limit): each 100 ms hop's K-weighted energy as
 * its samples arrive, every channel's filter state carried across pieces and the channels added
 * in their order, as the whole-track pass added them; the blocks, the gates and the range once the
 * track has arrived. computeR128 feeds it the whole track, so there is one way loudness is
 * measured.
 *
 * THE TRUE PEAK, EXACTLY, WITHOUT A SECOND PASS: only samples within 6 dB of the track's sample
 * peak can hide a higher true peak, and that peak is known only at the end. A sample is looked at
 * here against half the peak so far, which is never above the end's, so every sample the
 * whole-track pass looked at is looked at here too (and some more). What each gives is kept as a
 * frontier: a sample's level and its highest interpolated value, a pair dropped once a louder
 * sample gives as much, or once its level falls under half the peak so far (then it can never
 * count). At the end, the highest value among the levels at or over half the final peak is the
 * whole-track pass's answer, to the bit.
 */
export class R128Sink implements Sink {
  private readonly ch: number;
  private readonly frames: number;
  private readonly hop: number;
  private readonly hops: number;
  private readonly hopEnergy: Float64Array;
  private readonly s1: Biquad;
  private readonly s2: Biquad;
  /** Each channel's filter state: x1 x2 y1 y2 (stage 1), u1 u2 v1 v2 (stage 2). */
  private readonly state: Float64Array;
  private samplePeak = 0;
  /** The next hop to read. */
  private h = 0;
  /** The next sample to look at for the true peak. */
  private tk = HALF;
  /** The frontier: levels ascending, values descending. */
  private readonly levels: number[] = [];
  private readonly values: number[] = [];
  constructor(sampleRate: number, channels: number, frames: number) {
    this.ch = channels;
    this.frames = frames;
    this.hop = Math.round(sampleRate / 10); // 100 ms
    this.hops = Math.floor(frames / this.hop);
    // per-channel K-weighted energy per 100 ms hop
    this.hopEnergy = new Float64Array(this.hops);
    [this.s1, this.s2] = kWeighting(sampleRate);
    this.state = new Float64Array(channels * 8);
  }
  get needs(): number {
    const hops = this.h < this.hops ? this.h * this.hop : Infinity;
    const peak = this.tk < this.frames - HALF ? this.tk - HALF + 1 : Infinity;
    return Math.min(hops, peak);
  }
  take(tape: Tape): void {
    this.readHops(tape);
    this.readPeaks(tape);
  }
  private readHops(tape: Tape): void {
    const { ch, hop, hopEnergy, s1, s2, state } = this;
    for (; this.h < this.hops && (this.h + 1) * hop <= tape.end; this.h++) {
      const h = this.h;
      const start = h * hop;
      const end = start + hop;
      for (let c = 0; c < ch; c++) {
        const x = tape.chan[c];
        const g = weight(c, ch);
        const o = c * 8;
        let x1 = state[o];
        let x2 = state[o + 1];
        let y1 = state[o + 2];
        let y2 = state[o + 3];
        let u1 = state[o + 4];
        let u2 = state[o + 5];
        let v1 = state[o + 6];
        let v2 = state[o + 7];
        let e = 0;
        for (let i = start; i < end; i++) {
          const xi = x[i - tape.base];
          const ax = xi < 0 ? -xi : xi;
          if (ax > this.samplePeak) this.samplePeak = ax;
          const y = s1.b0 * xi + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
          x2 = x1;
          x1 = xi;
          y2 = y1;
          y1 = y;
          const v = s2.b0 * y + s2.b1 * u1 + s2.b2 * u2 - s2.a1 * v1 - s2.a2 * v2;
          u2 = u1;
          u1 = y;
          v2 = v1;
          v1 = v;
          e += v * v;
        }
        state[o] = x1;
        state[o + 1] = x2;
        state[o + 2] = y1;
        state[o + 3] = y2;
        state[o + 4] = u1;
        state[o + 5] = u2;
        state[o + 6] = v1;
        state[o + 7] = v2;
        hopEnergy[h] += (g * e) / hop;
      }
    }
  }
  private readPeaks(tape: Tape): void {
    // a sample needs the five before it and the six after it
    const last = Math.min(this.frames - HALF, tape.end - HALF);
    const gate = this.samplePeak * 0.5;
    this.prune(gate);
    for (; this.tk < last; this.tk++) {
      const i = this.tk;
      for (let c = 0; c < this.ch; c++) {
        const data = tape.chan[c];
        const at = i - tape.base;
        const level = Math.abs(data[at]);
        if (level < gate) continue;
        let best = 0;
        for (const taps of PHASES) {
          let acc = 0;
          for (let k = 0; k < TAPS; k++) acc += taps[k] * data[at - HALF + 1 + k];
          const a = Math.abs(acc);
          if (a > best) best = a;
        }
        this.keep(level, best);
      }
    }
  }
  /** Add a level's value to the frontier, unless a louder level already gives as much. */
  private keep(level: number, value: number): void {
    const { levels, values } = this;
    let lo = 0;
    let hi = levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (levels[mid] < level) lo = mid + 1;
      else hi = mid;
    }
    // lo: the first level at or over this one
    if (lo < levels.length && values[lo] >= value) return;
    // this one outdoes the quieter levels' values it reaches, and an equal level's
    let from = lo;
    while (from > 0 && values[from - 1] <= value) from--;
    const to = lo < levels.length && levels[lo] === level ? lo + 1 : lo;
    levels.splice(from, to - from, level);
    values.splice(from, to - from, value);
  }
  /** Drop the levels under the gate: they can never count. */
  private prune(gate: number): void {
    let n = 0;
    while (n < this.levels.length && this.levels[n] < gate) n++;
    if (n > 0) {
      this.levels.splice(0, n);
      this.values.splice(0, n);
    }
  }
  /** Loudness, its range and the true peak, once every sample is read. */
  result(): R128 {
    const { hopEnergy } = this;
    const hops = this.hops;
    const hist = new Array<number>(LOUD_HIST_BINS).fill(0);
    // 400 ms blocks at 100 ms steps: the mean of four hops
    const blocks: number[] = [];
    for (let h = 0; h + 4 <= hops; h++) {
      const e = (hopEnergy[h] + hopEnergy[h + 1] + hopEnergy[h + 2] + hopEnergy[h + 3]) / 4;
      if (e <= 0) continue;
      const l = loudness(e);
      if (l <= LOUD_HIST_MIN) continue; // the absolute gate
      blocks.push(e);
      const bin = Math.min(
        LOUD_HIST_BINS - 1,
        Math.max(0, Math.floor((l - LOUD_HIST_MIN) / LOUD_HIST_STEP)),
      );
      hist[bin]++;
    }
    let lufs: number | null = null;
    if (blocks.length > 0) {
      const mean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
      const threshold = loudness(mean) - 10;
      const kept = blocks.filter((e) => loudness(e) > threshold);
      if (kept.length > 0) lufs = loudness(kept.reduce((a, b) => a + b, 0) / kept.length);
    }
    // loudness range: 3 s windows at the standard's 10 Hz (EBU Tech 3342)
    let lra: number | null = null;
    const shortTerm: number[] = [];
    for (let h = 0; h + 30 <= hops; h++) {
      let e = 0;
      for (let k = 0; k < 30; k++) e += hopEnergy[h + k];
      e /= 30;
      if (e > 0 && loudness(e) > LOUD_HIST_MIN) shortTerm.push(e);
    }
    if (shortTerm.length >= 2) {
      const mean = shortTerm.reduce((a, b) => a + b, 0) / shortTerm.length;
      const threshold = loudness(mean) - 20;
      const kept = shortTerm
        .filter((e) => loudness(e) > threshold)
        .map(loudness)
        .sort((a, b) => a - b);
      if (kept.length >= 2) {
        const at = (q: number): number =>
          kept[Math.min(kept.length - 1, Math.max(0, Math.round(q * (kept.length - 1))))];
        lra = at(0.95) - at(0.1);
      }
    }
    // the true peak: the frontier's highest value among the levels at or over half the peak
    const gate = this.samplePeak * 0.5;
    let tp = this.samplePeak;
    const first = this.levels.findIndex((l) => l >= gate);
    if (first >= 0 && this.values[first] > tp) tp = this.values[first];
    return { lufs, lra, truePeakDb: tp > 0 ? 20 * Math.log10(tp) : null, hist };
  }
}
