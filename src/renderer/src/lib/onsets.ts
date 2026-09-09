import type { AnalysisOnsets } from "@shared/model";
import { Fft, b64, unb64 } from "./featureStrip";

/**
 * DRUM ONSETS (0.8.0, display mode's hits). The decode that leaves the strip
 * behind also finds every percussive onset in the file, once, so a scene can
 * strike exactly when the drum does instead of guessing from a loudness read
 * ten times a second. SuperFlux, in short (Böck & Widmer, 2013): a
 * log-magnitude spectrogram on log-spaced bands every 10 ms, the half-wave
 * rectified difference against a maximum-filtered earlier frame (so vibrato
 * and glides do not count), and peaks picked against a local mean. Each
 * onset is typed by where its flux is densest: below 150 Hz a KICK, mostly
 * above 2.5 kHz a HAT, otherwise a SNARE. A plucked bass note that attacks
 * hard reads as a kick, and nothing short of stem separation would say
 * otherwise; brushes and walls of distorted guitar confuse any detector.
 * Stored four bytes an onset beside the analysis (lib/audioAnalysis).
 */
export const ONSET_TYPES = ["kick", "snare", "hat"] as const;
export type OnsetType = (typeof ONSET_TYPES)[number];

export interface Onsets {
  /** Seconds, ascending, on a 10 ms grid. */
  at: Float32Array;
  /** 0..1 against the track's own strongest hits. */
  strength: Float32Array;
  /** Index into ONSET_TYPES. */
  type: Uint8Array;
}

/** The analysis grid: 10 ms steps, a 1024-point window (2048 above 60 kHz). */
export const ONSET_HOP_MS = 10;
/** Frames the flux looks back (20 ms): a drum's rise, not a swell's. */
const LAG = 2;
/** Log compression of a magnitude whose full scale is 1. */
const LAMBDA = 100;
const LOWEST_HZ = 30;
const HIGHEST_HZ = 16_000;
const KICK_HZ = 150;
const HAT_HZ = 2500;
// peak picking, in frames: a peak is the maximum of ±30 ms, above the mean of
// −100..+70 ms by delta, and 30 ms from the last one
const PRE_MAX = 3;
const POST_MAX = 3;
const PRE_AVG = 10;
const POST_AVG = 7;
const COMBINE = 3;
/** Delta as a share of the track's 98th-percentile flux; the floor keeps silence silent. */
const DELTA_SHARE = 0.12;
const DELTA_FLOOR = 0.05;
/** Strength is against the 90th percentile of the track's own peaks (its accents are 1),
 *  so a floor can tell an accent from a ghost note; peaks under this share are not kept. */
const ACCENT_PERCENTILE = 0.9;
const KEEP_FROM = 0.08;

interface Bank {
  /** Per band: first bin and one past the last. */
  lo: Int32Array;
  hi: Int32Array;
  /** Per band: center frequency. */
  hz: Float32Array;
}

/** Log-spaced bands, six an octave, never narrower than a bin (so each holds one). */
function filterbank(sampleRate: number, n: number): Bank {
  const binW = sampleRate / n;
  const top = Math.min(HIGHEST_HZ, sampleRate * 0.45);
  const edges: number[] = [LOWEST_HZ];
  const ratio = Math.pow(2, 1 / 6);
  while (edges[edges.length - 1] < top) {
    const f = edges[edges.length - 1];
    edges.push(Math.max(f * ratio, f + binW));
  }
  const lo: number[] = [];
  const hi: number[] = [];
  const hz: number[] = [];
  for (let b = 0; b + 1 < edges.length; b++) {
    const a = Math.max(1, Math.ceil(edges[b] / binW));
    const z = Math.min(n / 2, Math.ceil(edges[b + 1] / binW));
    if (z <= a) continue;
    lo.push(a);
    hi.push(z);
    hz.push(Math.sqrt(edges[b] * edges[b + 1]));
  }
  return { lo: Int32Array.from(lo), hi: Int32Array.from(hi), hz: Float32Array.from(hz) };
}

