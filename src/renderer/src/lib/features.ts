import type { AnalysisFeatures } from "@shared/model";
import { Fft, b64, unb64, type Strip } from "./featureStrip";
import { ONSET_HOP_MS, type Onsets } from "./onsets";

/**
 * MUSIC FEATURES (0.8.0, display mode). Everything else the one decode can
 * say about a track, cheaply and honestly, so the scenes can lock to what is
 * heard: the BEAT GRID (tempo and beat times, from the onset flux; a
 * confidence gates it, since rubato defeats it), SECTIONS (novelty in the
 * strip and the chroma; the most repeated loud kind is chorus-like), CHROMA
 * and KEY (twelve pitch classes twice a second; Krumhansl-Kessler profiles
 * for the key, right about three times in four), CHORD CHANGES (chroma
 * novelty), the STEREO IMAGE (pan and width per strip frame), TIMBRE
 * (brightness and noisiness per strip frame), SILENCES, and DROPS (a sudden
 * return after three seconds of chill or one second of near silence).
 * Stored packed beside the analysis under one version: bump FEATURES_VERSION
 * and every cached track measures again once, on its next play.
 */
export const FEATURES_VERSION = 10; // 9: drops read at frame resolution around the return, earliest return wins

export interface Beats {
  bpm: number;
  confidence: number;
  /** Which beat (mod 4) is the downbeat, or −1 when the kicks did not say. */
  downbeat: number;
  /** Seconds, ascending. */
  times: Float32Array;
}
export interface Sections {
  /** Boundaries in seconds, ascending, between sections (not 0, not the end). */
  bounds: Float32Array;
  /** Per section (bounds.length + 1): 0 other, 1 chorus-like (the most repeated loud kind). */
  kinds: Uint8Array;
  /** Per section: mean energy 0..1. */
  energy: Float32Array;
}
export interface Chroma {
  fps: number;
  /** frames × 12, each frame normalized to a max of 1. */
  data: Float32Array;
}
export interface Key {
  /** 0 = C … 11 = B. */
  tonic: number;
  mode: "major" | "minor";
  confidence: number;
}
export interface Stereo {
  fps: number;
  /** −1 left … +1 right. */
  pan: Float32Array;
  /** 0 mono … 1 wide. */
  width: Float32Array;
}
export interface Timbre {
  fps: number;
  /** 0 dark … 1 bright (log spectral centroid, 100 Hz to 10 kHz). */
  brightness: Float32Array;
  /** 0 tonal … 1 noise (spectral flatness, log-scaled). */
  noisiness: Float32Array;
}
export interface Drops {
  buildFrom: Float32Array;
  at: Float32Array;
  strength: Float32Array;
  /** Seconds of notable reduction (the beat or the level down) before each drop, and seconds
   *  of definite reduction (near silence); the display picks the tier it wants. */
  chill: Float32Array;
  breath: Float32Array;
  /** Seconds of near-total cut-out right before the slam (a tenth of a second or two is the
   *  classic gasp before a drop), measured at frame resolution. */
  cut: Float32Array;
}
export interface Features {
  beats: Beats | null;
  sections: Sections | null;
  chroma: Chroma | null;
  key: Key | null;
  /** Chord changes, seconds. */
  changes: Float32Array;
  stereo: Stereo | null;
  timbre: Timbre | null;
  /** Start, end pairs in seconds. */
  silences: Float32Array;
  drops: Drops;
}

export const PITCH_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const CHROMA_FPS = 2;

export function computeFeatures(
  chans: readonly Float32Array[],
  sampleRate: number,
  strip: Strip,
  onsets: Onsets,
  flux: Float32Array,
): Features {
  const seconds = chans[0].length / sampleRate;
  const beats = trackBeats(flux, onsets);
  const chroma = computeChroma(chans, sampleRate);
  const key = keyOf(chroma);
  const changes = chordChanges(chroma);
  const stereo = computeStereo(chans, sampleRate, strip.fps);
  const timbre = computeTimbre(chans, sampleRate, strip.fps);
  const silences = findSilences(strip);
  const drops = findDrops(strip, onsets, beats);
  const sections = findSections(strip, chroma, seconds, drops);
  return { beats, sections, chroma, key, changes, stereo, timbre, silences, drops };
}

// ---------------------------------------------------------------- beats

/** Ellis (2007): a tempo from the autocorrelation of an onset envelope under a log-normal
 *  prior, then beat times by dynamic programming that rewards the envelope and penalizes
 *  leaving the period; the downbeat is the beat phase (mod 4) the kicks favour. The
 *  envelope is built from the TYPED onsets (a kick 1, a snare 0.8, a hat 0.3, each a
 *  short bump), not the raw flux: hats are broadband and out-flux the kicks, and a grid
 *  locked to the hats sits half a beat off everything the listener taps. */
