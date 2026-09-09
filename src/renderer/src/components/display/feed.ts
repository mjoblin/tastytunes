import { useEffect, useRef } from "react";
import { STRIP_BANDS } from "@shared/model";
import { isRadioMetadata } from "@shared/smoip";
import { useStore } from "@/store";
import { deriveNowPlaying } from "@/lib/format";
import { useLyrics, type SyncedLine } from "@/hooks/useLyrics";
import { DISPLAY_FONTS } from "@/hooks/useDisplayFont";
import { usePlayingAnalysis, type Analysis } from "@/components/media/Waveform";
import { useScenePalette } from "./palette";
import { ONSET_TYPES, type Onsets } from "@/lib/onsets";
import { dropClears, type DropTier, type Features } from "@/lib/features";
import type {
  SceneFrame,
  SceneLyric,
  ScenePalette,
  SceneRecord,
  SceneHit,
  SceneBeat,
  SceneSection,
  SceneDrop,
} from "./scenes/types";
import { easeTowards, frameDelta } from "./clock";
import { clamp, cubic, noise } from "./scenes/lib";

/**
 * THE FEED: the one reader. Each animation frame it turns the store's
 * playhead, the playing track's feature strip and its timed lyrics into a
 * SceneFrame — smoothed, normalized per track, with the position interpolated
 * between the streamer's one-second reports. Scenes only ever see the frame.
 *
 * Normalization is per track (the 15th and 98th percentiles of each band and
 * of the loudness): a quiet master moves as much as a loud one, silence stays
 * still. Tracks with an envelope but no strip (analyzed before the strip
 * existed, or never re-measured) shape their bands from the loudness; tracks
 * with nothing at all — radio, casts, a library the app can't reach — drift
 * on slow sines, and the frame says so (`real`).
 */
// the breath (packscape's dream): a fast attack, a slow release, and a slow
// reading behind both — time constants in seconds, frame-rate independent
const ATTACK_TAU = 0.09;
const RELEASE_TAU = 0.4;
const SLOW_TAU = 1.4;
// the clock: the streamer reports position about once a second and the
// interpolation lurches at every report; the shown position follows it at a
// gently corrected rate (never backwards) and snaps only on a seek or a new track
const SNAP_SECS = 2.5;
const CLOCK_CORRECTION = 0.12;

interface Norm {
  lo: Float32Array; // STRIP_BANDS + 1 (loud last)
  hi: Float32Array;
}

/** A strip value at a fractional frame, Catmull-Rom over the four frames around it. */
function sampleStrip(arr: Uint8Array, stride: number, offset: number, fi: number): number {
  const frames = Math.floor((arr.length - offset) / stride);
  if (frames <= 0) return 0;
  const i1 = clamp(Math.floor(fi), 0, frames - 1);
  const t = clamp(fi - Math.floor(fi));
  const at = (i: number): number => arr[clamp(i, 0, frames - 1) * stride + offset];
  return cubic(at(i1 - 1), at(i1), at(i1 + 1), at(i1 + 2), t);
}

function percentiles(
  values: Uint8Array | Float32Array,
  stride: number,
  offset: number,
  p: number[],
): number[] {
  const n = Math.floor((values.length - offset) / stride);
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) arr[i] = values[offset + i * stride];
  arr.sort();
  return p.map((q) => arr[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))] ?? 0);
}

export class SceneFeed {
  analysis: Analysis | null = null;
  synced: SyncedLine[] | null = null;
  lyricsOn = true;
  palette: ScenePalette = {
    light: false,
    bg: [14, 13, 11],
    ink: [244, 239, 230],
    dim: [166, 158, 144],
    faint: [130, 120, 106],
    gold: [240, 168, 72],
    accent: [
      [240, 168, 72],
      [120, 150, 200],
      [200, 110, 120],
    ],
  };
  font = "'Fraunces Variable', Georgia, serif";
  title: string | null = null;
  subtitle: string | null = null;