/** The onsets and the flux they were picked from (the beat tracker reads the flux). */
export function analyzeOnsets(
  chans: readonly Float32Array[],
  sampleRate: number,
): { onsets: Onsets; flux: Float32Array } {
  const frames = chans[0].length;
  const hop = Math.max(1, Math.round((sampleRate * ONSET_HOP_MS) / 1000));
  const count = Math.max(1, Math.floor(frames / hop));
  const n = sampleRate > 60_000 ? 2048 : 1024;
  const bank = filterbank(sampleRate, n);
  const nb = bank.lo.length;
  const fft = new Fft(n);
  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const ref = (n / 4) * (n / 4);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const inv = 1 / chans.length;

  // the log-magnitude band spectrogram, frame-major
  const spec = new Float32Array(count * nb);
  for (let f = 0; f < count; f++) {
    const center = f * hop + hop / 2;
    const start = Math.round(center - n / 2);
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      let v = 0;
      if (idx >= 0 && idx < frames) for (const c of chans) v += c[idx];
      re[i] = v * inv * window[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    const row = f * nb;
    for (let b = 0; b < nb; b++) {
      let power = 0;
      for (let k = bank.lo[b]; k < bank.hi[b]; k++) power += re[k] * re[k] + im[k] * im[k];
      spec[row + b] = Math.log1p(Math.sqrt(power / ref) * LAMBDA);
    }
  }

  // the flux: what rose in each band against the (max-filtered) frame LAG frames back
  const flux = new Float32Array(count);
  const rise = (t: number, b: number): number => {
    const p = (t - LAG) * nb;
    const prev = Math.max(
      spec[p + b],
      b > 0 ? spec[p + b - 1] : 0,
      b + 1 < nb ? spec[p + b + 1] : 0,
    );
    return Math.max(0, spec[t * nb + b] - prev);
  };
  for (let t = LAG; t < count; t++) {
    let s = 0;
    for (let b = 0; b < nb; b++) s += rise(t, b);
    flux[t] = s;
  }

  // the scale of this track's hits
  const sorted = Float32Array.from(flux).sort();
  const p98 = sorted[Math.min(count - 1, Math.floor(count * 0.98))] || 0;
  const delta = Math.max(DELTA_FLOOR, p98 * DELTA_SHARE);

  const picks: number[] = [];
  const raw: number[] = [];
  let last = -Infinity;
  for (let t = LAG; t < count; t++) {
    const v = flux[t];
    if (v <= 0 || t - last < COMBINE) continue;
    let isMax = true;
    for (let k = Math.max(0, t - PRE_MAX); k <= Math.min(count - 1, t + POST_MAX); k++)
      if (flux[k] > v) {
        isMax = false;
        break;
      }
    if (!isMax) continue;
    let sum = 0;
    let m = 0;
    for (let k = Math.max(0, t - PRE_AVG); k <= Math.min(count - 1, t + POST_AVG); k++) {
      sum += flux[k];
      m++;
    }
    if (v < sum / m + delta) continue;
    last = t;
    picks.push(t);
    raw.push(v);
  }
  const peaks = Float32Array.from(raw).sort();
  const accent =
    peaks[Math.min(peaks.length - 1, Math.floor(peaks.length * ACCENT_PERCENTILE))] || 1;
  const at: number[] = [];
  const strength: number[] = [];
  const type: number[] = [];
  for (let i = 0; i < picks.length; i++) {
    const s = Math.min(1, raw[i] / accent);
    if (s < KEEP_FROM) continue;
    at.push((picks[i] * ONSET_HOP_MS) / 1000);
    strength.push(s);
    type.push(typeAt(bank, rise, picks[i]));
  }
  return {
    onsets: {
      at: Float32Array.from(at),
      strength: Float32Array.from(strength),
      type: Uint8Array.from(type),
    },
    flux,
  };
}

export function computeOnsets(chans: readonly Float32Array[], sampleRate: number): Onsets {
  return analyzeOnsets(chans, sampleRate).onsets;
}

/** Where a hit's flux is densest (per band, so three bass bands can outweigh forty). */
function typeAt(bank: Bank, rise: (t: number, b: number) => number, t: number): number {
  let low = 0;
  let mid = 0;
  let high = 0;
  let nl = 0;
  let nm = 0;
  let nh = 0;
  for (let b = 0; b < bank.hz.length; b++) {
    const r = rise(t, b);
    if (bank.hz[b] < KICK_HZ) {
      low += r;
      nl++;
    } else if (bank.hz[b] < HAT_HZ) {
      mid += r;
      nm++;
    } else {
      high += r;
      nh++;
    }
  }
  const dl = nl ? low / nl : 0;
  const dm = nm ? mid / nm : 0;
  const dh = nh ? high / nh : 0;
  if (dl >= 0.6 * Math.max(dm, dh)) return 0;
  if (dh >= 1.5 * dm) return 2;
  return 1;
}

/** Disk shape: four bytes an onset (u16 gap in 10 ms steps, u8 strength, u8 type), base64. */
export function onsetsToStored(o: Onsets): AnalysisOnsets {
  const bytes = new Uint8Array(o.at.length * 4);
  let prev = 0;
  for (let i = 0; i < o.at.length; i++) {
    const step = Math.round((o.at[i] * 1000) / ONSET_HOP_MS);
    const gap = Math.max(0, Math.min(65_535, step - prev));
    prev += gap;
    bytes[i * 4] = gap & 0xff;
    bytes[i * 4 + 1] = gap >> 8;
    bytes[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, o.strength[i])) * 255);
    bytes[i * 4 + 3] = o.type[i];
  }
  return { count: o.at.length, data: b64(bytes) };
}

export function onsetsFromStored(st: AnalysisOnsets): Onsets {
  const bytes = unb64(st.data);
  const count = Math.min(st.count, Math.floor(bytes.length / 4));
  const at = new Float32Array(count);
  const strength = new Float32Array(count);
  const type = new Uint8Array(count);
  let step = 0;
  for (let i = 0; i < count; i++) {
    step += bytes[i * 4] | (bytes[i * 4 + 1] << 8);
    at[i] = (step * ONSET_HOP_MS) / 1000;
    strength[i] = bytes[i * 4 + 2] / 255;
    type[i] = Math.min(ONSET_TYPES.length - 1, bytes[i * 4 + 3]);
  }
  return { at, strength, type };
}
