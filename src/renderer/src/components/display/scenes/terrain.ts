import type { Scene, SceneFrame } from "./types";
import { easeTowards } from "../clock";
import { PresenceTracker } from "../presence";
import { typePx } from "../type";
import { clamp, mix, noise, rgb, rgba, rng, setFont, wrap } from "./lib";
import { WeatherState } from "./weather";

/**
 * TERRAIN. A slow flyover of a ridge that is the track's own loudness: the
 * past behind (left), the next minute ahead (right), now a third of the way
 * across, lit from behind the far ridge by a glow whose reach is the current
 * loudness (it was a sun in the sky: a kids'-book disc, at the user's word).
 * The lines stand as signposts at their times, so you see the words coming
 * before they arrive.
 */
const PAST = 30;
const FUTURE = 60;
/** Rows of signposts above the ground; a fifth line in a crowd shares the least crowded row. */
const SIGN_ROWS = 4;

/** Every line's row and wrapped text for one lyric set at one width. */
interface SignLayout {
  lines: readonly { t: number; text: string }[];
  w: number;
  font: string;
  body: number;
  rows: number[];
  text: string[][];
}

interface Layer {
  win: number;
  base: number;
  amp: number;
  tint: number;
}
const LAYERS: Layer[] = [
  { win: 5, base: 0.66, amp: 0.15, tint: 0.12 },
  { win: 1.8, base: 0.73, amp: 0.22, tint: 0.24 },
  { win: 1.2, base: 0.82, amp: 0.3, tint: 0.4 },
];
/** How much of the haze veils each layer: the farthest most, the near ridge none. */
const HAZE_VEIL = [0.55, 0.28, 0];
/** The stars: fixed places in the upper sky, each with its own size and twinkle. */
const STAR_COUNT = 140;
interface Star {
  x: number;
  y: number;
  size: number;
  seed: number;
}
function makeStars(): Star[] {
  const rand = rng(0x57a5);
  return Array.from({ length: STAR_COUNT }, () => ({
    x: rand(),
    y: rand() * 0.55,
    size: 0.8 + rand() * 1.2,
    seed: rand() * 100,
  }));
}

export class Terrain implements Scene {
  /** The gold hands over: a line arrives over 800 ms and leaves over 1.2 s, so the
   *  highlight glides from one signpost to the next instead of jumping. */
  private current = new PresenceTracker(800, 1200);
  private layout: SignLayout | null = null;
  /** A kick's flash of the glow, decaying. */
  private glowPulse = 0;
  /** The section's weather (scenes/weather), eased. */
  private weather = new WeatherState();
  private stars = makeStars();

  draw(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P } = f;
    const nowX = w * 0.36;
    const secsPerPx = (PAST + FUTURE) / w;
    const timeAt = (x: number): number => f.position + (x - nowX) * secsPerPx;
    const xOf = (secs: number): number => nowX + (secs - f.position) / secsPerPx;
    // the window sampled once at 10 Hz, each layer a box average over its
    // own span (prefix sums): the 10 fps strip's beat-comb smooths out
    // the grid is anchored to TRACK time (not to the frame), so the averaged
    // ridge is the same shape from frame to frame and slides rather than shimmers
    const STEP = 0.1;
    const t0 = Math.floor((f.position - PAST) / STEP) * STEP;
    const count = Math.ceil((PAST + FUTURE) / STEP) + 3;
    const prefix = new Float32Array(count + 1);
    for (let i = 0; i < count; i++) {
      const secs = t0 + i * STEP;
      // before the track began the ground ramps down over two seconds, not a wall
      prefix[i + 1] = prefix[i] + (secs < 0 ? f.loudAt(0) * clamp(1 + secs / 2) : f.loudAt(secs));
    }
    const boxAt = (ci: number, r: number): number => {
      const a = Math.max(0, Math.min(count, ci - r));
      const b = Math.max(0, Math.min(count, ci + r + 1));
      return b > a ? (prefix[b] - prefix[a]) / (b - a) : 0;
    };
    const heightAt = (secs: number, win: number): number => {
      const c = (secs - t0) / STEP;
      const ci = Math.floor(c);
      const r = Math.max(1, Math.round(win / STEP / 2));
      const t = c - ci;
      return boxAt(ci, r) * (1 - t) + boxAt(ci + 1, r) * t;
    };