  private norm: Norm | null = null;
  /** The file's drum onsets and the cursor of the last one fired. */
  private onsets: Onsets | null = null;
  private hitCursor = 0;
  private hitPos: number | null = null;
  private hits: SceneHit[] = [];
  /** The music features and the eased readings drawn from them. */
  private features: Features | null = null;
  private beatPos: number | null = null;
  private chordCursor = 0;
  private chordPos: number | null = null;
  private chroma = new Float32Array(12);
  private pan = 0;
  private width = 0;
  private brightness = 0.5;
  private noisiness = 0.5;
  private quiet = 0;
  private dropPos: number | null = null;
  private sectionList: SceneFrame["sections"] = [];
  /** The display's sync nudge in seconds (settings.displaySyncMs), added to the shown clock. */
  syncSecs = 0;
  /** How much lull a drop needs (settings.displayDrops). */
  dropTier: DropTier = "normal";
  private record: SceneRecord | null = null;
  private envNorm: { lo: number; hi: number } | null = null;
  private bands = new Float32Array(STRIP_BANDS);
  private loud = 0;
  private slow = 0;
  private lastNow = 0;
  private lyricIdx = -1;
  private slowBands = new Float32Array(STRIP_BANDS);
  private shownPos: number | null = null;
  private shownKey = "";
  /** The playing track's identity, set by the hook: a change snaps the clock. */
  trackKey = "";

