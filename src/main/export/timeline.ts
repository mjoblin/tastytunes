import type { Features, Strip } from "@shared/analysisCodec";

/**
 * THE TIMELINE, BUILT FOR THE READER (0.17.0, export for an agent): the analysis's sections with
 * the lyric lines that fall in each, and the moments worth cutting on, in order. Named as the
 * analysis knows them: a section is the part that comes back loudest or another part, and nothing
 * here says verse or chorus, which the analysis cannot tell. Pure.
 */

export interface LyricLine {
  at_seconds: number;
  text: string;
}

export interface TimelineSection {
  start_seconds: number;
  end_seconds: number;
  /** "repeated_loud": the kind of part that comes back most and is loudest (often what a listener
   *  would call the chorus, though the analysis can't tell one part's name from another's);
   *  "other": everything else. */
  kind: "repeated_loud" | "other";
  /** 0..1, against the track's own range. */
  energy: number;
  mean_loudness_dbfs: number | null;
  /** 0 dark … 1 bright, the section's mean (spectral centroid). */
  mean_brightness: number | null;
  lyrics: LyricLine[];
}

export interface Moment {
  at_seconds: number;
  what:
    | "build_starts"
    | "drop"
    | "silence_starts"
    | "silence_ends"
    | "loudest_second"
    | "quietest_second"
    | "first_lyric"
    | "last_lyric";
  /** A drop's strength, 0..1. */
  strength?: number;
}

const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;

/** The strip's loudness byte as dBFS (0 = −60, 255 = 0). */
const dbfs = (b: number): number => (b / 255) * 60 - 60;

function meanLoudness(strip: Strip | null, start: number, end: number): number | null {
  if (!strip || strip.loud.length === 0) return null;
  const a = Math.max(0, Math.floor(start * strip.fps));
  const b = Math.min(strip.loud.length, Math.ceil(end * strip.fps));
  if (b <= a) return null;
  let sum = 0;
  for (let i = a; i < b; i++) sum += strip.loud[i];
  return round(dbfs(sum / (b - a)), 1);
}

/** A per-frame curve's mean over a stretch, or null without one. */
function meanOf(
  curve: { fps: number; values: ArrayLike<number> } | null,
  start: number,
  end: number,
): number | null {
  if (!curve || curve.values.length === 0) return null;
  const a = Math.max(0, Math.floor(start * curve.fps));
  const b = Math.min(curve.values.length, Math.ceil(end * curve.fps));
  if (b <= a) return null;
  let sum = 0;
  for (let i = a; i < b; i++) sum += curve.values[i];
  return round(sum / (b - a));
}

/** The loudest and quietest whole seconds by the strip (silence at the very ends left out). */
function extremes(strip: Strip | null): { loud: number; quiet: number } | null {
  if (!strip || strip.loud.length < strip.fps * 4) return null;
  const secs = Math.floor(strip.loud.length / strip.fps);
  const per: number[] = [];
  for (let s = 0; s < secs; s++) {
    let sum = 0;
    for (let i = s * strip.fps; i < (s + 1) * strip.fps; i++) sum += strip.loud[i];
    per.push(sum / strip.fps);
  }
  const inner = per.map((v, s) => ({ v, s })).slice(1, -1);
  const loud = inner.reduce((m, x) => (x.v > m.v ? x : m), inner[0]);
  const quiet = inner.reduce((m, x) => (x.v < m.v ? x : m), inner[0]);
  return { loud: loud.s, quiet: quiet.s };
}

export function buildTimeline(
  features: Features | null,
  strip: Strip | null,
  lyrics: LyricLine[],
  durationSecs: number | null,
): { sections: TimelineSection[]; moments: Moment[] } {
  const sections: TimelineSection[] = [];
  const s = features?.sections;
  // the bounds lie between sections (never 0, never the end): the last section runs to the end
  const end = durationSecs ?? (strip && strip.fps > 0 ? strip.loud.length / strip.fps : null);
  if (s && s.kinds.length > 0 && end != null) {
    const edges = [0, ...s.bounds, end];
    for (let i = 0; i + 1 < edges.length && i < s.kinds.length; i++) {
      const [from, to] = [edges[i], edges[i + 1]];
      if (to <= from) continue;
      sections.push({
        start_seconds: round(from),
        end_seconds: round(to),
        kind: s.kinds[i] === 1 ? "repeated_loud" : "other",
        energy: round(s.energy[i] ?? 0),
        mean_loudness_dbfs: meanLoudness(strip, from, to),
        mean_brightness: meanOf(
          features?.timbre
            ? { fps: features.timbre.fps, values: features.timbre.brightness }
            : null,
          from,
          to,
        ),
        lyrics: lyrics.filter((l) => l.at_seconds >= from && l.at_seconds < to),
      });
    }
  }
  const moments: Moment[] = [];
  const d = features?.drops;
  if (d)
    for (let i = 0; i < d.at.length; i++) {
      moments.push({ at_seconds: round(d.buildFrom[i] ?? d.at[i]), what: "build_starts" });
      moments.push({
        at_seconds: round(d.at[i]),
        what: "drop",
        strength: round(d.strength[i] ?? 0),
      });
    }
  const sil = features?.silences;
  if (sil)
    for (let i = 0; i + 1 < sil.length; i += 2) {
      moments.push({ at_seconds: round(sil[i]), what: "silence_starts" });
      moments.push({ at_seconds: round(sil[i + 1]), what: "silence_ends" });
    }
  const x = extremes(strip);
  if (x) {
    moments.push({ at_seconds: x.loud, what: "loudest_second" });
    moments.push({ at_seconds: x.quiet, what: "quietest_second" });
  }
  const sung = lyrics.filter((l) => l.text.trim() !== "");
  if (sung.length) {
    moments.push({ at_seconds: sung[0].at_seconds, what: "first_lyric" });
    moments.push({ at_seconds: sung[sung.length - 1].at_seconds, what: "last_lyric" });
  }
  const within = (m: Moment): boolean => durationSecs == null || m.at_seconds <= durationSecs + 1;
  return { sections, moments: moments.filter(within).sort((a, b) => a.at_seconds - b.at_seconds) };
}