function trackBeats(flux: Float32Array, onsets: Onsets): Beats | null {
  const fps = 1000 / ONSET_HOP_MS;
  const n = flux.length;
  if (n < fps * 8 || onsets.at.length < 8) return null;
  const env = new Float32Array(n);
  const weight = [1, 0.8, 0.3];
  for (let i = 0; i < onsets.at.length; i++) {
    const c = Math.round(onsets.at[i] * fps);
    const w = onsets.strength[i] * (weight[onsets.type[i]] ?? 0.5);
    for (let k = -2; k <= 2; k++) {
      const t = c + k;
      if (t >= 0 && t < n) env[t] += w * (k === 0 ? 1 : Math.abs(k) === 1 ? 0.6 : 0.2);
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (env[i] - mean) ** 2;
  const std = Math.sqrt(varSum / n) || 1;
  for (let i = 0; i < n; i++) env[i] /= std;
  // autocorrelation over 30–240 BPM, weighted toward 120
  const minLag = Math.round(fps * 0.25);
  const maxLag = Math.round(fps * 2);
  const acf = new Float32Array(maxLag + 1);
  let best = minLag;
  let bestW = -Infinity;
  const weighted = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
    acf[lag] = s / (n - lag);
    const bpm = 60 / (lag / fps);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    weighted[lag] = acf[lag] * prior;
    if (weighted[lag] > bestW) {
      bestW = weighted[lag];
      best = lag;
    }
  }
  if (bestW <= 0) return null;
  const sortedW = Float32Array.from(weighted.subarray(minLag)).sort();
  const median = sortedW[Math.floor(sortedW.length / 2)];
  const confidence = Math.max(0, Math.min(1, 1 - median / bestW));
  const period = best;
  const bpm = 60 / (period / fps);
  // dynamic programming for the beat times
  const tightness = 100;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let bestScore = 0;
    let bestFrom = -1;
    for (let tau = lo; tau <= hi; tau++) {
      const from = t - tau;
      if (from < 0) break;
      const s = score[from] - tightness * Math.log(tau / period) ** 2;
      if (s > bestScore) {
        bestScore = s;
        bestFrom = from;
      }
    }
    score[t] = env[t] + bestScore;
    back[t] = bestFrom;
  }
  // start from the best score in the last period, walk back
  let end = n - 1;
  for (let t = Math.max(0, n - period); t < n; t++) if (score[t] > score[end]) end = t;
  const beatsRev: number[] = [];
  for (let t = end; t >= 0; t = back[t]) {
    beatsRev.push(t);
    if (back[t] < 0) break;
  }
  const times = Float32Array.from(beatsRev.reverse(), (t) => t / fps);
  // the downbeat: which phase mod 4 the kicks favour
  const phaseStrength = [0, 0, 0, 0];
  let k = 0;
  for (let b = 0; b < times.length; b++) {
    while (k < onsets.at.length && onsets.at[k] < times[b] - 0.06) k++;
    for (let j = k; j < onsets.at.length && onsets.at[j] <= times[b] + 0.06; j++)
      if (onsets.type[j] === 0) phaseStrength[b % 4] += onsets.strength[j];
  }
  let downbeat = -1;
  let top = 0;
  for (let p = 0; p < 4; p++) if (phaseStrength[p] > phaseStrength[top]) top = p;
  const others = (phaseStrength.reduce((a, b) => a + b, 0) - phaseStrength[top]) / 3;
  if (phaseStrength[top] > 0 && phaseStrength[top] >= 1.25 * others) downbeat = top;
  return { bpm, confidence, downbeat, times };
}

// ---------------------------------------------------------------- chroma and key

function computeChroma(chans: readonly Float32Array[], sampleRate: number): Chroma {
  const frames = chans[0].length;
  const hop = Math.round(sampleRate / CHROMA_FPS);
  const count = Math.max(1, Math.floor(frames / hop));
  const n = sampleRate > 60_000 ? 16384 : 8192;
  const fft = new Fft(n);
  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const inv = 1 / chans.length;
  // bin → pitch class, 55 Hz to 4 kHz
  const binClass = new Int8Array(n / 2).fill(-1);
  for (let k = 1; k < n / 2; k++) {
    const hz = (k * sampleRate) / n;
    if (hz < 55 || hz > 4000) continue;
    binClass[k] = ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12 + 9) % 12; // A = 9
  }
  const data = new Float32Array(count * 12);
  for (let f = 0; f < count; f++) {
    const start = f * hop + Math.round(hop / 2) - n / 2;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      let v = 0;
      if (idx >= 0 && idx < frames) for (const c of chans) v += c[idx];
      re[i] = v * inv * window[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    const row = f * 12;
    for (let k = 1; k < n / 2; k++) {
      const pc = binClass[k];
      if (pc >= 0) data[row + pc] += re[k] * re[k] + im[k] * im[k];
    }
    let max = 0;
    for (let p = 0; p < 12; p++) {
      data[row + p] = Math.sqrt(data[row + p]);
      if (data[row + p] > max) max = data[row + p];
    }
    if (max > 0) for (let p = 0; p < 12; p++) data[row + p] /= max;
  }
  return { fps: CHROMA_FPS, data };
}

// Krumhansl-Kessler key profiles
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function keyOf(chroma: Chroma): Key | null {
  const frames = chroma.data.length / 12;
  if (frames < 4) return null;
  const mean = new Float64Array(12);
  for (let f = 0; f < frames; f++) for (let p = 0; p < 12; p++) mean[p] += chroma.data[f * 12 + p];
  const scores: { tonic: number; mode: "major" | "minor"; r: number }[] = [];
  for (const [mode, profile] of [
    ["major", MAJOR],
    ["minor", MINOR],
  ] as const) {
    for (let tonic = 0; tonic < 12; tonic++) {
      let r = 0;
      for (let p = 0; p < 12; p++) r += mean[(p + tonic) % 12] * profile[p];
      scores.push({ tonic, mode, r });
    }
  }
  scores.sort((a, b) => b.r - a.r);
  const [first, second] = scores;
  if (!first || first.r <= 0) return null;
  return {
    tonic: first.tonic,
    mode: first.mode,
    confidence: Math.max(0, Math.min(1, ((first.r - (second?.r ?? 0)) / first.r) * 8)),
  };
}