  setAnalysis(a: Analysis | null): void {
    if (a === this.analysis) return;
    this.analysis = a;
    this.norm = null;
    this.envNorm = null;
    this.record = null;
    this.onsets = a?.onsets ?? null;
    this.hitPos = null;
    this.features = a?.features ?? null;
    this.beatPos = null;
    this.chordPos = null;
    this.dropPos = null;
    this.chroma.fill(0);
    const S = a?.features?.sections;
    const total = a?.strip ? a.strip.loud.length / a.strip.fps : 0;
    this.sectionList = S
      ? Array.from(S.kinds, (k, i) => ({
          start: i === 0 ? 0 : S.bounds[i - 1],
          end: i < S.bounds.length ? S.bounds[i] : total,
          kind: k === 1 ? ("chorus" as const) : ("other" as const),
          energy: S.energy[i] ?? 0,
        }))
      : [];
    if (a?.strip) {
      const lo = new Float32Array(STRIP_BANDS + 1);
      const hi = new Float32Array(STRIP_BANDS + 1);
      for (let b = 0; b < STRIP_BANDS; b++) {
        const [l, h] = percentiles(a.strip.bands, STRIP_BANDS, b, [0.15, 0.98]);
        lo[b] = l;
        hi[b] = Math.max(h, l + 12);
      }
      const [l, h] = percentiles(a.strip.loud, 1, 0, [0.15, 0.98]);
      lo[STRIP_BANDS] = l;
      hi[STRIP_BANDS] = Math.max(h, l + 12);
      this.norm = { lo, hi };
      // the record: the whole strip through the same normalization, once
      const frames = a.strip.loud.length;
      const bands = new Float32Array(frames * STRIP_BANDS);
      const loud = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        for (let b = 0; b < STRIP_BANDS; b++)
          bands[i * STRIP_BANDS + b] = clamp(
            (a.strip.bands[i * STRIP_BANDS + b] - lo[b]) / (hi[b] - lo[b]),
          );
        loud[i] = clamp((a.strip.loud[i] - lo[STRIP_BANDS]) / (hi[STRIP_BANDS] - lo[STRIP_BANDS]));
      }
      this.record = { fps: a.strip.fps, frames, bands, loud };
    } else if (a) {
      // envelope only: RMS amplitude → dB, the same percentile rule
      const db = Float32Array.from(a.rms, (v) => (v > 0 ? 20 * Math.log10(v) : -80));
      const [l, h] = percentiles(db, 1, 0, [0.15, 0.98]);
      this.envNorm = { lo: l, hi: Math.max(h, l + 3) };
    }
  }

  /** The music features read at the shown clock: the beat grid, the section, the nearest
   *  drop, the chroma, the stereo image, the timbre and the quiet, eased where they are
   *  continuous, crossings flagged once per timestamp. */
  private musicAt(
    position: number,
    live: boolean,
    fresh: boolean,
    dt: number,
  ): Pick<
    SceneFrame,
    | "beat"
    | "section"
    | "sections"
    | "drop"
    | "chroma"
    | "key"
    | "onChord"
    | "pan"
    | "width"
    | "brightness"
    | "noisiness"
    | "quiet"
  > {
    const F = this.features;
    let beat: SceneBeat | null = null;
    let section: SceneSection | null = null;
    let drop: SceneDrop | null = null;
    let onChord = false;
    if (F && live) {
      // the beat grid, when the track's tempo was confident
      const B = F.beats;
      if (B && B.confidence >= 0.35 && B.times.length > 2) {
        const i = Math.min(B.times.length - 2, Math.max(0, firstAfter(B.times, position) - 1));
        const t0 = B.times[i];
        const period = Math.max(0.05, B.times[i + 1] - t0);
        const phase = clamp((position - t0) / period);
        const down = B.downbeat >= 0 ? B.downbeat : 0;
        const beatInBar = (((i - down) % 4) + 4) % 4;
        const crossed = fresh && this.beatPos != null && Math.abs(position - this.beatPos) < 1;
        const onBeat = crossed && firstAfter(B.times, this.beatPos as number) <= i;
        beat = {
          bpm: B.bpm,
          phase,
          bar: (beatInBar + phase) / 4,
          onBeat,
          onBar: onBeat && beatInBar === 0,
          confidence: B.confidence,
        };
      }
      if (fresh) this.beatPos = position;
      // the section
      const S = F.sections;
      if (S) {
        const idx = firstAfter(S.bounds, position);
        const start = idx === 0 ? 0 : S.bounds[idx - 1];
        const end = idx < S.bounds.length ? S.bounds[idx] : Infinity;
        const kindOf = (k: number | undefined): "chorus" | "other" =>
          k === 1 ? "chorus" : "other";
        section = {
          index: idx,
          count: S.kinds.length,
          kind: kindOf(S.kinds[idx]),
          progress: end === Infinity ? 0 : clamp((position - start) / Math.max(1, end - start)),
          untilNext: end === Infinity ? Infinity : end - position,
          energy: S.energy[idx] ?? 0,
          nextKind: idx + 1 < S.kinds.length ? kindOf(S.kinds[idx + 1]) : null,
          nextEnergy: S.energy[idx + 1] ?? 0,
        };
      }
      // the nearest drop: in its build, or just released
      const D = F.drops;
      for (let i = 0; i < D.at.length; i++) {
        if (!dropClears(D, i, this.dropTier)) continue;
        const at = D.at[i];
        const from = D.buildFrom[i];
        if (position < from || position > at + 2.5) continue;
        const build = position < at ? clamp((position - from) / Math.max(0.5, at - from)) : 1;
        const release = position >= at ? clamp(1 - (position - at) / 2.5) : 0;
        const onDrop = fresh && this.dropPos != null && this.dropPos < at && position >= at;
        drop = { build, release, strength: D.strength[i], until: at - position, onDrop };
        break;
      }
      if (fresh) this.dropPos = position;
      // chord changes crossed
      if (fresh) {
        if (this.chordPos == null || position < this.chordPos || position - this.chordPos > 1)
          this.chordCursor = firstAfter(F.changes, position);
        else
          while (this.chordCursor < F.changes.length && F.changes[this.chordCursor] <= position) {
            this.chordCursor++;
            onChord = true;
          }
        this.chordPos = position;
      }
      // the continuous readings, eased
      const C = F.chroma;
      if (C) {
        const frames = C.data.length / 12;
        const x = clamp(position * C.fps, 0, frames - 1.001);
        const a = Math.floor(x);
        const t = x - a;
        for (let p = 0; p < 12; p++) {
          const v = C.data[a * 12 + p] * (1 - t) + C.data[(a + 1) * 12 + p] * t;
          this.chroma[p] = easeTowards(this.chroma[p], v, dt, 0.3);
        }
      }
      const at1 = (arr: Float32Array, fps: number): number => {
        const x = clamp(position * fps, 0, arr.length - 1.001);
        const a = Math.floor(x);
        return arr[a] * (1 - (x - a)) + arr[a + 1] * (x - a);
      };
      if (F.stereo) {
        this.pan = easeTowards(this.pan, at1(F.stereo.pan, F.stereo.fps), dt, 0.25);
        this.width = easeTowards(this.width, at1(F.stereo.width, F.stereo.fps), dt, 0.25);
      }
      if (F.timbre) {
        this.brightness = easeTowards(
          this.brightness,
          at1(F.timbre.brightness, F.timbre.fps),
          dt,
          0.25,
        );
        this.noisiness = easeTowards(
          this.noisiness,
          at1(F.timbre.noisiness, F.timbre.fps),
          dt,
          0.25,
        );
      }
      let inSilence = false;
      for (let i = 0; i + 1 < F.silences.length; i += 2)
        if (position >= F.silences[i] && position < F.silences[i + 1]) inSilence = true;
      this.quiet = easeTowards(this.quiet, inSilence ? 1 : 0, dt, 0.4);
    } else {
      this.beatPos = null;
      this.dropPos = null;
      this.chordPos = null;
      this.quiet = easeTowards(this.quiet, 0, dt, 0.4);
    }
    return {
      beat,
      section,
      sections: live ? this.sectionList : [],
      drop,
      chroma: this.chroma,
      key: F?.key ?? null,
      onChord,
      pan: this.pan,
      width: this.width,
      brightness: this.brightness,
      noisiness: this.noisiness,
      quiet: this.quiet,
    };
  }

  /** Raw normalized loudness at an absolute position. */
  private rawLoudAt(secs: number, duration: number | null, now: number): number {
    const a = this.analysis;
    if (a?.strip && this.norm) {
      const s = a.strip;
      const v = sampleStrip(s.loud, 1, 0, secs * s.fps);
      const { lo, hi } = this.norm;
      return clamp((v - lo[STRIP_BANDS]) / (hi[STRIP_BANDS] - lo[STRIP_BANDS]));
    }
    if (a && this.envNorm && duration && duration > 0) {
      const b = clamp(Math.floor((secs / duration) * a.rms.length), 0, a.rms.length - 1);
      const v = a.rms[b];
      const db = v > 0 ? 20 * Math.log10(v) : -80;
      return clamp((db - this.envNorm.lo) / (this.envNorm.hi - this.envNorm.lo));
    }
    // adrift: a slow swell tied to the clock, so the picture still breathes
    return 0.3 + 0.3 * noise(secs * 0.35 + now * 0.0002, 3);
  }

  private rawBandsAt(secs: number, duration: number | null, now: number, out: Float32Array): void {
    const a = this.analysis;
    if (a?.strip && this.norm) {
      const s = a.strip;
      const fi = secs * s.fps;
      const { lo, hi } = this.norm;
      for (let b = 0; b < STRIP_BANDS; b++) {
        const v = sampleStrip(s.bands, STRIP_BANDS, b, fi);
        out[b] = clamp((v - lo[b]) / (hi[b] - lo[b]));
      }
      return;
    }
    const loud = this.rawLoudAt(secs, duration, now);
    const shaped = a != null; // an envelope shapes the bands from its loudness
    for (let b = 0; b < STRIP_BANDS; b++) {
      const wander = noise(now * 0.00035 * (1 + b * 0.21), b * 7);
      out[b] = shaped ? clamp(loud * (0.55 + 0.6 * wander)) : clamp(0.25 + 0.45 * wander);
    }
  }

  private lyricAt(pos: number, duration: number | null): SceneLyric | null {
    const lines = this.synced;
    if (!this.lyricsOn || !lines || lines.length === 0) return null;
    // walk from the last index: the common case is "same line" or "next line"
    let i = this.lyricIdx;
    if (i >= lines.length || (i >= 0 && lines[i].t > pos)) i = -1;
    while (i + 1 < lines.length && lines[i + 1].t <= pos) i++;
    this.lyricIdx = i;
    const start = i >= 0 ? lines[i].t : 0;
    const end = i + 1 < lines.length ? lines[i + 1].t : Math.max(start + 1, duration ?? start + 8);
    let next: string | null = null;
    for (let j = i + 1; j < lines.length; j++)
      if (lines[j].text) {
        next = lines[j].text;
        break;
      }
    return {
      text: i >= 0 ? lines[i].text : "",
      next,
      start,
      end,
      progress: clamp((pos - start) / Math.max(0.001, end - start)),
      index: i,
      lines,
    };
  }

  frame(now: number, w: number, h: number, mini: boolean, callerDt?: number): SceneFrame {
    const s = useStore.getState();
    const playing = s.playState?.state === "play";
    const radio = isRadioMetadata(s.playState?.metadata);
    let position = 0;
    let duration: number | null = null;
    if (radio) {
      position = playing && s.stationTunedAt != null ? (Date.now() - s.stationTunedAt) / 1000 : 0;
    } else {
      duration =
        s.playState?.metadata?.duration ?? s.nowPlaying?.display?.progress?.duration ?? null;
      position = s.playhead?.secs ?? 0;
      if (s.playhead && playing) position += (Date.now() - s.playhead.at) / 1000;
      if (duration) position = Math.min(position, duration);
    }
    // the feed advances ONCE per frame timestamp, whichever canvas asks first;
    // a later canvas in the same frame gets no step here but its own delta below
    // (the picker runs several canvases on one feed: the stage was being handed
    // a zero delta and its waves and spray froze while the picker was open)
    const fresh = now !== this.lastNow;
    const dt = fresh && this.lastNow ? frameDelta((now - this.lastNow) / 1000) : 0;
    if (fresh) this.lastNow = now;

    // the shown clock follows the reported one at a corrected rate
    if (
      this.shownPos == null ||
      !playing ||
      this.shownKey !== this.trackKey ||
      Math.abs(position - this.shownPos) > SNAP_SECS
    ) {
      this.shownPos = position;
    } else {
      const err = position - this.shownPos;
      const rate = 1 + clamp(err / 4, -CLOCK_CORRECTION, CLOCK_CORRECTION);
      this.shownPos += dt * rate;
      if (duration) this.shownPos = Math.min(this.shownPos, duration);
    }
    this.shownKey = this.trackKey;
    position = this.shownPos + this.syncSecs;

    const target = new Float32Array(STRIP_BANDS);
    this.rawBandsAt(position, duration, now, target);
    const loudNow = this.rawLoudAt(position, duration, now);
    // a frozen playhead holds the picture still: paused tracks don't shimmer
    const gate = playing || !this.analysis ? 1 : 0.35;
    for (let b = 0; b < STRIP_BANDS; b++) {
      const t = target[b] * gate;
      this.bands[b] = easeTowards(
        this.bands[b],
        t,
        dt,
        t > this.bands[b] ? ATTACK_TAU : RELEASE_TAU,
      );
      this.slowBands[b] = easeTowards(this.slowBands[b], t, dt, SLOW_TAU);
    }
    const loudT = loudNow * gate;
    this.loud = easeTowards(this.loud, loudT, dt, loudT > this.loud ? ATTACK_TAU : RELEASE_TAU);
    this.slow = easeTowards(this.slow, loudNow, dt, SLOW_TAU);
    const onset = clamp((loudNow - this.slow) * 2.6);
    // the hits: every onset the shown clock crossed since the last timestamp, once per
    // timestamp (every canvas of a frame sees the same list); a seek or a snap moves the
    // cursor without firing what it skipped
    if (fresh) {
      this.hits = [];
      const on = this.onsets;
      if (on && playing && !radio) {
        if (this.hitPos == null || position < this.hitPos || position - this.hitPos > 1) {
          this.hitCursor = firstAfter(on.at, position);
        } else {
          while (this.hitCursor < on.at.length && on.at[this.hitCursor] <= position) {
            const i = this.hitCursor++;
            this.hits.push({
              at: on.at[i],
              strength: on.strength[i],
              type: ONSET_TYPES[on.type[i]] ?? "snare",
            });
          }
        }
        this.hitPos = position;
      } else this.hitPos = null;
    }
    // the same transient read on the bass band alone: a kick under a sustained mix
    const kick = clamp((target[0] * gate - this.slowBands[0]) * 2.6);
    const real = this.analysis != null && !radio;
    const music = this.musicAt(position, playing && !radio, fresh, dt);
    return {
      now,
      dt: callerDt ?? dt,
      w,
      h,
      position,
      duration,
      playing,
      bands: this.bands,
      loud: this.loud,
      onset,
      kick,
      hits: this.hits,
      hitsKnown: this.onsets != null && !radio,
      ...music,
      slowBands: this.slowBands,
      slowLoud: this.slow,
      real,
      loudAt: (secs) => this.rawLoudAt(secs, duration, now),
      record: this.record,
      lyric: this.lyricAt(position, duration),
      title: this.title,
      subtitle: this.subtitle,
      palette: this.palette,
      font: this.font,
      reduced: document.documentElement.classList.contains("reduce-motion"),
      mini,
    };
  }
}

