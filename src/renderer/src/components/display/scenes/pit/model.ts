import type { SceneHit } from "../types";

/**
 * The Pit's decisions, with no canvas in them. A drum throws a ball: its size
 * is how hard, its color and side the drum (a kick is bass, from the left; a
 * hat is air, from the right; a snare the middle, from either side). The pile
 * is the last minute of beats; a quiet bridge lets it slump away. A ball says
 * nothing about pitch, and where it rolls means nothing; the key says so.
 * Without an onset list (radio, an older analysis) the strip's transient
 * throws instead, colored by the loudest register.
 */
export const HIT_ONSET = 0.3;
/** A ball per drum: the register a drum type wears (bass, the middle, air). */
export function registerForDrum(type: SceneHit["type"], unit: number): number {
  if (type === "kick") return 0;
  if (type === "hat") return 5;
  return unit < 0.5 ? 2 : 3;
}
/** Radius from the drum: a kick is the boulder, a hat the marble, strength grows each. */
export function radiusForDrum(type: SceneHit["type"], strength: number): number {
  const s = Math.sqrt(Math.min(1, Math.max(0, strength)));
  if (type === "kick") return 8 + 7 * s;
  if (type === "hat") return 3.5 + 2.5 * s;
  return 5.5 + 5 * s;
}
/** Two throws cannot land closer together than this. */
export const THROW_GAP_MS = 90;

/** Radius from the hit: a soft hit is a marble, a slam a boulder. */
export function radiusForHit(onset: number, loud: number): number {
  const k = Math.min(1, Math.max(0, 0.55 * onset + 0.45 * loud));
  return 4 + 9 * Math.sqrt(k);
}

/** The register that carried the hit: the loudest band this frame. */
export function registerOf(bands: ArrayLike<number>): number {
  let top = 0;
  for (let i = 1; i < bands.length; i++) if (bands[i] > bands[top]) top = i;
  return top;
}

/** Which side a register enters from: 0 = left, 1 = right; the middle registers scatter across. */
export function sideOf(register: number, unit: number): "left" | "right" {
  if (register <= 1) return "left";
  if (register >= 4) return "right";
  return unit < 0.5 ? "left" : "right";
}