/** Chord changes: peaks of the cosine distance between the second before a frame and the
 *  second from it (no smoothing across the change itself), at least 1.5 s apart. */
function chordChanges(chroma: Chroma): Float32Array {
  const frames = chroma.data.length / 12;
  const span = chroma.fps; // one second of frames
  const out: number[] = [];
  const meanOf = (a: number, b: number, p: number): number => {
    let s = 0;
    let m = 0;
    for (let k = Math.max(0, a); k < Math.min(frames, b); k++) {
      s += chroma.data[k * 12 + p];
      m++;
    }
    return m ? s / m : 0;
  };
  const dist = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    let dot = 0;
    let a = 0;
    let b = 0;
    for (let p = 0; p < 12; p++) {
      const x = meanOf(f - span, f, p);
      const y = meanOf(f, f + span, p);
      dot += x * y;
      a += x * x;
      b += y * y;
    }
    dist[f] = a > 0 && b > 0 ? 1 - dot / Math.sqrt(a * b) : 0;
  }
  let last = -Infinity;
  for (let f = 1; f < frames; f++) {
    if (dist[f] < 0.12 || f - last < chroma.fps * 1.5) continue;
    if (dist[f] >= (dist[f - 1] ?? 0) && dist[f] >= (dist[f + 1] ?? 0)) {
      out.push(f / chroma.fps);
      last = f;
    }
  }
  return Float32Array.from(out);
}

// ---------------------------------------------------------------- stereo and timbre

function computeStereo(
  chans: readonly Float32Array[],
  sampleRate: number,
  fps: number,
): Stereo | null {
  if (chans.length < 2) return null;
  const [L, R] = chans;
  const hop = Math.max(1, Math.round(sampleRate / fps));
  const count = Math.max(1, Math.floor(L.length / hop));
  const pan = new Float32Array(count);
  const width = new Float32Array(count);
  let anyWidth = 0;
  for (let f = 0; f < count; f++) {
    let l = 0;
    let r = 0;
    let m = 0;
    let s = 0;
    const start = f * hop;
    for (let i = start; i < start + hop && i < L.length; i++) {
      l += L[i] * L[i];
      r += R[i] * R[i];
      const mid = (L[i] + R[i]) / 2;
      const side = (L[i] - R[i]) / 2;
      m += mid * mid;
      s += side * side;
    }
    const lr = Math.sqrt(l) + Math.sqrt(r);
    pan[f] = lr > 1e-9 ? (Math.sqrt(r) - Math.sqrt(l)) / lr : 0;
    const ms = Math.sqrt(m) + Math.sqrt(s);
    width[f] = ms > 1e-9 ? Math.min(1, (2 * Math.sqrt(s)) / ms) : 0;
    anyWidth = Math.max(anyWidth, width[f]);
  }
  // identical channels are mono in a stereo coat
  if (anyWidth < 0.02) return null;
  return { fps, pan, width };
}

function computeTimbre(chans: readonly Float32Array[], sampleRate: number, fps: number): Timbre {
  const frames = chans[0].length;
  const hop = Math.max(1, Math.round(sampleRate / fps));
  const count = Math.max(1, Math.floor(frames / hop));
  const n = sampleRate > 60_000 ? 4096 : 2048;
  const fft = new Fft(n);
  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const inv = 1 / chans.length;
  const kLo = Math.max(1, Math.round((100 / sampleRate) * n));
  const kHi = Math.min(n / 2 - 1, Math.round((8000 / sampleRate) * n));
  const brightness = new Float32Array(count);
  const noisiness = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    const start = f * hop + Math.round(hop / 2) - n / 2;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      let v = 0;
      if (idx >= 0 && idx < frames) for (const c of chans) v += c[idx];
      re[i] = v * inv * window[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    let sum = 0;
    let weighted = 0;
    let logSum = 0;
    let m = 0;
    for (let k = kLo; k <= kHi; k++) {
      const p = re[k] * re[k] + im[k] * im[k] + 1e-12;
      sum += p;
      weighted += p * ((k * sampleRate) / n);
      logSum += Math.log(p);
      m++;
    }
    const centroid = sum > 0 ? weighted / sum : 100;
    brightness[f] = Math.max(0, Math.min(1, Math.log2(centroid / 100) / Math.log2(100)));
    const flatness = Math.exp(logSum / m) / (sum / m);
    noisiness[f] = Math.max(0, Math.min(1, 1 + Math.log10(Math.max(1e-4, flatness)) / 2));
  }
  return { fps, brightness, noisiness };
}

// ---------------------------------------------------------------- silences, sections, drops

/** Runs under −50 dBFS for half a second or more. */
function findSilences(strip: Strip): Float32Array {
  const floor = Math.round(((-50 + 60) / 60) * 255);
  const minFrames = Math.round(strip.fps * 0.5);
  const out: number[] = [];
  let start = -1;
  for (let i = 0; i <= strip.loud.length; i++) {
    const quiet = i < strip.loud.length && strip.loud[i] < floor;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      if (i - start >= minFrames) out.push(start / strip.fps, i / strip.fps);
      start = -1;
    }
  }
  return Float32Array.from(out);
}

/** Foote's novelty over a self-similarity matrix of one-second features (six bands, the
 *  loudness and the chroma), peaks at least eight seconds apart; sections are grouped by
 *  similarity and the most repeated loud group is chorus-like. */
