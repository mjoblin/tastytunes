/**
 * TEST-ONLY: synthetic audio for the unit tests of the measuring code (r128,
 * dr14, onsets, features). Nothing in the app imports this. Every signal is
 * generated, deterministic and analytically simple, so a test can say what
 * the answer must be before it measures anything.
 */

/** A sine at `dbfs` (0 dBFS = amplitude 1), `secs` long, starting at `phase` radians. */
export function sine(
  freq: number,
  dbfs: number,
  secs: number,
  fs: number,
  phase = 0,
): Float32Array {
  const amp = 10 ** (dbfs / 20);
  const out = new Float32Array(Math.round(secs * fs));
  for (let i = 0; i < out.length; i++)
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  return out;
}

/** Signals end to end. */
export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A seeded uniform noise source in [-1, 1) (a 32-bit LCG), so noise is the same every run. */
export function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

/** A kick drum added into `buf` at `at` seconds: a sine sweeping 150 → 50 Hz, 120 ms decay. */
export function addKick(buf: Float32Array, at: number, fs: number, amp = 0.9): void {
  const start = Math.round(at * fs);
  let phase = 0;
  for (let i = 0; i < Math.round(0.3 * fs) && start + i < buf.length; i++) {
    const t = i / fs;
    phase += (2 * Math.PI * (50 + 100 * Math.exp(-t / 0.03))) / fs;
    buf[start + i] += amp * Math.exp(-t / 0.12) * Math.sin(phase);
  }
}

/** A hi-hat added into `buf` at `at` seconds: differenced noise (tilted to the top octaves), 20 ms decay. */
export function addHat(
  buf: Float32Array,
  at: number,
  fs: number,
  rand: () => number,
  amp = 0.5,
): void {
  const start = Math.round(at * fs);
  let prev = 0;
  for (let i = 0; i < Math.round(0.08 * fs) && start + i < buf.length; i++) {
    const n = rand();
    buf[start + i] += amp * Math.exp(-i / fs / 0.02) * (n - prev);
    prev = n;
  }
}

export interface DrumTrack {
  /** Mono samples. */
  samples: Float32Array;
  /** When each kick starts, in seconds. */
  kicks: number[];
  /** When each hat starts, in seconds (empty without hats). */
  hats: number[];
}

/**
 * A steady kick pulse at `bpm` from 0.25 s to half a second before the end,
 * optionally with a hat on every off-beat (filling the gaps between kicks),
 * and optionally with every fourth kick accented (`accent` is the phase, 0–3,
 * of the loud kick; the others play at 0.3).
 */
export function drumTrack(
  bpm: number,
  secs: number,
  fs: number,
  { hats = false, accent }: { hats?: boolean; accent?: number } = {},
): DrumTrack {
  const samples = new Float32Array(Math.round(secs * fs));
  const period = 60 / bpm;
  const rand = noise(12345);
  const kicks: number[] = [];
  const hatTimes: number[] = [];
  for (let k = 0; 0.25 + k * period < secs - 0.5; k++) {
    const t = 0.25 + k * period;
    addKick(samples, t, fs, accent == null || k % 4 === accent ? 0.9 : 0.3);
    kicks.push(t);
    if (hats) {
      addHat(samples, t + period / 2, fs, rand);
      hatTimes.push(t + period / 2);
    }
  }
  return { samples, kicks, hats: hatTimes };
}
