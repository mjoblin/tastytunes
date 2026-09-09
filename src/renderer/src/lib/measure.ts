import { computeDr14 } from "./dr14";
import { computeR128 } from "./r128";
import { computeStrip, type Strip } from "./featureStrip";
import { analyzeOnsets, type Onsets } from "./onsets";
import { computeFeatures, type Features } from "./features";

/**
 * THE MEASUREMENT, with no DOM in it: everything the app learns from a decoded
 * track's samples. It runs in a Worker (workers/analysis.worker.ts) so the
 * two-odd seconds of arithmetic a track costs never stall the page, and on
 * the main thread only when no worker can be had. The decode itself stays on
 * the main thread: an OfflineAudioContext has no worker form.
 */
export interface Measured {
  /** Peak and RMS envelopes, `buckets` long. */
  peak: Float32Array;
  rms: Float32Array;
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  /** EBU R128 (0.8.0): integrated loudness, loudness range, true peak, and the
   *  gated block histogram for album integration. Null when the file's rate
   *  could not be read honestly (the same rule as DR). */
  lufs: number | null;
  lra: number | null;
  truePeakDb: number | null;
  loudHist: number[] | null;
  /** TT dynamic range integer; <= 0 means "no honest number" and hides. */
  dr: number;
  /** The feature strip for display mode's scenes (lib/featureStrip); null
   *  under the same honesty rule as DR and loudness. */
  strip: Strip | null;
  /** The file's drum onsets for display mode's hits (lib/onsets); same rule. */
  onsets: Onsets | null;
  /** Beat grid, sections, chroma, key, stereo, timbre, silences, drops (lib/features); same rule. */
  features: Features | null;
}

export function measureTrack(
  chans: readonly Float32Array[],
  sampleRate: number,
  native: boolean,
  buckets: number,
): Measured {
  const frames = chans[0].length;
  // The GLOBAL peak is a full scan of every sample on every channel: stride
  // sampling could miss the single hottest sample and understate peak (and
  // crest with it) by whole dB on percussive material. Still SAMPLE peak,
  // honestly: true peak (dBTP, 4x oversampled) is the R128 pass's job.
  let globalPeak = 0;
  for (const data of chans) {
    for (let i = 0; i < frames; i++) {
      const a = Math.abs(data[i]);
      if (a > globalPeak) globalPeak = a;
    }
  }
  // Bucket envelopes and global RMS read BOTH channels (power-combined),
  // strided within each bucket: RMS is statistically robust to the stride,
  // peak above is not, hence the split.
  const peak = new Float32Array(buckets);
  const rms = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(frames / buckets));
  let globalSumSq = 0;
  let globalN = 0;
  for (let b = 0; b < buckets; b++) {
    const start = b * per;
    const end = Math.min(start + per, frames);
    const step = Math.max(1, Math.floor((end - start) / 200));
    let max = 0;
    let sumSq = 0;
    let n = 0;
    for (const data of chans) {
      for (let i = start; i < end; i += step) {
        const v = data[i];
        const a = Math.abs(v);
        if (a > max) max = a;
        sumSq += v * v;
        n++;
      }
    }
    peak[b] = max;
    rms[b] = n > 0 ? Math.sqrt(sumSq / n) : 0;
    globalSumSq += sumSq;
    globalN += n;
  }
  const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);
  const peakDb = db(globalPeak);
  const rmsDb = db(globalN > 0 ? Math.sqrt(globalSumSq / globalN) : 0);
  const dr = native ? computeDr14(chans, sampleRate) : 0;
  // loudness rides the same honesty rule as DR: only at the file's own rate
  const r128 = native ? computeR128(chans, sampleRate) : null;
  // the scenes' share, under the same rule: the strip, the drum onsets and the
  // music features (beats, sections, key, stereo, timbre, drops)
  let strip: Strip | null = null;
  let onsets: Onsets | null = null;
  let features: Features | null = null;
  if (native) {
    strip = computeStrip(chans, sampleRate);
    const rhythm = analyzeOnsets(chans, sampleRate);
    onsets = rhythm.onsets;
    features = computeFeatures(chans, sampleRate, strip, onsets, rhythm.flux);
  }
  return {
    peak,
    rms,
    peakDb,
    rmsDb,
    crestDb: peakDb - rmsDb,
    dr,
    lufs: r128?.lufs ?? null,
    lra: r128?.lra ?? null,
    truePeakDb: r128?.truePeakDb ?? null,
    loudHist: r128?.hist ?? null,
    strip,
    onsets,
    features,
  };
}

/** What the page sends the worker, and what comes back. */
export interface MeasureJob {
  id: number;
  chans: Float32Array[];
  sampleRate: number;
  native: boolean;
  buckets: number;
}
export type MeasureReply =
  | { id: number; ok: true; measured: Measured; ms: number }
  | { id: number; ok: false; error: string };