function findSections(
  strip: Strip,
  chroma: Chroma,
  seconds: number,
  drops: Drops,
): Sections | null {
  const secs = Math.floor(seconds);
  if (secs < 30) return null;
  const { feats, energy, novelty, K, DIMS } = sectionNovelty(strip, chroma, seconds);
  return assembleSections(secs, feats, energy, novelty, K, DIMS, drops);
}

/** One-second features (six bands, the loudness, twelve chroma), standardized and unit
 *  length, and Foote's novelty over their self-similarity; exported so a proof can see it. */
export function sectionNovelty(
  strip: Strip,
  chroma: Chroma,
  seconds: number,
): { feats: Float32Array; energy: Float32Array; novelty: Float32Array; K: number; DIMS: number } {
  const secs = Math.floor(seconds);
  const DIMS = 19;
  const feats = new Float32Array(secs * DIMS);
  const energy = new Float32Array(secs);
  for (let s = 0; s < secs; s++) {
    const a = s * strip.fps;
    const b = Math.min(strip.loud.length, a + strip.fps);
    for (let i = a; i < b; i++) {
      for (let band = 0; band < 6; band++)
        feats[s * DIMS + band] += strip.bands[i * 6 + band] / 255;
      feats[s * DIMS + 6] += strip.loud[i] / 255;
    }
    const m = Math.max(1, b - a);
    for (let d = 0; d < 7; d++) feats[s * DIMS + d] /= m;
    energy[s] = feats[s * DIMS + 6];
    const ca = s * chroma.fps;
    const cb = Math.min(chroma.data.length / 12, ca + chroma.fps);
    for (let f = ca; f < cb; f++)
      for (let p = 0; p < 12; p++) feats[s * DIMS + 7 + p] += chroma.data[f * 12 + p];
    const cm = Math.max(1, cb - ca);
    for (let p = 0; p < 12; p++) feats[s * DIMS + 7 + p] /= cm * 2;
  }
  // standardize each dimension, then unit vectors
  for (let d = 0; d < DIMS; d++) {
    let mean = 0;
    for (let s = 0; s < secs; s++) mean += feats[s * DIMS + d];
    mean /= secs;
    let v = 0;
    for (let s = 0; s < secs; s++) v += (feats[s * DIMS + d] - mean) ** 2;
    const std = Math.sqrt(v / secs) || 1;
    for (let s = 0; s < secs; s++) feats[s * DIMS + d] = (feats[s * DIMS + d] - mean) / std;
  }
  for (let s = 0; s < secs; s++) {
    let len = 0;
    for (let d = 0; d < DIMS; d++) len += feats[s * DIMS + d] ** 2;
    len = Math.sqrt(len) || 1;
    for (let d = 0; d < DIMS; d++) feats[s * DIMS + d] /= len;
  }
  const sim = (i: number, j: number): number => {
    let dot = 0;
    for (let d = 0; d < DIMS; d++) dot += feats[i * DIMS + d] * feats[j * DIMS + d];
    return dot;
  };
  // novelty with a Gaussian-tapered checkerboard kernel, half-width 10 s
  const K = Math.min(10, Math.floor(secs / 4));
  const novelty = new Float32Array(secs);
  for (let t = K; t < secs - K; t++) {
    let nov = 0;
    for (let i = -K; i < K; i++)
      for (let j = -K; j < K; j++) {
        const sign = i < 0 === j < 0 ? 1 : -1;
        const w = Math.exp(-((i + 0.5) ** 2 + (j + 0.5) ** 2) / (2 * (K / 2) ** 2));
        nov += sign * w * sim(t + i, t + j);
      }
    novelty[t] = Math.max(0, nov);
  }
  return { feats, energy, novelty, K, DIMS };
}

