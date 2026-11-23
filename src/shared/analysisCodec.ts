import {
  FEATURES_VERSION,
  KEY_VERSION,
  keyFromStored,
  type AnalysisFeatures,
  type AnalysisOnsets,
  type AnalysisStrip,
} from "./model";

/**
 * THE ANALYSIS'S PACKED FORMATS, ONE HOME (0.17.0): what the window measures (renderer lib/features,
 * lib/onsets, lib/featureStrip) is stored packed beside the analysis, base64 bytes, and read back
 * here, in both directions. Shared, so main reads the same numbers the window draws from (the
 * agent export) rather than a second copy of the packing. Pure: no DOM, no Node.
 */

// ------------------------------------------------------------------ the strip

/** The strip's band edges in Hz: bass, low, low-mid, mid, presence, air (STRIP_BANDS bands). */
export const STRIP_BAND_EDGES_HZ: readonly number[] = [20, 80, 250, 800, 2500, 6000, 16000];

export interface Strip {
  fps: number;
  /** STRIP_BANDS values per frame, frame-major. */
  bands: Uint8Array;
  loud: Uint8Array;
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

// ------------------------------------------------------------------ onsets

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

// ------------------------------------------------------------------ features

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
/** Seconds to hundredths, as u16 gaps (a beat grid: no two beats 655 s apart). */
const centiGaps = (secs: ArrayLike<number>): Uint8Array => {
  const gaps: number[] = [];
  let prev = 0;
  for (let i = 0; i < secs.length; i++) {
    const t = Math.round(secs[i] * 100);
    gaps.push(Math.max(0, t - prev));
    prev += Math.max(0, t - prev);
  }
  return u16s(gaps);
};
const fromCentiGaps = (bytes: Uint8Array): Float32Array => {
  const gaps = fromU16s(bytes);
  const out = new Float32Array(gaps.length);
  let t = 0;
  for (let i = 0; i < gaps.length; i++) {
    t += gaps[i];
    out[i] = t / 100;
  }
  return out;
};
/** Each drop's build-up start, from its drop's tenth and its distance back in tenths. */
const buildFromBack = (at: Uint8Array, back: Uint8Array): Float32Array => {
  const tenths = fromU32s(at);
  const backs = fromU16s(back);
  return Float32Array.from(tenths, (t, i) => (t - (backs[i] ?? 0)) / 10);
};
const u32s = (values: ArrayLike<number>): Uint8Array => {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++)
    view.setUint32(i * 4, Math.max(0, Math.min(0xffffffff, Math.round(values[i]))), true);
  return out;
};
const fromU32s = (bytes: Uint8Array): Float64Array => {
  const out = new Float64Array(Math.floor(bytes.length / 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
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
          // gaps, in hundredths (0.14.0): absolute hundredths stopped at 655.35 s, so every beat
          // after 10:55 of a long track read 10:55
          times: b64(centiGaps(f.beats.times)),
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
          v: KEY_VERSION,
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
      // the drops in u32 tenths and each build-up as its distance back from its drop (0.14.0):
      // u16 tenths stopped at 6553.5 s, a long mix's
      buildFrom: b64(
        u16s(
          Array.from(f.drops.at, (t, i) =>
            Math.max(0, Math.round(t * 10) - Math.round(f.drops.buildFrom[i] * 10)),
          ),
        ),
      ),
      at: b64(u32s(Array.from(f.drops.at, (t) => Math.round(t * 10)))),
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
        times: fromCentiGaps(unb64(st.beats.times)),
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
    // a key the older estimator made is estimated again from the chroma beside it
    key: keyFromStored(st),
    changes: fromTenthsGaps(unb64(st.changes)),
    stereo,
    timbre,
    silences: fromTenthsGaps(unb64(st.silences)),
    drops: {
      buildFrom: buildFromBack(unb64(st.drops.at), unb64(st.drops.buildFrom)),
      at: Float32Array.from(fromU32s(unb64(st.drops.at)), (t) => t / 10),
      strength: from01(unb64(st.drops.strength)),
      chill: Float32Array.from(unb64(st.drops.chill ?? ""), (c) => c / 4),
      breath: Float32Array.from(unb64(st.drops.breath ?? ""), (c) => c / 4),
      cut: Float32Array.from(unb64(st.drops.cut ?? ""), (c) => c / 10),
    },
  };
}
