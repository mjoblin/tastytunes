// Audio analysis: a track's stored analysis (waveform, loudness, dynamic range), the
// loudness histograms an album integrates, and the keys analysis is stored under.

import type { MediaNode } from "./media";

/**
 * EXPERIMENT (0.7 exploration): a track's stored audio analysis — what the
 * renderer's decode persists (main's disk cache) and every waveform surface
 * rereads. Envelopes are quantized to integer thousandths of full scale so
 * the cache file stays humane; dB stats ride as null when non-finite
 * (silence), since JSON has no -Infinity.
 */
export interface AudioAnalysis {
  /** TT dynamic range integer; <= 0 means "no honest number". */
  dr: number;
  peakDb: number | null;
  rmsDb: number | null;
  crestDb: number | null;
  /** Peak/RMS envelopes at capture resolution, amplitude x1000 (0..1000). */
  peakQ: number[];
  rmsQ: number[];
  /** EBU R128 (0.8.0): integrated loudness in LUFS (null = gated to
   *  nothing, or measured before this field existed), loudness range in LU,
   *  true peak in dBTP (4× oversampled), and the gated block-loudness
   *  histogram (LOUD_HIST_BINS bins of LOUD_HIST_STEP LU from LOUD_HIST_MIN)
   *  so an ALBUM's loudness integrates across its tracks the way the
   *  standard says, not as an average of track values. */
  lufs?: number | null;
  lra?: number | null;
  truePeakDb?: number | null;
  loudHist?: number[] | null;
  /** The FEATURE STRIP (0.8.0, display mode's scenes): STRIP_BANDS band
   *  energies and one loudness per frame at `fps`, a byte each (0 = −60 dBFS,
   *  255 = 0 dBFS), base64. Absent = measured before the strip existed (the
   *  next play or Analyze audio measures again, the loudness precedent);
   *  null = the file's rate could not be read honestly (the DR rule). */
  strip?: AnalysisStrip | null;
  /** DRUM ONSETS (0.8.0, display mode's hits): every percussive onset the
   *  file's own decode found (lib/onsets: spectral flux on 10 ms steps),
   *  packed four bytes each (u16 gap in 10 ms steps, u8 strength, u8 type:
   *  0 kick, 1 snare, 2 hat), base64. Absent = measured before onsets
   *  existed (the next play or Analyze audio measures again, the strip's
   *  precedent); null = the file's rate could not be read honestly. */
  onsets?: AnalysisOnsets | null;
  /** MUSIC FEATURES (0.8.0, display mode): beat grid, sections, chroma and
   *  key, chord changes, stereo image, timbre, silences and drops, packed
   *  (lib/features). Absent or an older `version` = measure again once on
   *  the next play; null = the file's rate could not be read honestly. */
  features?: AnalysisFeatures | null;
}

export interface AnalysisOnsets {
  count: number;
  data: string;
}

export interface AnalysisFeatures {
  version: number;
  beats: { bpm: number; confidence: number; downbeat: number; count: number; times: string } | null;
  sections: { count: number; bounds: string; kinds: string; energy: string } | null;
  chroma: { fps: number; data: string } | null;
  key: { tonic: number; mode: "major" | "minor"; confidence: number } | null;
  changes: string;
  stereo: { fps: number; pan: string; width: string } | null;
  timbre: { fps: number; brightness: string; noisiness: string } | null;
  silences: string;
  drops: {
    count: number;
    buildFrom: string;
    at: string;
    strength: string;
    chill: string;
    breath: string;
    cut: string;
  };
}

export const STRIP_BANDS = 6;
export interface AnalysisStrip {
  fps: number;
  bands: string;
  loud: string;
}

/** What a row can know without decoding: the cached DR and loudness, and the tempo and key as
 *  Info says them (above their floors). */
export interface KnownStats {
  dr: number | null;
  lufs: number | null;
  bpm: number | null;
  key: string | null;
}

/** The block-loudness histogram: 0.1 LU bins from −70 LUFS (the absolute
 *  gate) to +10. */
export const LOUD_HIST_MIN = -70;
export const LOUD_HIST_STEP = 0.1;
export const LOUD_HIST_BINS = 800;
/** BS.1770's offset: loudness = −0.691 + 10·log10(mean square energy). */
export const LOUD_OFFSET = -0.691;

/** Integrate several tracks' block histograms into ONE loudness (the album
 *  value): the relative gate is applied over the combined distribution.
 *  Null when the histograms hold no gated blocks. */
export function integrateLoudnessHistograms(
  hists: ReadonlyArray<ReadonlyArray<number>>,
): number | null {
  const counts = new Float64Array(LOUD_HIST_BINS);
  for (const h of hists) for (let i = 0; i < LOUD_HIST_BINS && i < h.length; i++) counts[i] += h[i];
  const energyAt = (bin: number): number =>
    10 ** ((LOUD_HIST_MIN + (bin + 0.5) * LOUD_HIST_STEP - LOUD_OFFSET) / 10);
  let n = 0;
  let sum = 0;
  for (let i = 0; i < LOUD_HIST_BINS; i++) {
    if (counts[i] === 0) continue;
    n += counts[i];
    sum += counts[i] * energyAt(i);
  }
  if (n === 0) return null;
  const threshold = LOUD_OFFSET + 10 * Math.log10(sum / n) - 10;
  let n2 = 0;
  let sum2 = 0;
  for (let i = 0; i < LOUD_HIST_BINS; i++) {
    if (counts[i] === 0) continue;
    const l = LOUD_HIST_MIN + (i + 0.5) * LOUD_HIST_STEP;
    if (l <= threshold) continue;
    n2 += counts[i];
    sum2 += counts[i] * energyAt(i);
  }
  return n2 === 0 ? null : LOUD_OFFSET + 10 * Math.log10(sum2 / n2);
}

