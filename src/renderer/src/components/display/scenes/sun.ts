import type { Rgb } from "./types";
import { TAU, mix, noise, rgba } from "./lib";

/**
 * A SUN that is not a flat spot: a soft corona that breathes, nine faint rays whose lengths
 * wander and whose whole set turns slowly, a disc brighter toward one shoulder and darker at
 * the limb with a softened edge, and a slow granulation of three translucent blots drifting
 * inside it. Everything moves slowly and at low contrast, so it is alive without asking for
 * attention. `t` is seconds; `loud` swells the corona; `haze` (the section's weather) spreads
 * the corona further and softens the limb, a sun seen through mist. (lib's noise runs 0..1.)
 */
export function drawSun(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  gold: Rgb,
  t: number,
  loud: number,
  haze = 0,
): void {
  const halo = ctx.createRadialGradient(x, y, r * 0.4, x, y, r * (3 + 3 * loud) * (1 + 0.6 * haze));
  halo.addColorStop(0, rgba(gold, 0.45 + 0.35 * loud));
  halo.addColorStop(0.45, rgba(gold, 0.08 + 0.06 * haze));
  halo.addColorStop(1, rgba(gold, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(x - r * 7, y - r * 7, r * 14, r * 14);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t * 0.02);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU;
    const len = r * (1.7 + 0.9 * noise(t * 0.12 + i * 3.1, i));
    const g = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
    g.addColorStop(0, rgba(gold, 0.13));
    g.addColorStop(1, rgba(gold, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, len, a - 0.1, a + 0.1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  const white: Rgb = [255, 255, 255];
  const disc = ctx.createRadialGradient(x - r * 0.25, y - r * 0.25, 0, x, y, r);
  disc.addColorStop(0, rgba(mix(gold, white, 0.35), 1));
  disc.addColorStop(0.7, rgba(gold, 1));
  disc.addColorStop(0.92 - 0.12 * haze, rgba(mix(gold, [0, 0, 0], 0.18), 0.95));
  disc.addColorStop(1, rgba(gold, 0));
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.03, 0, TAU);
  ctx.fill();
  for (let i = 0; i < 3; i++) {
    const bx = x + r * 0.9 * (noise(t * 0.07 + i * 5, 11 + i) - 0.5);
    const by = y + r * 0.9 * (noise(t * 0.06 + i * 7, 23 + i) - 0.5);
    const b = ctx.createRadialGradient(bx, by, 0, bx, by, r * 0.5);
    b.addColorStop(0, rgba(white, 0.12));
    b.addColorStop(1, rgba(white, 0));
    ctx.fillStyle = b;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
}
