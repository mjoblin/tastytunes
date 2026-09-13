import type { DisplayScene, SceneSettingValue } from "@shared/model";
import type * as THREE from "three";

/**
 * THE SCENE CONTRACT. A scene is a pure drawing: given a canvas (2D, or a
 * WebGL2 context plus a 2D overlay for crisp text) and this frame's numbers
 * it paints one picture. Everything a scene may know arrives in the frame —
 * the feed (../feed.ts) is the one place that reads the store, the strip and
 * the lyrics — so a scene never subscribes to anything and the picker can
 * run every one of them small at once. Two rules carried from packscape:
 * scene TIME is accumulated at the current pace (never elapsed × speed, which
 * teleports when the pace changes), and anything a person watches is eased,
 * never a raw sample.
 */
export type Rgb = [number, number, number];

export interface ScenePalette {
  light: boolean;
  bg: Rgb;
  ink: Rgb;
  dim: Rgb;
  faint: Rgb;
  gold: Rgb;
  /** Three colors from the art (the gold's neighbours when the art is plain). */
  accent: Rgb[];
  /** The art's overall hue at a wall's depth, for a scene to cast its base toward; absent when
   *  the art is plain or unknown. */
  tint?: Rgb;
}

export interface SceneLyric {
  /** The current line; "" through an intro or a gap. */
  text: string;
  /** The next line with words, if any. */
  next: string | null;
  start: number;
  end: number;
  /** 0..1 across the line's life (to the next line's time). */
  progress: number;
  index: number;
  /** Every line with its time: the scenes that show what is coming. */
  lines: readonly { t: number; text: string }[];
}

/** One drum onset the clock just crossed, from the file's own onset list (lib/onsets). */
export interface SceneHit {
  /** Track seconds. */
  at: number;
  /** 0..1 against the track's strongest hits. */
  strength: number;
  type: "kick" | "snare" | "hat";
}

/** Where the clock stands in the beat grid (null when the track has no confident grid). */
export interface SceneBeat {
  bpm: number;
  /** 0..1 through the current beat. */
  phase: number;
  /** 0..1 through the bar (four beats from the downbeat; a guess when the kicks did not say). */
  bar: number;
  /** True on the frame that crossed a beat, and on the one that crossed a downbeat. */
  onBeat: boolean;
  onBar: boolean;
  confidence: number;
}
/** The section the clock is in (null when the track has no sections). */
export interface SceneSection {
  index: number;
  count: number;
  /** "chorus" for the most repeated loud kind, else "other". */
  kind: "chorus" | "other";
  /** 0..1 through the section, and seconds until the next boundary (Infinity at the last). */
  progress: number;
  untilNext: number;
  /** This section's mean energy, 0..1 against the track's loudest. */
  energy: number;
  /** The next section's kind and energy, so a scene can see what is coming. */
  nextKind: "chorus" | "other" | null;
  nextEnergy: number;
}
/** The nearest drop (the energy kicking back in after three seconds or more of relative
 *  chill): its build (0..1 from the chill's start to the drop) and its release (1 at the
 *  drop, gone two and a half seconds later). Null when none is near. */
export interface SceneDrop {
  build: number;
  release: number;
  strength: number;
  /** Seconds until the drop (negative after it). */
  until: number;
  /** True on the frame that crossed the drop itself. */
  onDrop: boolean;
}