function assembleSections(
  secs: number,
  feats: Float32Array,
  energy: Float32Array,
  novelty: Float32Array,
  K: number,
  DIMS: number,
  drops: Drops,
): Sections {
  let max = 0;
  for (let t = 0; t < secs; t++) if (novelty[t] > max) max = novelty[t];
  // peaks (local maxima over ±4 s, at least 0.3 of the tallest), taken tallest first and
  // never within ten seconds of one already taken: phrase-level ripples inside a section
  // no longer shadow the real boundary next to them
  const peaks: { t: number; v: number }[] = [];
  if (max > 0)
    for (let t = K; t < secs - K; t++) {
      if (novelty[t] < 0.3 * max) continue;
      let isMax = true;
      for (let k = Math.max(0, t - 4); k <= Math.min(secs - 1, t + 4); k++)
        if (novelty[k] > novelty[t]) {
          isMax = false;
          break;
        }
      if (isMax) peaks.push({ t, v: novelty[t] });
    }
  peaks.sort((a, b) => b.v - a.v);
  const bounds: number[] = [];
  for (const pk of peaks) if (bounds.every((b) => Math.abs(b - pk.t) >= 10)) bounds.push(pk.t);
  bounds.sort((a, b) => a - b);
  // a drop is a boundary whatever the novelty said
  for (let i = 0; i < drops.at.length; i++) {
    const t = Math.round(drops.at[i]);
    if (t < 4 || t > secs - 4) continue;
    const near = bounds.findIndex((b) => Math.abs(b - t) < 8);
    if (near >= 0) bounds[near] = t;
    else bounds.push(t);
  }
  bounds.sort((a, b) => a - b);
  // sections, their mean feature and energy, grouped by similarity
  const starts = [0, ...bounds];
  const ends = [...bounds, secs];
  const count = starts.length;
  const meanFeat = new Float32Array(count * DIMS);
  const secEnergy = new Float32Array(count);
  for (let s = 0; s < count; s++) {
    for (let t = starts[s]; t < ends[s]; t++) {
      for (let d = 0; d < DIMS; d++) meanFeat[s * DIMS + d] += feats[t * DIMS + d];
      secEnergy[s] += energy[t];
    }
    const len = Math.max(1, ends[s] - starts[s]);
    for (let d = 0; d < DIMS; d++) meanFeat[s * DIMS + d] /= len;
    secEnergy[s] /= len;
  }
  const group = new Int32Array(count).fill(-1);
  let groups = 0;
  for (let s = 0; s < count; s++) {
    if (group[s] >= 0) continue;
    group[s] = groups;
    for (let o = s + 1; o < count; o++) {
      if (group[o] >= 0) continue;
      // grouped by what they are made of (bands and chroma), not how loud they are
      let dot = 0;
      let a = 0;
      let b = 0;
      for (let d = 0; d < DIMS; d++) {
        if (d === 6) continue;
        dot += meanFeat[s * DIMS + d] * meanFeat[o * DIMS + d];
        a += meanFeat[s * DIMS + d] ** 2;
        b += meanFeat[o * DIMS + d] ** 2;
      }
      if (a > 0 && b > 0 && dot / Math.sqrt(a * b) > 0.6) group[o] = groups;
    }
    groups++;
  }
  // chorus-like: the group with the most members (at least two) and the highest energy
  let chorus = -1;
  let chorusScore = 0;
  for (let g = 0; g < groups; g++) {
    let members = 0;
    let e = 0;
    for (let s = 0; s < count; s++)
      if (group[s] === g) {
        members++;
        e += secEnergy[s];
      }
    if (members < 2) continue;
    const score = members * (e / members);
    if (score > chorusScore) {
      chorusScore = score;
      chorus = g;
    }
  }
  // two neighbours of the same group split by a modest boundary are one section
  const keepBound: boolean[] = bounds.map(
    (b, i) =>
      group[i] !== group[i + 1] ||
      novelty[b] >= 0.7 * max ||
      drops.at.some((d) => Math.abs(d - b) < 2),
  );
  const outBounds: number[] = [];
  const outKinds: number[] = [];
  const outEnergy: number[] = [];
  let runStart = 0;
  let eMax = 0;
  for (let s = 0; s < count; s++) eMax = Math.max(eMax, secEnergy[s]);
  for (let s = 0; s < count; s++) {
    const last = s === count - 1 || keepBound[s];
    if (!last) continue;
    let e = 0;
    for (let k = runStart; k <= s; k++) e += secEnergy[k] * (ends[k] - starts[k]);
    outKinds.push(group[s] === chorus ? 1 : 0);
    outEnergy.push(eMax > 0 ? e / Math.max(1, ends[s] - starts[runStart]) / eMax : 0);
    if (s < count - 1) outBounds.push(bounds[s]);
    runStart = s + 1;
  }
  return {
    bounds: Float32Array.from(outBounds),
    kinds: Uint8Array.from(outKinds),
    energy: Float32Array.from(outEnergy),
  };
}

/** A DROP, as a listener means it (the user's words, 2026-09-07): THREE OR MORE SECONDS OF
 *  NOTABLE REDUCTION (chill: the beat gone or the level well down) OR ONE OR MORE SECONDS OF
 *  DEFINITE REDUCTION (a breath: near silence) OR A BRIEF TOTAL CUT after a second and a
 *  half of reduced beat, each followed by a SUDDEN return, with the music present before
 *  the lull (a quiet intro then the beat is not a drop). Everything is read at FRAME
 *  resolution (a tenth of a second) around the return, in half-second windows behind it:
 *  a return that lands mid-block was lost when the block's mean was judged instead
 *  (Reconnect, 3:21.1, the cut and the slam in one block). A window is chill when its
 *  loudest bass frame sits ~21 dB under the return's (the beat gone, not softer) (the strip sees a kick only in the
 *  frames that hold it, so a window's maximum is the honest "is the beat here") or its
 *  level does (a verse a few dB under its chorus is not chill); a breath when its level is
 *  ~12 dB under, or its bass ~30 dB under with a 2 dB dip in level (the beat gone outright
 *  while the pads play on). The bytes are dB-linear: differences, never ratios. Every drop
 *  clearing the loosest tier is kept with its chill, breath and cut, and the display picks
 *  the tier (settings.displayDrops): how much lull a drop needs is taste and genre. */
