import { LOUD_HIST_BINS } from "@shared/model";
import { Dr14Sink } from "./dr14";
import { R128Sink } from "./r128";
import { STRIP_FPS, StripSink, type Strip } from "./featureStrip";
import { OnsetsSink, type Onsets } from "./onsets";
import { featureSinks, featuresFrom, type Features } from "./features";
import { feed, type Sink, type Tape } from "./stream/tape";

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
  const m = new MeasureStream(sampleRate, chans.length, chans[0].length, native, buckets);
  feed(m.sinks, chans);
  return m.measured();
}

/**
 * THE MEASUREMENT IN PIECES (0.14.0, analysis with no size limit): every measure reads one tape
 * (lib/stream/tape) as the file arrives, and the tape keeps only what some measure may still
 * read, so a 30-minute hi-res movement costs what a song does. measureTrack feeds it a whole
 * decoded track, so a file measured whole and one measured in pieces give the same numbers, to
 * the bit (lib/stream/sinks.test). The waveform's envelopes are ready bucket by bucket
 * (`envelopes`), for a waveform that fills in as the file arrives.
 */
export class MeasureStream {
  readonly sinks: Sink[];
  private readonly env: EnvelopeSink;
  private readonly dr: Dr14Sink | null;
  private readonly r128: R128Sink | null;
  private readonly strip: StripSink | null;
  private readonly onsets: OnsetsSink | null;
  private readonly features: ReturnType<typeof featureSinks> | null;
  private readonly seconds: number;
  private readonly native: boolean;
  constructor(
    sampleRate: number,
    channels: number,
    frames: number,
    native: boolean,
    buckets: number,
  ) {
    this.seconds = frames / sampleRate;
    this.env = new EnvelopeSink(channels, frames, buckets);
    // DR, loudness and the scenes' share only at the file's own rate (the honesty rule)
    const ok = native;
    this.native = native;
    this.dr = ok ? new Dr14Sink(sampleRate, channels, frames) : null;
    this.r128 =
      ok && sampleRate > 0 && frames > 0 ? new R128Sink(sampleRate, channels, frames) : null;
    this.strip = ok ? new StripSink(sampleRate, channels, frames) : null;
    this.onsets = ok ? new OnsetsSink(sampleRate, channels, frames) : null;
    this.features = ok ? featureSinks(sampleRate, channels, frames, STRIP_FPS) : null;
    this.sinks = [
      this.env,
      ...[this.dr, this.r128, this.strip, this.onsets].filter(
        (x): x is NonNullable<typeof x> => x != null,
      ),
      ...(this.features ? [this.features.chroma, this.features.stereo, this.features.timbre] : []),
    ];
  }
  /** The envelopes measured so far: buckets before `ready` hold their values. */
  envelopes(): { peak: Float32Array; rms: Float32Array; ready: number } {
    return this.env.so();
  }
  /** Everything, once the tape has delivered the whole track. */
  measured(): Measured {
    const e = this.env.result();
    // a track with no samples, or no rate, measures as no loudness and an empty histogram
    const r128 =
      this.r128?.result() ??
      (this.native
        ? {
            lufs: null,
            lra: null,
            truePeakDb: null,
            hist: new Array<number>(LOUD_HIST_BINS).fill(0),
          }
        : null);
    const strip = this.strip?.strip() ?? null;
    let onsets: Onsets | null = null;
    let features: Features | null = null;
    if (strip && this.onsets && this.features) {
      const rhythm = this.onsets.result();
      onsets = rhythm.onsets;
      features = featuresFrom(this.features, this.seconds, strip, onsets, rhythm.flux);
    }
    return {
      peak: e.peak,
      rms: e.rms,
      peakDb: e.peakDb,
      rmsDb: e.rmsDb,
      crestDb: e.peakDb - e.rmsDb,
      dr: this.dr?.dr() ?? 0,
      lufs: r128?.lufs ?? null,
      lra: r128?.lra ?? null,
      truePeakDb: r128?.truePeakDb ?? null,
      loudHist: r128?.hist ?? null,
      strip,
      onsets,
      features,
    };
  }
}

/**
 * The waveform's envelopes and the global peak and RMS. The GLOBAL peak is a full scan of every
 * sample on every channel: stride sampling could miss the single hottest sample and understate
 * peak (and crest with it) by whole dB on percussive material. Still SAMPLE peak, honestly: true
 * peak (dBTP, 4x oversampled) is the R128 pass's job. Bucket envelopes and global RMS read BOTH
 * channels (power-combined), strided within each bucket: RMS is statistically robust to the
 * stride, peak above is not, hence the split.
 */
class EnvelopeSink implements Sink {
  private readonly ch: number;
  private readonly frames: number;
  private readonly buckets: number;
  private readonly per: number;
  private readonly peak: Float32Array;
  private readonly rms: Float32Array;
  private globalPeak = 0;
  private globalSumSq = 0;
  private globalN = 0;
  /** The next sample the peak scan reads, and the next bucket. */
  private k = 0;
  private b = 0;
  constructor(channels: number, frames: number, buckets: number) {
    this.ch = channels;
    this.frames = frames;
    this.buckets = buckets;
    this.per = Math.max(1, Math.floor(frames / buckets));
    this.peak = new Float32Array(buckets);
    this.rms = new Float32Array(buckets);
  }
  get needs(): number {
    const next = this.b < this.buckets ? Math.min(this.b * this.per, this.frames) : Infinity;
    return Math.min(this.k < this.frames ? this.k : Infinity, next);
  }
  take(tape: Tape): void {
    const end = Math.min(tape.end, this.frames);
    for (let c = 0; c < this.ch; c++) {
      const data = tape.chan[c];
      for (let i = this.k; i < end; i++) {
        const a = Math.abs(data[i - tape.base]);
        if (a > this.globalPeak) this.globalPeak = a;
      }
    }
    this.k = end;
    const { per, frames } = this;
    for (; this.b < this.buckets; this.b++) {
      const b = this.b;
      const start = b * per;
      const stop = Math.min(start + per, frames);
      if (stop > tape.end && !tape.done) return;
      const step = Math.max(1, Math.floor((stop - start) / 200));
      let max = 0;
      let sumSq = 0;
      let n = 0;
      for (let c = 0; c < this.ch; c++) {
        const data = tape.chan[c];
        for (let i = start; i < stop; i += step) {
          const v = data[i - tape.base];
          const a = Math.abs(v);
          if (a > max) max = a;
          sumSq += v * v;
          n++;
        }
      }
      this.peak[b] = max;
      this.rms[b] = n > 0 ? Math.sqrt(sumSq / n) : 0;
      this.globalSumSq += sumSq;
      this.globalN += n;
    }
  }
  so(): { peak: Float32Array; rms: Float32Array; ready: number } {
    return { peak: this.peak, rms: this.rms, ready: this.b };
  }
  result(): { peak: Float32Array; rms: Float32Array; peakDb: number; rmsDb: number } {
    const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    return {
      peak: this.peak,
      rms: this.rms,
      peakDb: db(this.globalPeak),
      rmsDb: db(this.globalN > 0 ? Math.sqrt(this.globalSumSq / this.globalN) : 0),
    };
  }
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
