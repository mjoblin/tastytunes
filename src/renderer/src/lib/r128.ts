import { LOUD_HIST_BINS, LOUD_HIST_MIN, LOUD_HIST_STEP, LOUD_OFFSET } from "@shared/model";

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

/** 4× oversampling around candidate samples with a windowed-sinc, 12 taps
 *  per phase — the inter-sample peaks a converter would reproduce. */
function truePeak(chans: readonly Float32Array[], samplePeak: number): number {
  const TAPS = 12;
  const half = TAPS / 2;
  const phases: number[][] = [];
  for (let ph = 1; ph < 4; ph++) {
    const frac = ph / 4;
    const taps: number[] = [];
    let norm = 0;
    for (let k = -half + 1; k <= half; k++) {
      const x = k - frac;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      // Blackman–Harris window over the tap span
      const t = (x + half) / TAPS;
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
  // only samples within 6 dB of the sample peak can hide a higher true peak
  const gate = samplePeak * 0.5;
  let max = samplePeak;
  for (const data of chans) {
    const n = data.length;
    for (let i = half; i < n - half; i++) {
      if (Math.abs(data[i]) < gate) continue;
      for (const taps of phases) {
        let acc = 0;
        for (let k = 0; k < TAPS; k++) acc += taps[k] * data[i - half + 1 + k];
        const a = Math.abs(acc);
        if (a > max) max = a;
      }
    }
  }
  return max;
}

export function computeR128(chans: readonly Float32Array[], sampleRate: number): R128 {
  const hist = new Array<number>(LOUD_HIST_BINS).fill(0);
  const frames = chans[0]?.length ?? 0;
  if (frames === 0 || sampleRate <= 0) return { lufs: null, lra: null, truePeakDb: null, hist };
  const hop = Math.round(sampleRate / 10); // 100 ms
  const hops = Math.floor(frames / hop);
  // per-channel K-weighted energy per 100 ms hop
  const hopEnergy = new Float64Array(hops);
  const [s1, s2] = kWeighting(sampleRate);
  let samplePeak = 0;
  for (let c = 0; c < chans.length; c++) {
    const x = chans[c];
    const g = weight(c, chans.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0; // stage 1 state
    let u1 = 0;
    let u2 = 0;
    let v1 = 0;
    let v2 = 0; // stage 2 state
    for (let h = 0; h < hops; h++) {
      let e = 0;
      const start = h * hop;
      const end = start + hop;
      for (let i = start; i < end; i++) {
        const xi = x[i];
        const ax = xi < 0 ? -xi : xi;
        if (ax > samplePeak) samplePeak = ax;
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
      hopEnergy[h] += (g * e) / hop;
    }
  }
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
  const tp = truePeak(chans, samplePeak);
  return { lufs, lra, truePeakDb: tp > 0 ? 20 * Math.log10(tp) : null, hist };
}
