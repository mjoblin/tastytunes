import type { Rgb } from "./types";

export const TAU = Math.PI * 2;
export const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t), 3);
export const easeInCubic = (t: number): number => Math.pow(clamp(t), 3);

/** Catmull-Rom between four equally spaced samples, t in [0,1] between p1 and p2. */
export const cubic = (p0: number, p1: number, p2: number, p3: number, t: number): number =>
  0.5 *
  (2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

export const rgb = (c: Rgb): string => `rgb(${c[0]},${c[1]},${c[2]})`;
export const rgba = (c: Rgb, a: number): string =>
  `rgba(${c[0]},${c[1]},${c[2]},${clamp(a).toFixed(3)})`;
/** HSL to Rgb, h 0..1 around the wheel, s and l 0..1: for colors that mean a pitch class. */
export const hsl = (h: number, s: number, l: number): Rgb => {
  const k = (n: number): number => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
};
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/** A smooth 0..1 wander: three incommensurate sines. */
export const noise = (t: number, seed = 0): number =>
  0.5 +
  (Math.sin(t * 1.0 + seed) * 0.5 +
    Math.sin(t * 2.3 + seed * 1.7) * 0.3 +
    Math.sin(t * 4.1 - seed) * 0.2) *
    0.5;

/** Deterministic small randoms (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const hashStr = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export const setFont = (
  ctx: CanvasRenderingContext2D,
  weight: number,
  px: number,
  family: string,
): void => {
  ctx.font = `${weight} ${Math.max(1, Math.round(px * 10) / 10)}px ${family}`;
};

/** Word-wrap to a width at the current font. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const wd of words) {
    const probe = line ? `${line} ${wd}` : wd;
    if (line && ctx.measureText(probe).width > maxWidth) {
      lines.push(line);
      line = wd;
    } else line = probe;
  }
  if (line) lines.push(line);
  return lines;
}

/** Shrink the size until the text fits `maxLines` at `maxWidth`. */
export function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  opts: {
    maxWidth: number;
    maxPx: number;
    minPx: number;
    maxLines: number;
    weight: number;
    family: string;
  },
): { px: number; lines: string[]; width: number } {
  let px = opts.maxPx;
  let lines: string[] = [];
  for (;;) {
    setFont(ctx, opts.weight, px, opts.family);
    lines = wrap(ctx, text, opts.maxWidth);
    const widest = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
    if ((lines.length <= opts.maxLines && widest <= opts.maxWidth) || px <= opts.minPx)
      return { px, lines, width: widest };
    px = Math.max(opts.minPx, px * 0.9);
  }
}

export function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "…" : `${text.slice(0, lo).trimEnd()}…`;
}

/** Text along a circle, centered on `centerAngle`, glyphs upright to the tangent. */
export function arcText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  radius: number,
  centerAngle: number,
  maxAngle: number,
): void {
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0);
  const totalAngle = total / radius;
  if (totalAngle > maxAngle) {
    // too long for the arc: shorten instead of shrinking below legibility
    const keep = Math.max(1, Math.floor((text.length * maxAngle) / totalAngle) - 1);
    return arcText(ctx, `${text.slice(0, keep).trimEnd()}…`, cx, cy, radius, centerAngle, maxAngle);
  }
  let acc = 0;
  const start = centerAngle - totalAngle / 2;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const a = start + (acc + widths[i] / 2) / radius;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText(chars[i], -widths[i] / 2, 0);
    ctx.restore();
    acc += widths[i];
  }
}