export interface SceneFrame {
  /** performance.now() ms, and the seconds since the last frame (clamped). */
  now: number;
  dt: number;
  w: number;
  h: number;
  position: number;
  duration: number | null;
  playing: boolean;
  /** Six band energies (bass … air), smoothed, normalized per track to 0..1. */
  bands: Float32Array;
  /** Loudness, smoothed and normalized 0..1; onset is the transient above its slow average. */
  loud: number;
  onset: number;
  /** The bass band's transient above its slow average, 0..1: the drum's kick, read where
   *  broadband loudness barely moves under a sustained mix. Ten frames a second, so it
   *  is most kicks, not every one. */
  kick: number;
  /** The drum onsets the clock crossed since the last frame, from the file's own onset
   *  list: exact to the clock, typed, most frames empty. Empty too when no list is known
   *  (radio, or an analysis from before onsets); `hitsKnown` says which, so a scene can
   *  fall back to the strip's transient. */
  hits: readonly SceneHit[];
  hitsKnown: boolean;
  /** THE MUSIC FEATURES (lib/features), null or empty when the track has none. */
  beat: SceneBeat | null;
  section: SceneSection | null;
  /** Every section with its span, for the scenes that draw the whole track; empty when unknown.
   *  The same array identity while the track is the same. */
  sections: readonly { start: number; end: number; kind: "chorus" | "other"; energy: number }[];
  drop: SceneDrop | null;
  /** Twelve pitch classes (C..B) at now, 0..1, eased; all zero when unknown. */
  chroma: Float32Array;
  /** The track's key, when measured. */
  key: { tonic: number; mode: "major" | "minor"; confidence: number } | null;
  /** True on the frame that crossed a chord change. */
  onChord: boolean;
  /** Stereo image at now, eased: pan −1 left..+1 right, width 0..1; both 0 when unknown. */
  pan: number;
  width: number;
  /** Timbre at now, eased: brightness and noisiness 0..1; 0.5 when unknown. */
  brightness: number;
  noisiness: number;
  /** 0..1, eased toward 1 inside a measured silence. */
  quiet: number;
  /** The same readings eased over a second or more: for anything that
   *  INTEGRATES (a wave's speed, a ring's spin, the tide's height), so the
   *  motion's pace never jitters with the beat. */
  slowBands: Float32Array;
  slowLoud: number;
  /** True when the numbers come from the file; false while a scene drifts on its own. */
  real: boolean;
  /** Normalized loudness at an absolute position, raw (unsmoothed). Drifts when unknown. */
  loudAt(secs: number): number;
  /** THE RECORD: the whole track's strip, normalized per register, for the
   *  scenes that build a world from it (a map, a tunnel). Null without a
   *  strip. The same object identity while the track is the same, so a
   *  scene can upload it once. */
  record: SceneRecord | null;
  lyric: SceneLyric | null;
  title: string | null;
  subtitle: string | null;
  palette: ScenePalette;
  /** The display font's family stack. */
  font: string;
  reduced: boolean;
  mini: boolean;
}

/** The strip normalized per register: `bands` is frames × 6 (bass first), `loud` frames. */
export interface SceneRecord {
  fps: number;
  frames: number;
  bands: Float32Array;
  loud: Float32Array;
}

/** A scene's declared settings, resolved over defaults (see ../useSceneSettings). */
export type SceneSettings = Record<string, SceneSettingValue>;
/** Where a setting applies: everywhere by default, or the fullscreen view only (`full`),
 *  when the tile draws none of what it governs (the words, a sound, a bloom) and so the
 *  tile's picker leaves the control out (the user, 2026-09-12). */
type SceneSettingScope = { full?: boolean };
export type SceneSettingDef = SceneSettingScope &
  (
    | {
        key: string;
        label: string;
        kind: "slider";
        min: number;
        max: number;
        step?: number;
        default: number;
        unit?: string;
      }
    | { key: string; label: string; kind: "toggle"; default: boolean }
    | {
        key: string;
        label: string;
        kind: "select";
        options: { value: string; label: string }[];
        default: string;
      }
  );

/** How to READ a scene: what you see, and what it means (packscape's SceneKey).
 *  Data rather than prose so it renders itself in the picker, and so a pin
 *  can insist every scene has one. `honesty` says where the scene
 *  approximates, out loud. */
export interface SceneKey {
  reads: readonly { shows: string; means: string }[];
  honesty?: readonly string[];
}

export interface Scene {
  kind?: "2d";
  settings?: SceneSettings;
  draw(ctx: CanvasRenderingContext2D, f: SceneFrame): void;
}

/** A scene drawn through three.js: it owns its Scene and Camera and renders
 *  itself each frame; the overlay draws text above. */
export interface ThreeScene {
  kind: "three";
  settings?: SceneSettings;
  init(renderer: THREE.WebGLRenderer, w: number, h: number): void;
  resize?(w: number, h: number): void;
  draw(renderer: THREE.WebGLRenderer, f: SceneFrame): void;
  overlay?(ctx: CanvasRenderingContext2D, f: SceneFrame): void;
  dispose(): void;
}

/** A scene that is a fragment shader: init compiles, draw sets uniforms and
 *  paints the quad, overlay draws text and marks on the 2D canvas above. */
export interface GlScene {
  kind: "gl";
  settings?: SceneSettings;
  init(gl: WebGL2RenderingContext): boolean;
  draw(gl: WebGL2RenderingContext, f: SceneFrame): void;
  overlay?(ctx: CanvasRenderingContext2D, f: SceneFrame): void;
  dispose(gl: WebGL2RenderingContext): void;
}

export type AnyScene = Scene | GlScene | ThreeScene;
export const isGlScene = (s: AnyScene): s is GlScene => s.kind === "gl";
export const isThreeScene = (s: AnyScene): s is ThreeScene => s.kind === "three";

export type SceneId = Exclude<DisplayScene, "sleeve" | "shuffle">;