export function findDrops(strip: Strip, onsets: Onsets, beats: Beats | null): Drops {
  const fps = strip.fps;
  const n = strip.loud.length;
  const loud = new Float32Array(n);
  const bass = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    loud[i] = strip.loud[i] / 255;
    bass[i] = strip.bands[i * 6] / 255;
  }
  const W = Math.max(1, Math.round(fps / 2)); // a half-second window, in frames
  const meanLoud = (a: number, z: number): number => {
    let s = 0;
    let m = 0;
    for (let f = Math.max(0, a); f < Math.min(n, z); f++) {
      s += loud[f];
      m++;
    }
    return m ? s / m : 0;
  };
  const maxBass = (a: number, z: number): number => {
    let mx = 0;
    for (let f = Math.max(0, a); f < Math.min(n, z); f++) mx = Math.max(mx, bass[f]);
    return mx;
  };
  /** The mean of the window maxima of the bass over [a, z): "how present is the beat". */
  const beatLevel = (a: number, z: number): number => {
    let s = 0;
    let m = 0;
    for (let w = a; w + W <= z; w += W) {
      s += maxBass(w, w + W);
      m++;
    }
    return m ? s / m : maxBass(a, z);
  };
  const cands: {
    r: number;
    score: number;
    buildFrom: number;
    chill: number;
    breath: number;
    cut: number;
  }[] = [];
  for (let r = fps * 2; r + fps * 4.5 <= n; r++) {
    const afterLoud = meanLoud(r, r + fps * 1.5);
    const afterBass = beatLevel(r, r + fps * 3);
    if (afterLoud < 0.3) continue; // the return has to have energy
    // r is the first frame of the return: the level on, the bass back in this frame, the half
    // second after it on on average (a sparse beat dips between kicks, so frame by frame would
    // miss it) with the beat present through it, and the frame before it off
    const onLevel = (f: number): boolean => loud[f] >= afterLoud - 0.05;
    const on = (f: number): boolean => onLevel(f) && bass[f] >= afterBass - 0.3;
    if (!on(r) || on(r - 1) || meanLoud(r, r + W) < afterLoud - 0.05) continue;
    if (maxBass(r, r + W) < afterBass - 0.15) continue;
    // sudden: already at the level of what follows, not a fade-in
    if (afterLoud < meanLoud(r + fps * 1.5, r + fps * 4.5) - 0.06) continue;
    // walk back through the lull in half-second windows, two ways: reduced, and near silent.
    // A PICKUP right before the slam is stepped over: up to a second and a half of beat that
    // arrives after the lull and before the return (By My Side, 2:39: a second of bass silence,
    // the bass hits at 2:38.1, a fill gap, the drop lands at 2:39.2). The return itself still
    // needs the frame before it off, so a groove that simply carries on never gets this
    let pickup = 0;
    let chillMax = 0;
    while (r - (pickup + chillMax + 1) * W >= 0 && chillMax < 120) {
      const a = r - (pickup + chillMax + 1) * W;
      // chill by the beat means the beat GONE (~21 dB under the return's), not merely softer:
      // a verse whose kick sits 9 dB under the drop's is a verse (Away, 1:02 to 1:18 read as
      // thirty seconds of chill and lit the drop at 1:18, ten seconds before the real one)
      const chillWindow =
        maxBass(a, a + W) < afterBass - 0.35 || meanLoud(a, a + W) < afterLoud - 0.15;
      if (!chillWindow) {
        if (chillMax === 0 && pickup < 3) {
          pickup++;
          continue;
        }
        break;
      }
      chillMax++;
    }
    if (chillMax === 0) continue;
    /** Where the lull ends: the return, or the pickup's first frame. */
    const end = r - pickup * W;
    let breathMax = 0;
    while (end - (breathMax + 1) * W >= 0 && breathMax < 120) {
      const a = end - (breathMax + 1) * W;
      const lv = meanLoud(a, a + W);
      if (!(lv < afterLoud - 0.2 || (maxBass(a, a + W) < afterBass - 0.5 && lv < afterLoud - 0.03)))
        break;
      breathMax++;
    }
    // the lull is the longest reduced stretch whose music BEFORE it was louder than it or
    // carried the beat: a passage reduced against a loud drop with nothing before it is an
    // intro, and the shortest such stretch (the last breath) would hide the real breakdown
    let lull = 0;
    for (let k = Math.min(chillMax, Math.floor(end / W) - 16); k >= 1; k--) {
      const a = end - k * W;
      const lullLoud = meanLoud(a, end);
      const priorLoud = meanLoud(a - 16 * W, a);
      const priorBass = beatLevel(a - 16 * W, a);
      if (priorLoud >= lullLoud + 0.06 || priorBass >= afterBass - 0.2) {
        lull = k;
        break;
      }
    }
    if (!lull) continue;
    const chill = (lull * W) / fps;
    const breath = (Math.min(breathMax, lull) * W) / fps;
    // the cut: frames of near-total silence right before the return (stepping over up to
    // three frames whose level is already up: the slam's first frame can carry the level a
    // tenth before the bass reads)
    let f0 = r - 1;
    let stepped = 0;
    while (f0 > 0 && stepped < 3 && onLevel(f0)) {
      f0--;
      stepped++;
    }
    let cutFrames = 0;
    while (f0 - cutFrames >= 0 && loud[f0 - cutFrames] < afterLoud - 0.35 && cutFrames < fps * 3)
      cutFrames++;
    const cut = cutFrames / fps;
    if (!clearsAny(chill, breath, cut)) continue;
    // how hard it hits: the level's return, or the bass's (a break where only the beat left
    // is a small step in level and a huge one in bass)
    const lullStart = end - lull * W;
    const contrast = Math.max(
      afterLoud - meanLoud(lullStart, end),
      0.7 * (afterBass - beatLevel(lullStart, end)),
    );
    const score = Math.max(0.35, 0.5 * Math.min(1, contrast * 4) + 0.5 * Math.min(1, chill / 8));
    // the build the scenes ramp through is the lull's last sixteen seconds at most: a quiet
    // verse can be the lull, and a lean-in over forty seconds would read as nothing
    cands.push({
      r,
      score,
      buildFrom: Math.max(lullStart / fps, r / fps - 16),
      chill,
      breath,
      cut,
    });
  }
  // within six seconds the EARLIEST return is the drop: later candidates are re-entries inside
  // it (a sparse beat re-detected at its next kick scored higher for its longer "chill", which
  // was the silence plus the gap between two kicks); then the sixteen strongest
  cands.sort((a, c) => a.r - c.r);
  let kept: typeof cands = [];
  for (const c of cands) {
    if (kept.length && c.r - kept[kept.length - 1].r < fps * 6) continue;
    kept.push(c);
  }
  if (kept.length > 16)
    kept = kept
      .sort((a, c) => c.score - a.score)
      .slice(0, 16)
      .sort((a, c) => a.r - c.r);
  // THE INSTANT: the return frame, placed on the moment the listener calls the drop. A
  // pickup bar often precedes the drop proper (MitiS, By My Side: the bass slams at 1:30.4,
  // gaps for a fill at 1:31.2, the drop lands on the downbeat at 1:31.4): when the beat grid
  // is confident and knows its downbeat, the first downbeat within a bar and a half that is
  // SLAMMED (a strong non-hat onset within a tenth and the bass up after it) AND preceded by a
  // bass gap is the drop; else the first beat at or just after the return (a slammed one if
  // any); else the nearest kick or snare onset.
  const instant = (c: (typeof kept)[number]): number => {
    const t = c.r / fps;
    const afterBass = beatLevel(c.r, c.r + fps * 3);
    const slammed = (m: number): boolean => {
      let hit = false;
      for (let i = 0; i < onsets.at.length; i++) {
        if (onsets.at[i] < m - 0.1) continue;
        if (onsets.at[i] > m + 0.1) break;
        if (onsets.type[i] !== 2 && onsets.strength[i] >= 0.6) hit = true;
      }
      if (!hit) return false;
      const f0 = Math.round(m * fps);
      return meanOfBass(f0, f0 + 3) >= afterBass - 0.15;
    };
    const meanOfBass = (a: number, z: number): number => {
      let s = 0;
      let m = 0;
      for (let f = Math.max(0, a); f < Math.min(n, z); f++) {
        s += bass[f];
        m++;
      }
      return m ? s / m : 0;
    };
    const grid = beats && beats.confidence >= 0.35 && beats.times.length > 4 ? beats : null;
    if (grid && grid.downbeat >= 0) {
      for (let k = 0; k < grid.times.length; k++) {
        const d = grid.times[k];
        if (d < t - 0.15) continue;
        if (d > t + 1.6) break;
        if ((k - grid.downbeat) % 4 !== 0 || !slammed(d)) continue;
        const gap = Math.min(
          1,
          maxBassMin(Math.round((t + 0.2) * fps), Math.round((d - 0.05) * fps)),
        );
        if (d - t < 0.2 || gap < afterBass - 0.3) return d;
      }
    }
    if (grid) {
      let first: number | null = null;
      for (let k = 0; k < grid.times.length; k++) {
        const bt = grid.times[k];
        if (bt < t - 0.1) continue;
        if (bt > t + 0.6) break;
        if (slammed(bt)) return bt;
        if (first == null) first = bt;
      }
      if (first != null) return first;
    }
    let best: number | null = null;
    for (let i = 0; i < onsets.at.length; i++) {
      if (onsets.type[i] === 2) continue;
      const d = Math.abs(onsets.at[i] - t);
      if (d <= 0.2 && (best == null || d < Math.abs(onsets.at[best] - t))) best = i;
    }
    return best != null ? onsets.at[best] : t;
  };
  /** The lowest bass frame in [a, z), 1 when empty. */
  const maxBassMin = (a: number, z: number): number => {
    let mn = 1;
    for (let f = Math.max(0, a); f < Math.min(n, z); f++) mn = Math.min(mn, bass[f]);
    return mn;
  };
  return {
    buildFrom: Float32Array.from(kept, (c) => c.buildFrom),
    at: Float32Array.from(kept, (c) => instant(c)),
    strength: Float32Array.from(kept, (c) => c.score),
    chill: Float32Array.from(kept, (c) => c.chill),
    breath: Float32Array.from(kept, (c) => c.breath),
    cut: Float32Array.from(kept, (c) => c.cut),
  };
}

