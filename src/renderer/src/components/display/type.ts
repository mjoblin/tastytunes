import type { SceneFrame } from "./scenes/types";

/**
 * TYPE for scenes that draw their own text (after packscape's stage/type).
 * A canvas has no stylesheet, so every scene was picking its own fractions
 * of the height; these are the one scale, named the way the chrome names
 * its sizes, so a "body" line reads the same size in every scene. Sizes
 * are fractions of the stage height (the picker's tiles scale with it); the
 * pixel ratio is the canvas transform's business, never the font's.
 */
export const TYPE_SCALE = {
  /** The line alone, large (Type). */
  display: 0.11,
  /** A headline over a picture. */
  title: 0.075,
  /** A lyric riding the picture (Tide). */
  lead: 0.046,
  /** A line among other things (Orbit's arc, Terrain's current signpost). */
  body: 0.032,
  /** The next line waiting. */
  caption: 0.024,
  /** Signposts in the distance. */
  small: 0.018,
} as const;
export type TypeSize = keyof typeof TYPE_SCALE;

export const typePx = (f: Pick<SceneFrame, "h">, size: TypeSize): number =>
  Math.max(8, f.h * TYPE_SCALE[size]);

let monoStack: string | null = null;
/** The app's own mono stack, read once off :root. */
export function monoFont(): string {
  if (monoStack == null) {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
    monoStack = v || "ui-monospace, SFMono-Regular, Menlo, monospace";
  }
  return monoStack;
}

/** Set the context's font at a scale size (or an explicit px); returns the px used. */
export function sceneFont(
  ctx: CanvasRenderingContext2D,
  f: SceneFrame,
  size: TypeSize | number,
  weight = 400,
  opts: { mono?: boolean } = {},
): number {
  const px = typeof size === "number" ? size : typePx(f, size);
  const family = opts.mono ? monoFont() : f.font;
  ctx.font = `${weight} ${Math.max(1, Math.round(px * 10) / 10)}px ${family}`;
  return px;
}
