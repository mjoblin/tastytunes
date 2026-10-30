import { STRIP_BANDS, type AnalysisStrip } from "@shared/model";
import { fed, Tape, type Sink } from "./stream/tape";

/**
 * THE FEATURE STRIP (0.8.0, display mode's scenes). The app never hears the
 * music — it plays on the streamer — but it decodes every file once for the
 * waveform and the loudness, and that decode can leave behind what a scene
 * needs: six band energies and a loudness, ten frames a second, a byte each.
 * Under 20KB for a five-minute track, stored beside the analysis. Known in
 * advance, the strip lets a scene show what is COMING, which no live
 * visualizer can.
 *
 * Bytes map −60..0 dBFS to 0..255. Band energy is the summed power of the
 * band's bins against a full-scale sine's peak-bin power (Hann window), so a
 * full-scale tone inside a band reads near 255; loudness is the block RMS of
 * the mono mix. Scenes normalize per track (lib/display/feed), so the
 * absolute scale only has to be consistent.
 */
export interface Strip {
  fps: number;
  /** STRIP_BANDS values per frame, frame-major. */
  bands: Uint8Array;
  loud: Uint8Array;
}

export const STRIP_FPS = 10;
/** Band edges in Hz: bass, low, low-mid, mid, presence, air. */
export const BAND_EDGES_HZ = [20, 80, 250, 800, 2500, 6000, 16000];
const DB_FLOOR = -60;

const toByte = (db: number): number =>
  Math.max(0, Math.min(255, Math.round(((db - DB_FLOOR) / -DB_FLOOR) * 255)));

export function computeStrip(chans: readonly Float32Array[], sampleRate: number): Strip {
  return fed(new StripSink(sampleRate, chans.length, chans[0].length), chans).strip();
}

/**
 * THE STRIP IN PIECES (0.14.0, analysis with no size limit): the same frames from a tape that holds
 * a little of the track at a time (lib/stream/tape). A frame is read once the samples its window
 * covers have arrived (or the track has ended, past which the window reads the zero padding it
 * always read); computeStrip feeds it the whole track, so there is one way the strip is made.
 */
export class StripSink implements Sink {
  private readonly hop: number;
  private readonly count: number;
  private readonly n: number;
  private readonly fft: Fft;
  private readonly window: Float32Array;
  private readonly ref: number;
  private readonly edges: number[];
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly inv: number;
  /** How many samples each frame's loudness sums: the hop's middle, as much of it as the window
   *  holds. */
  private readonly loudN: number;
  private readonly bands: Uint8Array;
  private readonly loud: Uint8Array;
  private f = 0;
  constructor(sampleRate: number, channels: number, frames: number) {
    this.hop = Math.max(1, Math.round(sampleRate / STRIP_FPS));
    this.count = Math.max(1, Math.floor(frames / this.hop));
    // ~21 Hz bins at every common rate: the bass band keeps three bins
    const n = (this.n = sampleRate > 60_000 ? 4096 : 2048);
    this.fft = new Fft(n);
    this.window = new Float32Array(n);
    for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    // a full-scale sine's peak-bin magnitude under a Hann window is ~N/4
    this.ref = (n / 4) * (n / 4);
    this.edges = BAND_EDGES_HZ.map((hz) =>
      Math.min(n / 2, Math.max(1, Math.round((hz / sampleRate) * n))),
    );
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.inv = 1 / channels;
    let loudN = 0;
    for (let i = 0; i < n; i++) if (i >= n / 2 - this.hop / 2 && i < n / 2 + this.hop / 2) loudN++;
    this.loudN = Math.max(1, loudN);
    this.bands = new Uint8Array(this.count * STRIP_BANDS);
    this.loud = new Uint8Array(this.count);
  }
  private startOf(f: number): number {
    return Math.round(f * this.hop + this.hop / 2 - this.n / 2);
  }
  get needs(): number {
    return this.f < this.count ? Math.max(0, this.startOf(this.f)) : Infinity;
  }
  take(tape: Tape): void {
    const { n, hop, re, im, window, inv, fft, edges, ref } = this;
    for (; this.f < this.count; this.f++) {
      const f = this.f;
      const start = this.startOf(f);
      if (start + n > tape.end && !tape.done) return;
      let sumSq = 0;
      for (let i = 0; i < n; i++) {
        const v = tape.mixAt(start + i) * inv;
        re[i] = v * window[i];
        im[i] = 0;
        if (i >= n / 2 - hop / 2 && i < n / 2 + hop / 2) sumSq += v * v;
      }
      fft.transform(re, im);
      for (let b = 0; b < STRIP_BANDS; b++) {
        let power = 0;
        for (let k = edges[b]; k < edges[b + 1]; k++) power += re[k] * re[k] + im[k] * im[k];
        this.bands[f * STRIP_BANDS + b] = toByte(10 * Math.log10(power / ref + 1e-12));
      }
      // the mean of the samples summed (0.14.0): divided by the hop, which is wider than the
      // window, it read 3.3 to 3.7 dB low at 44.1 to 96 kHz and 6.7 dB low at 192 kHz, and the
      // silences' -50 dBFS floor moved with the rate
      this.loud[f] = toByte(10 * Math.log10(sumSq / this.loudN + 1e-12));
    }
  }
  /** The frames read so far; whole once the tape is done. */
  strip(): Strip {
    return { fps: STRIP_FPS, bands: this.bands, loud: this.loud };
  }
  /** How many frames are read, for a strip shown while the file arrives. */
  get framesDone(): number {
    return this.f;
  }
}

export const b64 = (u8: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000)
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const stripToStored = (s: Strip): AnalysisStrip => ({
  fps: s.fps,
  bands: b64(s.bands),
  loud: b64(s.loud),
});
export const stripFromStored = (st: AnalysisStrip): Strip => ({
  fps: st.fps,
  bands: unb64(st.bands),
  loud: unb64(st.loud),
});

/** In-place iterative radix-2 complex FFT, twiddles precomputed once (the onsets share it). */
export class Fft {
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  constructor(private readonly n: number) {
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }
  transform(re: Float64Array, im: Float64Array): void {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const tr = re[b] * cos[k] + im[b] * sin[k];
          const ti = im[b] * cos[k] - re[b] * sin[k];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}