/** How much lull a drop needs, by the display's taste: seconds of chill, OR seconds of
 *  breath, OR a brief total CUT right before the slam after at least `cutChill` seconds of
 *  reduced beat (the gasp: MitiS, Reconnect, two tenths of silence at 1:31.2 after two
 *  seconds without the bass, then the kick on the one). */
export const DROP_TIERS = {
  loose: { chill: 2, breath: 1, cut: 0.1, cutChill: 1 },
  normal: { chill: 3, breath: 1, cut: 0.15, cutChill: 1.5 },
  strict: { chill: 4, breath: 1.5, cut: 0.2, cutChill: 2 },
} as const;
export type DropTier = keyof typeof DROP_TIERS;
function clearsAny(chill: number, breath: number, cut: number): boolean {
  const t = DROP_TIERS.loose;
  return (
    chill >= t.chill - 0.01 ||
    breath >= t.breath - 0.01 ||
    (cut >= t.cut - 0.01 && chill >= t.cutChill - 0.01)
  );
}
export function dropClears(d: Drops, i: number, tier: DropTier): boolean {
  const t = DROP_TIERS[tier] ?? DROP_TIERS.normal;
  const chill = d.chill[i] ?? 0;
  return (
    chill >= t.chill - 0.01 ||
    (d.breath[i] ?? 0) >= t.breath - 0.01 ||
    ((d.cut[i] ?? 0) >= t.cut - 0.01 && chill >= t.cutChill - 0.01)
  );
}

// ---------------------------------------------------------------- disk shape