/** Round half to even, as the reference meter (numpy's round) does. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * The album's official DR — the reference's dynamic_range_meter.py sums
 * each track's INTEGER DR and divides by the scanned-track count, rounded
 * half-to-even like everything else. A decoded DR0 track (a silent
 * interlude) counts in the mean; only tracks that failed to decode don't.
 * An album value therefore exists only when EVERY track is measured.
 */
export function albumDr14(trackDrs: readonly number[]): number {
  if (trackDrs.length === 0) return 0;
  return roundHalfEven(trackDrs.reduce((s, v) => s + v, 0) / trackDrs.length);
}

/** An album's recorded DR — written ONLY when every track measured (the TT
 *  album value is the mean of ALL its tracks; a partial read has no honest
 *  number). `tracks` lets surfaces retire a stale entry when the album's
 *  track count changes. */
export interface AlbumDr {
  dr: number;
  tracks: number;
  analyzedAt: number;
  /** The album's integrated loudness (R128, gated across all tracks), when
   *  every track carried a histogram. */
  lufs?: number | null;
}

/** Content identity for stored audio analysis — the trackInfo key precedent
 *  (artist|album|title, lowercased) plus duration, so a remaster sharing
 *  its name doesn't inherit another edition's waveform. Identity, not
 *  location: server object ids churn on rescans. */
export function audioAnalysisKey(
  t: Pick<MediaNode, "title" | "artist" | "album" | "durationSecs">,
): string {
  return `${t.artist ?? ""}|${t.album ?? ""}|${t.title}|${t.durationSecs ?? ""}`.toLowerCase();
}

/** Album identity for the DR map — artist|title, lowercased. */
export function albumDrKey(a: Pick<MediaNode, "title" | "artist">): string {
  return `${a.artist ?? ""}|${a.title}`.toLowerCase();
}

/**
 * MEASURED FACTS, SAID ONCE (0.12.0, the first of the measured facts): a track's tempo and key as
 * the app says them, and only above the confidence the analysis earned (a beat grid below 0.35 is
 * a guess, and a key below 0.3). The Info rows, the agents' tools and the scenes' readouts read
 * these; the scenes' own spellings stay theirs (Terminal's plain "C#m").
 */
/** The music features' version (lib/features measures them): a stored analysis whose features
 *  carry another is measured again once, on its next play or sweep. In shared/model since 0.12.0,
 *  when the rows' and the agents' tempo and key, read in main, began to need it. */
export const FEATURES_VERSION = 12; // 12: the tempo's octave check; 11: the breath and the cut read past a riser before the slam; 9: drops at frame resolution

/** A stored analysis's music features when they are the current version's, else null: an older
 *  version's tempo may sit an octave off (the 0.9.0 octave check), so none of its facts is said
 *  until the track is measured again (0.12.0, his library held 47 such). */
export function currentFeatures<F extends { version: number }>(f: F | null | undefined): F | null {
  return f != null && f.version === FEATURES_VERSION ? f : null;
}

export const TEMPO_CONFIDENCE_FLOOR = 0.35;
export const KEY_CONFIDENCE_FLOOR = 0.3;
/** The pitch classes as a key is named, C = 0, with the usual sharps and flats. */
export const PITCH_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

/** A track's tempo in whole beats per minute, or null below its confidence floor. */
export function tempoBpm(
  beats: { bpm: number; confidence: number } | null | undefined,
): number | null {
  return beats && beats.confidence >= TEMPO_CONFIDENCE_FLOOR && beats.bpm > 0
    ? Math.round(beats.bpm)
    : null;
}

/** A track's key by name ("A minor"), or null below its confidence floor. */
export function keyName(
  key: { tonic: number; mode: "major" | "minor"; confidence: number } | null | undefined,
): string | null {
  return key && key.confidence >= KEY_CONFIDENCE_FLOOR && PITCH_NAMES[key.tonic] != null
    ? `${PITCH_NAMES[key.tonic]} ${key.mode}`
    : null;
}

/** A key as a person or an agent writes it, for a filter: "A minor", "F# major", "B♭ minor",
 *  "C♯m", "Am", a tonic alone ("E♭", either mode) or a mode alone ("minor", any tonic). Null
 *  when it names neither (0.12.0, list_tracks' key filter). */
export function parseKeyName(
  s: string,
): { tonic: number | null; mode: "major" | "minor" | null } | null {
  const t = s.trim().toLowerCase().replace(/♯/g, "#").replace(/♭/g, "b").replace(/\s+/g, " ");
  const modeOf = (m: string | undefined): "major" | "minor" | null =>
    m == null ? null : m === "maj" || m === "major" ? "major" : "minor";
  const alone = /^(major|minor)$/.exec(t);
  if (alone) return { tonic: null, mode: modeOf(alone[1]) };
  const k = /^([a-g])([#b]?) ?(major|minor|maj|min|m)?$/.exec(t);
  if (!k) return null;
  const natural = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[k[1] as "c"];
  const tonic = (natural + (k[2] === "#" ? 1 : k[2] === "b" ? -1 : 0) + 12) % 12;
  return { tonic, mode: modeOf(k[3]) };
}

/** Whether a track's key, above its floor, is the one a filter asked for. */
export function keyMatches(
  key: { tonic: number; mode: "major" | "minor"; confidence: number } | null | undefined,
  want: { tonic: number | null; mode: "major" | "minor" | null },
): boolean {
  if (!key || key.confidence < KEY_CONFIDENCE_FLOOR) return false;
  return (
    (want.tonic == null || key.tonic === want.tonic) &&
    (want.mode == null || key.mode === want.mode)
  );
}