    // the sky, lit by the loudness and wearing the section's weather (scenes/weather, the
    // second agent's): a chorus warms it toward gold and brightens it, a quiet passage lets
    // the stars through and lays mist over the far ranges
    const W = this.weather.step(f);
    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.8);
    sky.addColorStop(0, rgb(P.bg));
    sky.addColorStop(
      1,
      rgba(
        mix(P.accent[0], P.gold, W.warm * 0.7),
        (0.12 + 0.26 * f.slowLoud) * (0.6 + 0.8 * W.glow),
      ),
    );
    ctx.fillStyle = rgb(P.bg);
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h * 0.8);
    // the stars, on the faceplate only: their number is the weather's, each twinkling slowly
    if (!P.light && W.stars > 0.02) {
      const t = f.now / 1000;
      for (const st of this.stars) {
        const tw = 0.35 + 0.65 * noise(t * 0.6 + st.seed, st.seed);
        ctx.fillStyle = rgba(P.ink, W.stars * tw * 0.7);
        ctx.fillRect(st.x * w, st.y * h, st.size, st.size);
      }
    }
    // the sections: bands across the sky, warmer where the chorus is, a hairline at each edge
    for (let i = 0; i < f.sections.length; i++) {
      const sec = f.sections[i];
      const x0 = Math.max(0, xOf(sec.start));
      const x1 = Math.min(w, xOf(sec.end));
      if (x1 <= 0 || x0 >= w) continue;
      ctx.fillStyle =
        sec.kind === "chorus"
          ? rgba(P.gold, 0.035 + 0.03 * sec.energy)
          : rgba(P.ink, (i % 2) * 0.018);
      ctx.fillRect(x0, 0, x1 - x0, h * 0.8);
      if (i > 0 && x0 > 0) {
        ctx.fillStyle = rgba(P.ink, 0.12);
        ctx.fillRect(x0, 0, 1, h * 0.8);
      }
    }

    // THE LIGHT BEHIND THE RIDGE, at now. The source sits just below the far crest, so the sky
    // glows from behind the land and the ridges stand against it. Its reach is the loudness
    // (height stays loudness, at the user's word); a kick flashes it and a drop flares it
    this.glowPulse = easeTowards(this.glowPulse, 0, f.dt, 0.15);
    if (f.hitsKnown)
      for (const hit of f.hits)
        if (hit.type === "kick") this.glowPulse = Math.max(this.glowPulse, hit.strength);
    if (f.drop?.onDrop) this.glowPulse = Math.max(this.glowPulse, 1.4);
    const pulse = Math.min(1, this.glowPulse);
    const farCrest = h * LAYERS[0].base - heightAt(f.position, LAYERS[0].win) * h * LAYERS[0].amp;
    // the source sits a little under the crest (the user: "drop the light a bit lower, so its
    // impact is a bit more subtle"): the ridge hides most of the core and the sky takes the rest
    const srcY = farCrest + h * 0.035;
    // through mist the light spreads further and thinner
    const reach = h * (0.24 + 0.3 * f.slowLoud) * (1 + 0.25 * this.glowPulse) * (1 + 0.5 * W.haze);
    const glowA = (P.light ? 0.55 : 1) * (0.5 + 0.3 * f.loud + 0.3 * pulse) * (1 - 0.3 * W.haze);
    const hot = P.light ? mix(P.gold, [255, 255, 255], 0.3) : mix(P.gold, P.ink, 0.5);
    ctx.save();
    ctx.translate(nowX, srcY);
    ctx.scale(1.7, 1);
    const wide = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
    wide.addColorStop(0, rgba(P.gold, glowA * 0.7));
    wide.addColorStop(0.35, rgba(P.gold, glowA * 0.25));
    wide.addColorStop(1, rgba(P.gold, 0));
    ctx.fillStyle = wide;
    ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
    ctx.restore();
    // the hot core at the crest, where the source is nearest the horizon
    const coreR = h * (0.08 + 0.04 * f.loud) * (1 + 0.3 * this.glowPulse) * (1 + 0.6 * W.haze);
    const core = ctx.createRadialGradient(nowX, srcY, 0, nowX, srcY, coreR);
    core.addColorStop(0, rgba(hot, glowA * 0.9));
    core.addColorStop(0.5, rgba(P.gold, glowA * 0.45));
    core.addColorStop(1, rgba(P.gold, 0));
    ctx.fillStyle = core;
    ctx.fillRect(nowX - coreR, srcY - coreR, coreR * 2, coreR * 2);

    // the ridges, far to near; each crest catches the light nearest the source
    const nearTop = new Float32Array(Math.ceil(w / 3) + 2);
    const top = new Float32Array(nearTop.length);
    const span = w * 0.22 * (1 + 0.4 * f.slowLoud);
    let cols = 0;
    LAYERS.forEach((L, li) => {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0, i = 0; x <= w + 3; x += 3, i++) {
        const secs = timeAt(x);
        const v = heightAt(secs, L.win);
        const y = h * L.base - v * h * L.amp - noise(x * 0.004 + li, li * 3) * h * 0.012;
        top[i] = y;
        if (li === LAYERS.length - 1) nearTop[i] = y;
        cols = i + 1;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w + 3, h);
      ctx.closePath();
      const body = mix(mix(P.bg, P.ink, L.tint), P.accent[1], 0.3 - li * 0.06);
      const g = ctx.createLinearGradient(0, h * (L.base - L.amp), 0, h);
      g.addColorStop(0, rgb(body));
      g.addColorStop(1, rgb(mix(body, P.bg, 0.55)));
      ctx.fillStyle = g;
      ctx.fill();
      // the haze: the weather's mist veils the far ranges (the path is still current)
      if (W.haze > 0.01 && HAZE_VEIL[li] > 0) {
        ctx.fillStyle = rgba(P.bg, W.haze * HAZE_VEIL[li]);
        ctx.fill();
      }
      // the crest line alone (stroking the filled shape drew its walls at both edges), lit
      // gold where it is nearest the source behind it and fading either way; the near ridge
      // keeps a faint line all along, as before. Stroked before the next layer covers it
      const rim = ctx.createLinearGradient(nowX - span, 0, nowX + span, 0);
      const along = li === LAYERS.length - 1 ? 0.12 + 0.25 * f.loud : 0;
      const peak = [1, 0.6, 0.45][li] * (0.4 + 0.4 * f.loud + 0.4 * pulse);
      rim.addColorStop(0, rgba(P.gold, along));
      rim.addColorStop(0.5, rgba(li === 0 ? hot : P.gold, Math.min(1, along + peak)));
      rim.addColorStop(1, rgba(P.gold, along));
      ctx.beginPath();
      for (let i = 0; i < cols; i++) {
        if (i === 0) ctx.moveTo(0, top[0]);
        else ctx.lineTo(i * 3, top[i]);
      }
      ctx.strokeStyle = rim;
      ctx.lineWidth = li === 0 ? 1.5 : 1;
      ctx.stroke();
    });
    const ridgeAt = (x: number): number =>
      nearTop[clamp(Math.round(x / 3), 0, Math.max(0, cols - 1))];

    // NOW: a gold hairline from the crest to the ground, and a lit notch on the crest, so the
    // past/future split stays exact however wide and soft the glow behind it gets
    const crestY = ridgeAt(nowX);
    ctx.strokeStyle = rgba(P.gold, 0.28);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(nowX, crestY + 4);
    ctx.lineTo(nowX, h * 0.96);
    ctx.stroke();
    ctx.fillStyle = rgba(hot, 0.85);
    ctx.fillRect(nowX - 1.5, crestY - 6, 3, 10);

    // the signposts
    if (f.lyric) {
      const { lines, index } = f.lyric;
      const lo = f.position - PAST;
      const hi = f.position + FUTURE;
      ctx.textBaseline = "alphabetic";
      const nowKeys = index >= 0 && lines[index].text ? [String(index)] : [];
      const pres = this.current.step(nowKeys, f.dt);
      const small = typePx(f, "small");
      const body = typePx(f, "body");
      const lay = this.layoutFor(ctx, lines, w, f.font, body, secsPerPx);
      const pitch = body * 2.5;
      const draw = (i: number): void => {
        const ln = lines[i];
        const row = lay.rows[i];
        if (row < 0) return;
        const x = xOf(ln.t);
        const g = this.current.get(String(i));
        const d = ln.t - f.position;
        // while a line is the one being heard its approach values hold at their peak (as if it
        // were still arriving), so the gold ramp takes over from where the approach left off.
        // Gated on the future alone they fell to nothing the instant the line began, and the
        // sign shrank and paled for most of a second before growing back (the user's word)
        const isNow = i === index;
        const dEff = isNow ? 0 : d;
        const ahead = isNow || d > 0;
        const nearness = ahead ? clamp(1 - dEff / FUTURE) : 0;
        // a line fades in at the horizon, brightens as it nears, dims once it is past
        const enter = clamp((FUTURE - dEff) / 6);
        const base = ahead ? (0.1 + 0.26 * nearness) * enter : 0.2 * clamp(1 + d / PAST);
        const alpha = base + (1 - base) * g;
        // an upcoming line grows and warms toward gold as it nears now; its row and its
        // wrapping never change (layoutFor), so all that moves is the land under it
        // upcoming lines stay small and quiet until their last six seconds
        const near6 = ahead ? clamp(1 - dEff / 6) : 0;
        const rest = small * 0.9;
        const px = rest + (body - rest) * Math.max(g, 0.5 * near6 * near6);
        setFont(ctx, g > 0.5 ? 500 : 400, px, f.font);
        // the signpost stands on the GROUND at its time (a wide average), never on the
        // ridge under it, whose beat bumps had the words bobbing as the land slid by
        const ground = h * LAYERS[2].base - heightAt(ln.t, 4) * h * LAYERS[2].amp;
        const y = ground - h * 0.1 - row * pitch - g * h * 0.03;
        const color = mix(mix(P.ink, P.gold, 0.5 * nearness), P.gold, g);
        ctx.fillStyle = rgba(color, alpha);
        lay.text[i].forEach((l, k) => ctx.fillText(l, x + 6, y + k * px * 1.15));
        ctx.strokeStyle = rgba(color, alpha * 0.5);
        ctx.beginPath();
        ctx.moveTo(x, y + 4);
        ctx.lineTo(x, ridgeAt(x));
        ctx.stroke();
      };
      const drawn = new Set<number>();
      for (const key of pres.keys()) {
        const i = Number(key);
        if (lines[i]?.text) {
          draw(i);
          drawn.add(i);
        }
      }
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (drawn.has(i) || !ln.text || ln.t < lo || ln.t > hi) continue;
        draw(i);
      }
    }
  }

  /** Every line's row and wrapped text, decided ONCE per lyric set and width. A row chosen
   *  frame by frame from whatever happened to fit moved the words between rows as their
   *  neighbours grew, and hid the ones that fit nowhere, so signposts popped as the land
   *  slid by. A row is reserved at the full (body) width a line reaches when it is heard,
   *  so growing into gold never runs into a neighbour; when every row is taken the least
   *  crowded one takes the line rather than dropping it. */
  private layoutFor(
    ctx: CanvasRenderingContext2D,
    lines: readonly { t: number; text: string }[],
    w: number,
    font: string,
    body: number,
    secsPerPx: number,
  ): SignLayout {
    const c = this.layout;
    if (c && c.lines === lines && c.w === w && c.font === font && c.body === body) return c;
    setFont(ctx, 500, body, font);
    const rows: number[] = [];
    const text: string[][] = [];
    const rowEnd: number[] = [];
    for (const ln of lines) {
      if (!ln.text) {
        rows.push(-1);
        text.push([]);
        continue;
      }
      const shown = wrap(ctx, ln.text, w * 0.26).slice(0, 2);
      const width = shown.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
      let row = rowEnd.findIndex((end) => end <= ln.t);
      if (row < 0)
        row = rowEnd.length < SIGN_ROWS ? rowEnd.length : rowEnd.indexOf(Math.min(...rowEnd));
      rows.push(row);
      text.push(shown);
      rowEnd[row] = Math.max(rowEnd[row] ?? -Infinity, ln.t + (width + 16) * secsPerPx);
    }
    this.layout = { lines, w, font, body, rows, text };
    return this.layout;
  }
}