/** First index whose time is past `secs` (binary search on an ascending array). */
function firstAfter(at: Float32Array, secs: number): number {
  let lo = 0;
  let hi = at.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid] <= secs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One feed per display mode, kept current from the hooks; `enabled` gates
 *  the analysis fetch so the Sleeve pays nothing for the scenes. */
export function useSceneFeed(enabled: boolean): SceneFeed {
  const ref = useRef<SceneFeed | null>(null);
  if (!ref.current) ref.current = new SceneFeed();
  const feed = ref.current;
  const analysis = usePlayingAnalysis(enabled);
  const { synced } = useLyrics();
  const lyricsOn = useStore((st) => st.settings.lyrics && st.settings.displayLyrics);
  const fontId = useStore((st) => st.settings.displayFont);
  const syncMs = useStore((st) => st.settings.displaySyncMs);
  const dropTier = useStore((st) => st.settings.displayDrops);
  const playState = useStore((st) => st.playState);
  const nowPlaying = useStore((st) => st.nowPlaying);
  const meta = deriveNowPlaying(playState, nowPlaying);
  const palette = useScenePalette(meta.artUrl);
  useEffect(() => {
    feed.setAnalysis(analysis === "loading" ? null : analysis);
  }, [feed, analysis]);
  feed.synced = synced;
  feed.syncSecs = (syncMs ?? 0) / 1000;
  feed.dropTier = dropTier ?? "normal";
  feed.lyricsOn = lyricsOn;
  feed.palette = palette;
  feed.font = DISPLAY_FONTS.find((f) => f.id === fontId)?.stack ?? feed.font;
  feed.title = meta.title;
  feed.subtitle = meta.subtitle;
  feed.trackKey = `${meta.title ?? ""}|${meta.subtitle ?? ""}|${meta.album ?? ""}`;
  return feed;
}
