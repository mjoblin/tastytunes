import { STRIP_BANDS, type AnalysisStrip } from "@shared/model";

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
  const frames = chans[0].length;
  const hop = Math.max(1, Math.round(sampleRate / STRIP_FPS));
  const count = Math.max(1, Math.floor(frames / hop));
  // ~21 Hz bins at every common rate: the bass band keeps three bins
  const n = sampleRate > 60_000 ? 4096 : 2048;
  const fft = new Fft(n);
  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  // a full-scale sine's peak-bin magnitude under a Hann window is ~N/4
  const ref = (n / 4) * (n / 4);
  const edges = BAND_EDGES_HZ.map((hz) =>
    Math.min(n / 2, Math.max(1, Math.round((hz / sampleRate) * n))),
  );
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const bands = new Uint8Array(count * STRIP_BANDS);
  const loud = new Uint8Array(count);
  const inv = 1 / chans.length;
  for (let f = 0; f < count; f++) {
    const center = f * hop + hop / 2;
    const start = Math.round(center - n / 2);
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      let v = 0;
      if (idx >= 0 && idx < frames) for (const c of chans) v += c[idx];
      v *= inv;
      re[i] = v * window[i];
      im[i] = 0;
      if (i >= n / 2 - hop / 2 && i < n / 2 + hop / 2) sumSq += v * v;
    }
    fft.transform(re, im);
    for (let b = 0; b < STRIP_BANDS; b++) {
      let power = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) power += re[k] * re[k] + im[k] * im[k];
      bands[f * STRIP_BANDS + b] = toByte(10 * Math.log10(power / ref + 1e-12));
    }
    loud[f] = toByte(10 * Math.log10(sumSq / hop + 1e-12));
  }
  return { fps: STRIP_FPS, bands, loud };
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