const u16s = (values: ArrayLike<number>): Uint8Array => {
  const out = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(0, Math.min(65_535, Math.round(values[i])));
    out[i * 2] = v & 0xff;
    out[i * 2 + 1] = v >> 8;
  }
  return out;
};
const fromU16s = (bytes: Uint8Array): Float32Array => {
  const out = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  return out;
};
/** Seconds to tenths, as u16 gaps. */
const tenthsGaps = (secs: ArrayLike<number>): Uint8Array => {
  const gaps: number[] = [];
  let prev = 0;
  for (let i = 0; i < secs.length; i++) {
    const t = Math.round(secs[i] * 10);
    gaps.push(Math.max(0, t - prev));
    prev += Math.max(0, t - prev);
  }
  return u16s(gaps);
};
const fromTenthsGaps = (bytes: Uint8Array): Float32Array => {
  const gaps = fromU16s(bytes);
  const out = new Float32Array(gaps.length);
  let t = 0;
  for (let i = 0; i < gaps.length; i++) {
    t += gaps[i];
    out[i] = t / 10;
  }
  return out;
};
const bytes01 = (values: ArrayLike<number>): Uint8Array =>
  Uint8Array.from({ length: values.length }, (_, i) =>
    Math.round(Math.max(0, Math.min(1, values[i])) * 255),
  );
const from01 = (bytes: Uint8Array): Float32Array => Float32Array.from(bytes, (b) => b / 255);

export function featuresToStored(f: Features): AnalysisFeatures {
  return {
    version: FEATURES_VERSION,
    beats: f.beats
      ? {
          bpm: Math.round(f.beats.bpm * 100) / 100,
          confidence: Math.round(f.beats.confidence * 1000) / 1000,
          downbeat: f.beats.downbeat,
          count: f.beats.times.length,
          times: b64(u16s(Array.from(f.beats.times, (t) => Math.round(t * 100)))),
        }
      : null,
    sections: f.sections
      ? {
          count: f.sections.kinds.length,
          bounds: b64(tenthsGaps(f.sections.bounds)),
          kinds: b64(f.sections.kinds),
          energy: b64(bytes01(f.sections.energy)),
        }
      : null,
    chroma: f.chroma ? { fps: f.chroma.fps, data: b64(bytes01(f.chroma.data)) } : null,
    key: f.key
      ? {
          tonic: f.key.tonic,
          mode: f.key.mode,
          confidence: Math.round(f.key.confidence * 1000) / 1000,
        }
      : null,
    changes: b64(tenthsGaps(f.changes)),
    stereo: f.stereo
      ? {
          fps: f.stereo.fps,
          pan: b64(bytes01(Array.from(f.stereo.pan, (p) => (p + 1) / 2))),
          width: b64(bytes01(f.stereo.width)),
        }
      : null,
    timbre: f.timbre
      ? {
          fps: f.timbre.fps,
          brightness: b64(bytes01(f.timbre.brightness)),
          noisiness: b64(bytes01(f.timbre.noisiness)),
        }
      : null,
    silences: b64(tenthsGaps(f.silences)),
    drops: {
      count: f.drops.at.length,
      buildFrom: b64(u16s(Array.from(f.drops.buildFrom, (t) => Math.round(t * 10)))),
      at: b64(u16s(Array.from(f.drops.at, (t) => Math.round(t * 10)))),
      strength: b64(bytes01(f.drops.strength)),
      chill: b64(Uint8Array.from(f.drops.chill, (c) => Math.min(255, Math.round(c * 4)))),
      breath: b64(Uint8Array.from(f.drops.breath, (c) => Math.min(255, Math.round(c * 4)))),
      cut: b64(Uint8Array.from(f.drops.cut, (c) => Math.min(255, Math.round(c * 10)))),
    },
  };
}

export function featuresFromStored(st: AnalysisFeatures): Features {
  const beats = st.beats
    ? {
        bpm: st.beats.bpm,
        confidence: st.beats.confidence,
        downbeat: st.beats.downbeat,
        times: Float32Array.from(fromU16s(unb64(st.beats.times)), (t) => t / 100),
      }
    : null;
  const sections = st.sections
    ? {
        bounds: fromTenthsGaps(unb64(st.sections.bounds)),
        kinds: unb64(st.sections.kinds),
        energy: from01(unb64(st.sections.energy)),
      }
    : null;
  const chroma = st.chroma ? { fps: st.chroma.fps, data: from01(unb64(st.chroma.data)) } : null;
  const stereo = st.stereo
    ? {
        fps: st.stereo.fps,
        pan: Float32Array.from(from01(unb64(st.stereo.pan)), (v) => v * 2 - 1),
        width: from01(unb64(st.stereo.width)),
      }
    : null;
  const timbre = st.timbre
    ? {
        fps: st.timbre.fps,
        brightness: from01(unb64(st.timbre.brightness)),
        noisiness: from01(unb64(st.timbre.noisiness)),
      }
    : null;
  return {
    beats,
    sections,
    chroma,
    key: st.key ? { tonic: st.key.tonic, mode: st.key.mode, confidence: st.key.confidence } : null,
    changes: fromTenthsGaps(unb64(st.changes)),
    stereo,
    timbre,
    silences: fromTenthsGaps(unb64(st.silences)),
    drops: {
      buildFrom: Float32Array.from(fromU16s(unb64(st.drops.buildFrom)), (t) => t / 10),
      at: Float32Array.from(fromU16s(unb64(st.drops.at)), (t) => t / 10),
      strength: from01(unb64(st.drops.strength)),
      chill: Float32Array.from(unb64(st.drops.chill ?? ""), (c) => c / 4),
      breath: Float32Array.from(unb64(st.drops.breath ?? ""), (c) => c / 4),
      cut: Float32Array.from(unb64(st.drops.cut ?? ""), (c) => c / 10),
    },
  };
}
