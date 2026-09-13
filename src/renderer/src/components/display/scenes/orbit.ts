import type { Scene, SceneFrame } from "./types";
import { easeTowards } from "../clock";
import { PresenceTracker } from "../presence";
import { typePx } from "../type";
import { TAU, arcText, fitText, hsl, mix, rgb, rgba, setFont } from "./lib";

/**
 * ORBIT. Six rings, one per band, breathing with their energy; a comet rides
 * the outermost at the track's true position, its tail the recent past. The
 * current line runs along the middle ring; the next waits, faint, below.
 */
export class Orbit implements Scene {
  private rot = new Float64Array(6);
  /** A drum's jump, one per ring pair (kicks inside, snares the middle, hats outside), decaying. */
  private punch = new Float64Array(3);
  /** Where each ring's jump is heading: a drum sets it, it decays, `punch` follows with a rise. */
  private punchAim = new Float64Array(3);
  /** The comet's flare on a beat, decaying. */
  private cometPulse = 0;
  /** The arc's lines arrive over half a second and leave over most of one: a crossfade, not a swap. */
  private arc = new PresenceTracker(500, 900);

  draw(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P } = f;
    const m = Math.min(w, h);
    const cx = w / 2;
    const cy = h * 0.47;
    const speed = f.reduced ? 0.3 : 1;

    ctx.fillStyle = rgb(P.bg);
    ctx.fillRect(0, 0, w, h);
    // the core's color is the harmony's root on a color wheel, half-mixed with the art
    let root = -1;
    for (let p = 0; p < 12; p++)
      if (f.chroma[p] > 0.6 && (root < 0 || f.chroma[p] > f.chroma[root])) root = p;
    const coreColor = root >= 0 ? mix(P.accent[0], hsl(root / 12, 0.65, 0.55), 0.5) : P.accent[0];
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, m * 0.16 * (0.6 + f.loud));
    core.addColorStop(0, rgba(coreColor, 0.35 + 0.3 * f.loud));
    core.addColorStop(1, rgba(coreColor, 0));
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, w, h);

    // a drum jumps its pair of rings
    for (let g = 0; g < 3; g++) this.punchAim[g] = easeTowards(this.punchAim[g], 0, f.dt, 0.16);
    if (f.hitsKnown)
      for (const hit of f.hits) {
        const g = hit.type === "kick" ? 0 : hit.type === "snare" ? 1 : 2;
        this.punchAim[g] = Math.max(this.punchAim[g], hit.strength);
      }
    // a chord change lifts every ring a little; a drop's release, all the way
    if (f.onChord) for (let g = 0; g < 3; g++) this.punchAim[g] = Math.max(this.punchAim[g], 0.35);
    if (f.drop?.onDrop) this.punchAim.fill(1);
    // the ring moves to its jump over sixty milliseconds rather than teleporting (the pop)
    for (let g = 0; g < 3; g++)
      this.punch[g] = easeTowards(this.punch[g], this.punchAim[g], f.dt, 0.06);
    // the comet flares on the beat, more on the downbeat
    this.cometPulse = easeTowards(this.cometPulse, 0, f.dt, 0.12);
    if (f.beat?.onBeat) this.cometPulse = Math.max(this.cometPulse, f.beat.onBar ? 1 : 0.55);
    const radii: number[] = [];
    for (let i = 0; i < 6; i++) {
      const R = m * (0.075 + 0.046 * i);
      const e = 0.6 * f.bands[i] + 0.4 * f.slowBands[i];
      const r = R * (1 + 0.11 * e + 0.07 * this.punch[i >> 1]);
      radii.push(r);
      this.rot[i] += f.dt * (0.04 + 0.18 * f.slowBands[i]) * (i % 2 ? 1 : -1) * speed;
      const color = i < 2 ? P.accent[0] : i < 4 ? P.accent[1] : P.gold;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(this.rot[i] * 0.25);
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * (0.99 - 0.012 * i), 0, 0, TAU);
      ctx.setLineDash([m * (0.018 + 0.01 * i), m * 0.011]);
      ctx.lineDashOffset = -this.rot[i] * r * 2;
      ctx.strokeStyle = rgba(color, Math.min(1, 0.12 + 0.65 * e + 0.25 * this.punch[i >> 1]));
      ctx.lineWidth = 0.8 + 3.2 * e;
      ctx.stroke();
      ctx.restore();
    }

    // the comet on its own clean circle
    const outer = m * (0.075 + 0.046 * 5) * 1.1;
    const ang = f.duration ? -Math.PI / 2 + TAU * (f.position / f.duration) : f.now / 12000;
    const tail = f.mini ? 14 : 30;
    for (let k = tail; k >= 0; k--) {
      const a = ang - k * 0.03 * (1 + f.loud);
      const q = 1 - k / tail;
      ctx.fillStyle = rgba(P.gold, 0.75 * q * q);
      ctx.beginPath();
      ctx.arc(
        cx + Math.cos(a) * outer,
        cy + Math.sin(a) * outer,
        0.8 + q * (2.6 + 2.4 * f.loud),
        0,
        TAU,
      );
      ctx.fill();
    }
    const hx = cx + Math.cos(ang) * outer;
    const hy = cy + Math.sin(ang) * outer;
    const hg = ctx.createRadialGradient(
      hx,
      hy,
      0,
      hx,
      hy,
      (14 + 18 * f.loud) * (1 + 0.7 * this.cometPulse),
    );
    hg.addColorStop(0, rgba(P.gold, 0.7));
    hg.addColorStop(1, rgba(P.gold, 0));
    ctx.fillStyle = hg;
    ctx.fillRect(hx - 40, hy - 40, 80, 80);

    if (f.lyric) {
      const { next, index, lines, text } = f.lyric;
      const pres = this.arc.step(text ? [String(index)] : [], f.dt);
      const bodyPx = typePx(f, "body");
      ctx.textBaseline = "middle";
      for (const key of pres.keys()) {
        const ln = lines[Number(key)]?.text;
        if (!ln) continue;
        // a long line shrinks to fit the arc rather than ending in an ellipsis
        let px = bodyPx;
        for (;;) {
          setFont(ctx, 500, px, f.font);
          if (
            ctx.measureText(ln).width / (radii[3] + px * 0.9) <= Math.PI * 1.35 ||
            px <= bodyPx * 0.55
          )
            break;
          px *= 0.92;
        }
        ctx.fillStyle = rgba(P.gold, this.arc.get(key));
        arcText(ctx, ln, cx, cy, radii[3] + px * 0.9, -Math.PI / 2, Math.PI * 1.35);
      }
      if (next) {
        const cpx = typePx(f, "caption");
        const fit = fitText(ctx, next, {
          maxWidth: w * 0.7,
          maxPx: cpx,
          minPx: cpx * 0.75,
          maxLines: 2,
          weight: 400,
          family: f.font,
        });
        ctx.fillStyle = rgba(P.dim, 0.55);
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        const ny = Math.min(
          cy + outer + cpx * 1.7,
          h * 0.87 - (fit.lines.length - 1) * fit.px * 1.2,
        );
        fit.lines.forEach((l, k) => ctx.fillText(l, cx, ny + k * fit.px * 1.2));
        ctx.textAlign = "start";
      }
    }
  }
}
