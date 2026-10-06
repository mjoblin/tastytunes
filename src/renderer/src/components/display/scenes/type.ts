import type { Scene, SceneFrame, SceneSettings } from "./types";
import { easeTowards } from "../clock";
import { typePx } from "../type";
import { clamp, easeOutCubic, fitText, hashStr, rgb, rgba, setFont } from "./lib";

/**
 * TYPE. The line alone, large, in the display face. Words arrive one after
 * another when a line begins and fall away when it ends; the bass swells
 * them a little, the air makes them tremble. A hairline under the words is
 * the line's own progress. Without lyrics the title stands in, the artist
 * beneath it, and the transients still move the type.
 */
const ARRIVE = 0.55;
const STAGGER = 0.05;
const FALL = 0.7;

interface Laid {
  px: number;
  lines: string[];
  width: number;
}

export class Type implements Scene {
  settings: SceneSettings = {};
  private shown = "";
  private prev = "";
  private since = 0;
  private laidFor = "";
  private laid: Laid | null = null;
  private laidW = 0;
  /** A kick's punch on the words, decaying. */
  private punch = 0;
  /** Where the punch is heading; `punch` follows it with a rise so the words swell, not jump. */
  private punchAim = 0;

  private layout(ctx: CanvasRenderingContext2D, f: SceneFrame, text: string): Laid {
    if (this.laid && this.laidFor === text && this.laidW === f.w) return this.laid;
    const laid = fitText(ctx, text, {
      maxWidth: f.w * 0.8,
      maxPx: typePx(f, "display") * (f.lyric ? 1 : 0.9),
      minPx: typePx(f, "body") * 1.1,
      maxLines: 3,
      weight: 600,
      family: f.font,
    });
    this.laid = laid;
    this.laidFor = text;
    this.laidW = f.w;
    return laid;
  }

  draw(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P } = f;
    const text = f.lyric ? f.lyric.text : (f.title ?? "");
    if (text !== this.shown) {
      this.prev = this.shown;
      this.shown = text;
      this.since = f.now;
    }
    const age = (f.now - this.since) / 1000;
    const highs = (f.bands[4] + f.bands[5]) / 2;
    const bass = f.bands[0];
    this.punchAim = easeTowards(this.punchAim, 0, f.dt, 0.12);
    if (f.hitsKnown)
      for (const hit of f.hits)
        if (hit.type === "kick") this.punchAim = Math.max(this.punchAim, hit.strength);
    if (f.drop?.onDrop) this.punchAim = Math.max(this.punchAim, 1.5);
    this.punch = easeTowards(this.punch, this.punchAim, f.dt, 0.06);

    ctx.fillStyle = rgb(P.bg);
    ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.55);
    glow.addColorStop(0, rgba(P.accent[0], 0.05 + 0.14 * f.loud));
    glow.addColorStop(1, rgba(P.accent[0], 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    ctx.textBaseline = "alphabetic";
    // the last line falls away
    if (this.prev && age < FALL) {
      const k = clamp(age / FALL);
      const laid = fitText(ctx, this.prev, {
        maxWidth: w * 0.8,
        maxPx: typePx(f, "display"),
        minPx: typePx(f, "body") * 1.1,
        maxLines: 3,
        weight: 600,
        family: f.font,
      });
      const lineH = laid.px * 1.12;
      const y0 = h * 0.5 - ((laid.lines.length - 1) * lineH) / 2 + laid.px * 0.35;
      ctx.fillStyle = rgba(P.ink, (1 - k) * 0.8);
      ctx.textAlign = "center";
      laid.lines.forEach((ln, i) => ctx.fillText(ln, w / 2, y0 + i * lineH + k * k * h * 0.14));
      ctx.textAlign = "start";
    }

    if (text) {
      const laid = this.layout(ctx, f, text);
      setFont(ctx, 600, laid.px, f.font);
      const lineH = laid.px * 1.12;
      const y0 = h * 0.5 - ((laid.lines.length - 1) * lineH) / 2 + laid.px * 0.35;
      let k = 0;
      const space = ctx.measureText(" ").width;
      laid.lines.forEach((ln, li) => {
        const words = ln.split(" ");
        const widths = words.map((wd) => ctx.measureText(wd).width);
        const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
        let x = (w - total) / 2;
        const y = y0 + li * lineH;
        words.forEach((wd, wi) => {
          const arrive = f.reduced ? 1 : easeOutCubic((age - k * STAGGER) / ARRIVE);
          const seed = hashStr(wd + k) / 4294967296;
          // the Motion switch (in-mode) holds the words still: no swell with the bass, no
          // punch on a kick, no tremble in the air; they still arrive and the hairline still runs
          const still = this.settings.motion === false;
          const pulse = still ? 1 : 1 + 0.035 * bass * (0.4 + 0.6 * seed) + 0.03 * this.punch;
          const tremble =
            still || f.reduced ? 0 : highs * 2.2 * (h / 800) * Math.sin(f.now / 900 + seed * 40);
          ctx.save();
          ctx.translate(x + widths[wi] / 2 + tremble, y - (1 - arrive) * h * 0.035);
          ctx.scale(pulse, pulse);
          ctx.fillStyle = rgba(P.ink, arrive);
          ctx.fillText(wd, -widths[wi] / 2, 0);
          ctx.restore();
          x += widths[wi] + space;
          k++;
        });
      });
      // the line's own progress, or the artist under a title
      const under = y0 + (laid.lines.length - 1) * lineH + laid.px * 0.45;
      if (f.lyric) {
        const pw = laid.width * f.lyric.progress;
        ctx.fillStyle = rgba(P.gold, 0.7);
        ctx.fillRect((w - laid.width) / 2, under, pw, Math.max(1, h * 0.002));
      } else if (f.subtitle) {
        setFont(ctx, 400, laid.px * 0.42, f.font);
        ctx.fillStyle = rgba(P.dim, clamp(age / ARRIVE));
        ctx.textAlign = "center";
        ctx.fillText(f.subtitle, w / 2, under + laid.px * 0.5);
        ctx.textAlign = "start";
      }
    } else if (f.lyric?.next) {
      // an intro or a gap: the next line waits, small and faint
      const px = typePx(f, "body");
      setFont(ctx, 400, px, f.font);
      ctx.fillStyle = rgba(P.dim, 0.3 + 0.4 * f.lyric.progress);
      ctx.textAlign = "center";
      ctx.fillText(f.lyric.next, w / 2, h * 0.5);
      ctx.textAlign = "start";
    }
  }
}
