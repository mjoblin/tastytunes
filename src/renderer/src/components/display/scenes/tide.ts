import type { Scene, SceneFrame } from "./types";
import { easeTowards } from "../clock";
import { typePx } from "../type";
import {
  clamp,
  easeInCubic,
  easeOutCubic,
  fitText,
  lerp,
  mix,
  noise,
  rgb,
  rgba,
  rng,
  setFont,
  smoothstep,
} from "./lib";

/**
 * TIDE. A waterline the bass swells and the highs break into spray; the
 * loudness to come approaches from the right as a faint contour (now is the
 * middle of the screen). The current line rides the surface, glyph by glyph,
 * and sinks as its time runs out; the next line waits under the water and
 * rises to meet it. At night (after the Sea, at the user's word): stars that
 * thin toward the horizon, a moon low and a little right whose halo flares
 * on a drop, a glade of broken shimmer down the water that a hat sets
 * glinting, the crests lit by a snare, the far water dissolving into the sky.
 */
interface Glint {
  x: number;
  y: number;
  age: number;
  life: number;
}
interface Star {
  x: number;
  y: number;
  size: number;
  seed: number;
}
/** Fixed stars, more of them high in the sky, each with its own twinkle. */
function makeStars(): Star[] {
  const rand = rng(0x71de);
  return Array.from({ length: 110 }, () => ({
    x: rand(),
    y: rand() * rand(),
    size: 0.8 + rand() * 1.2,
    seed: rand() * 100,
  }));
}
interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
}

export class Tide implements Scene {
  private phase = 0;
  private spray: Drop[] = [];
  private lastSpray = 0;
  private prevHighs = 0;
  /** A kick's heave of the swell, decaying. */
  private surge = 0;
  /** Where the surge is heading: a kick sets it, it decays, `surge` follows with a rise time. */
  private surgeAim = 0;
  /** The night: the moon's halo (a drop), the glade's glint (a hat), the crests' light (a snare). */
  private halo = 0;
  private glint = 0;
  private crest = 0;
  private crestAim = 0;
  private glints: Glint[] = [];
  private stars = makeStars();
  private lineIndex = -2;
  private emergeAt = 0;
  private nextIndex = -2;
  private nextSince = 0;

  draw(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P } = f;
    const speed = f.reduced ? 0.35 : 1;
    const bass = f.bands[0] * 0.7 + f.bands[1] * 0.3;
    const slowBass = f.slowBands[0] * 0.7 + f.slowBands[1] * 0.3;
    const highs = (f.bands[4] + f.bands[5]) / 2;
    // the waves' pace and the tide's height follow the slow readings: the
    // amplitude may breathe with the beat, the motion itself never jerks
    this.phase += f.dt * (0.55 + 0.9 * slowBass) * speed;
    const baseY = h * 0.66 - h * 0.06 * f.slowLoud;
    // a kick heaves the swell with a rise time: set directly, the whole waterline jumped on
    // every kick (the Sea popped the same way, the user's word)
    this.surgeAim = easeTowards(this.surgeAim, 0, f.dt, 0.3);
    this.surge = easeTowards(this.surge, this.surgeAim, f.dt, 0.14);
    const amp = h * (0.01 + 0.055 * (0.5 * bass + 0.5 * slowBass) + 0.012 * this.surge);
    const surface = (x: number, k = 0): number =>
      baseY +
      amp * Math.sin((x / w) * 6.3 + this.phase * 1.3 + k) +
      amp * 0.5 * Math.sin((x / w) * 13.7 - this.phase * 0.9 + k * 2) +
      h * 0.004 * highs * Math.sin((x / w) * 61 + this.phase * 7 + k);

    ctx.fillStyle = rgb(P.bg);
    ctx.fillRect(0, 0, w, h);

    // the sky: a glow on the horizon in the art's first color
    const sky = ctx.createLinearGradient(0, baseY - h * 0.4, 0, baseY);
    sky.addColorStop(0, rgba(P.accent[0], 0));
    sky.addColorStop(1, rgba(P.accent[0], 0.07 + 0.16 * f.loud));
    ctx.fillStyle = sky;
    ctx.fillRect(0, baseY - h * 0.4, w, h * 0.4);

    // NIGHT. Stars on the faceplate only, thinning toward the horizon; a moon low and a little
    // right (the future's side) with a soft edge and a halo that flares on a drop; on paper the
    // moon is a plain gold sun
    // THE MOON is the Sea's (the user: "take the moon from sea and use it in tide too"). The Sea
    // sees it through a 50° lens: a disc of angular radius 0.03..0.036 rad with an exponential
    // halo exp(−7·angle) that flares on a drop (0.35 + 0.65·halo, × 0.45 on the faceplate and
    // 0.2 on paper), ADDED over the sky. The same lens here: a focal length of h / (2·tan 25°)
    // turns those angles into pixels, and "lighter" compositing is the shader's +=
    const focal = h / (2 * Math.tan(Math.PI / 7.2));
    const moonX = w * 0.62;
    const moonY = baseY - h * 0.27;
    const pale = P.light ? P.gold : mix(P.gold, [255, 255, 255], 0.55);
    if (!P.light) {
      const t = f.now / 1000;
      for (const st of this.stars) {
        const tw = 0.35 + 0.65 * noise(t * 0.5 + st.seed, st.seed);
        ctx.fillStyle = rgba(P.ink, 0.55 * tw * (1 - st.y * 0.7));
        ctx.fillRect(st.x * w, st.y * (baseY - h * 0.03), st.size, st.size);
      }
    }
    this.halo = easeTowards(this.halo, 0, f.dt, 0.6);
    // the disc, mixed in: full to 0.03 rad, gone by 0.036
    const discR = 0.036 * focal;
    const disc = ctx.createRadialGradient(moonX, moonY, 0, moonX, moonY, discR);
    disc.addColorStop(0, rgba(pale, 1));
    disc.addColorStop(0.03 / 0.036, rgba(pale, 1));
    disc.addColorStop(0.033 / 0.036, rgba(pale, 0.5));
    disc.addColorStop(1, rgba(pale, 0));
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(moonX, moonY, discR, 0, Math.PI * 2);
    ctx.fill();
    // the halo, added: exp(−7·angle), sampled at a few angles out to 0.6 rad
    const strength = (0.35 + 0.65 * this.halo) * (P.light ? 0.2 : 0.45);
    const haloR = 0.6 * focal;
    const halo = ctx.createRadialGradient(moonX, moonY, 0, moonX, moonY, haloR);
    for (const a of [0, 0.02, 0.05, 0.1, 0.15, 0.22, 0.3, 0.4, 0.6])
      halo.addColorStop(a / 0.6, rgba(pale, Math.min(1, strength * Math.exp(-7 * a))));
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = halo;
    ctx.fillRect(moonX - haloR, moonY - haloR, haloR * 2, haloR * 2);
    ctx.restore();

    // the swell to come: the loudness around now, the future on the right
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const secs = f.position + (x / w - 0.5) * 60;
      let v = 0;
      if (secs >= 0) for (let k = -2; k <= 2; k++) v += f.loudAt(secs + k * 0.3) / 5;
      const y = baseY - h * 0.05 - v * h * 0.12;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rgba(P.ink, f.real ? 0.13 : 0.06);
    ctx.setLineDash([2, 5]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // the water, two sheets for depth
    const water = P.light ? mix(P.accent[1], P.bg, 0.3) : P.accent[1];
    const sheets: Array<[number, number, number]> = [
      [1.7, 0.5, 0.05],
      [0, 0.95, 0],
    ];
    for (const [k, alpha, depth] of sheets) {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 3) ctx.lineTo(x, surface(x, k) + depth * h);
      ctx.lineTo(w, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, baseY - amp, 0, h);
      g.addColorStop(0, rgba(water, alpha));
      g.addColorStop(0.45, rgba(mix(water, P.bg, 0.55), alpha));
      g.addColorStop(1, rgba(mix(water, P.bg, 0.92), alpha));
      ctx.fillStyle = g;
      ctx.fill();
    }
    // the far water dissolves toward the sky: a soft band under the horizon
    const fogCol = mix(P.bg, P.accent[0], 0.3);
    const fog = ctx.createLinearGradient(0, baseY - amp, 0, baseY + h * 0.1);
    fog.addColorStop(0, rgba(fogCol, P.light ? 0.25 : 0.4));
    fog.addColorStop(1, rgba(fogCol, 0));
    ctx.fillStyle = fog;
    ctx.fillRect(0, baseY - amp, w, h * 0.1 + amp);
    // THE GLADE: the moon's light down the water, rows of broken shimmer that spread and dim
    // with depth, brighter in the highs and while a hat's glint lasts
    this.glint = easeTowards(this.glint, 0, f.dt, 0.12);
    const gladeTop = surface(moonX);
    const shimmer = (0.45 + 0.35 * highs + 0.35 * this.glint) * (P.light ? 0.5 : 1);
    for (let y = gladeTop + 2; y < h; y += 5) {
      const k = (y - gladeTop) / Math.max(1, h - gladeTop);
      const hw = w * (0.012 + 0.11 * k);
      const a = Math.max(0, noise(y * 0.045, this.phase * 1.7 + y * 0.013) - 0.3) / 0.7;
      if (a <= 0.02) continue;
      const cx = moonX + (noise(y * 0.09 + 7, this.phase * 0.6) - 0.5) * hw * 0.8;
      const len = hw * (0.3 + 0.7 * noise(y * 0.07 + 3, this.phase * 0.9));
      ctx.fillStyle = rgba(pale, shimmer * a * (1 - 0.7 * k));
      ctx.fillRect(cx - len / 2, y, len, 1.5);
    }
    // the glints that fire: sparkles in the glade on a hat, gone within a quarter second
    for (let i = this.glints.length - 1; i >= 0; i--) {
      const gl = this.glints[i];
      gl.age += f.dt;
      if (gl.age > gl.life) {
        this.glints.splice(i, 1);
        continue;
      }
      ctx.fillStyle = rgba(pale, 0.9 * (1 - gl.age / gl.life));
      ctx.fillRect(gl.x - 1, gl.y - 1, 2.5, 2.5);
    }
    // the surface catches the light, more when a snare lights the crests
    this.crestAim = easeTowards(this.crestAim, 0, f.dt, 0.25);
    this.crest = easeTowards(this.crest, this.crestAim, f.dt, 0.05);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 3) {
      const y = surface(x);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rgba(P.gold, Math.min(1, 0.25 + 0.55 * f.loud + 0.4 * this.crest));
    ctx.lineWidth = 1 + 1.6 * f.loud + 0.8 * this.crest;
    ctx.stroke();

    // spray off the crests on a snare or a hat; a kick heaves the swell. Without an onset list
    // the strip's transient (with treble in it) sprays instead
    const treble = highs - this.prevHighs;
    this.prevHighs = highs;
    // a drop's release heaves the whole sea and flares the moon
    if (f.drop?.onDrop) {
      this.surgeAim = Math.max(this.surgeAim, 1.6);
      this.halo = 1;
    }
    const fireGlints = (n: number): void => {
      if (f.reduced) return;
      for (let i = 0; i < n; i++) {
        const k = Math.random() * Math.random();
        const y = gladeTop + k * (h - gladeTop);
        const hw = w * (0.012 + 0.11 * k);
        this.glints.push({
          x: moonX + (Math.random() - 0.5) * 2 * hw,
          y,
          age: 0,
          life: 0.18 + 0.15 * Math.random(),
        });
      }
      if (this.glints.length > 160) this.glints.splice(0, this.glints.length - 160);
    };
    let sprayN = 0;
    if (f.hitsKnown) {
      for (const hit of f.hits) {
        if (hit.type === "kick") this.surgeAim = Math.max(this.surgeAim, hit.strength);
        else if (hit.type === "snare")
          this.crestAim = Math.max(this.crestAim, 0.3 + 0.7 * hit.strength);
        else {
          this.glint = Math.max(this.glint, 0.35 + 0.65 * hit.strength);
          fireGlints(5 + Math.round(8 * hit.strength));
        }
        if (hit.type !== "kick" && hit.strength >= 0.3)
          sprayN +=
            hit.type === "snare"
              ? 4 + Math.round(8 * hit.strength)
              : 1 + Math.round(3 * hit.strength);
      }
    } else if ((f.onset > 0.4 || treble > 0.14) && highs > 0.3 && f.now - this.lastSpray > 350) {
      this.lastSpray = f.now;
      sprayN = 5 + Math.round(9 * f.onset);
      this.glint = Math.max(this.glint, 0.6);
      fireGlints(6);
    }
    if (!f.reduced && sprayN > 0) {
      const n = f.mini ? Math.min(3, sprayN) : sprayN;
      for (let i = 0; i < n; i++) {
        const x = Math.random() * w;
        this.spray.push({
          x,
          y: surface(x),
          vx: (Math.random() - 0.5) * 60 * (h / 800),
          vy: -(70 + Math.random() * 130) * (h / 800) * (0.6 + highs),
          age: 0,
          life: 0.8 + Math.random() * 0.8,
        });
      }
      if (this.spray.length > 220) this.spray.splice(0, this.spray.length - 220);
    }
    for (let i = this.spray.length - 1; i >= 0; i--) {
      const d = this.spray[i];
      d.age += f.dt;
      if (d.age > d.life) {
        this.spray.splice(i, 1);
        continue;
      }
      d.vy += 260 * (h / 800) * f.dt;
      d.x += d.vx * f.dt;
      d.y += d.vy * f.dt;
      const k = 1 - d.age / d.life;
      ctx.fillStyle = rgba(P.gold, 0.85 * k);
      ctx.beginPath();
      ctx.arc(d.x, d.y, 0.9 + 1.6 * k, 0, Math.PI * 2);
      ctx.fill();
    }

    // the words ride the water: a line SURFACES from where it waited (the next
    // line rises under the water and, when its time comes, its size, color and
    // depth blend up to the surface over most of a second instead of popping)
    if (f.lyric) {
      const { text, next, progress, index } = f.lyric;
      if (index !== this.lineIndex) {
        this.lineIndex = index;
        this.emergeAt = f.now;
      }
      const emerge = f.reduced ? 1 : easeOutCubic((f.now - this.emergeAt) / 700);
      const waitY = baseY + h * 0.07;
      if (text) {
        let px = lerp(typePx(f, "body"), typePx(f, "lead"), emerge);
        setFont(ctx, emerge > 0.5 ? 500 : 400, px, f.font);
        let width = ctx.measureText(text).width;
        if (width > w * 0.9) {
          px *= (w * 0.9) / width;
          setFont(ctx, emerge > 0.5 ? 500 : 400, px, f.font);
          width = ctx.measureText(text).width;
        }
        const sinkT = progress > 0.84 ? easeInCubic((progress - 0.84) / 0.16) : 0;
        const sink = sinkT * h * 0.12;
        // the waiting line has reached 0.68 by the time it surfaces; start there, not lower
        const alpha = lerp(0.68, 1, emerge) * (1 - sinkT);
        ctx.fillStyle = rgba(mix(mix(P.ink, P.accent[1], 0.25), P.gold, emerge), alpha);
        ctx.textBaseline = "alphabetic";
        let x = (w - width) / 2;
        for (const ch of [...text]) {
          const cw = ctx.measureText(ch).width;
          const surf = surface(x + cw / 2) - px * 0.35 + sink;
          ctx.fillText(ch, x, lerp(waitY, surf, emerge));
          x += cw;
        }
      }
      // the waiting line is ALWAYS drawn, after the current one so the sinking
      // words never cover it, and it fades in when it changes rather than popping
      if (next) {
        if (index + 1 !== this.nextIndex) {
          this.nextIndex = index + 1;
          this.nextSince = f.now;
        }
        const arrive = f.reduced ? 1 : clamp((f.now - this.nextSince) / 600);
        const rise = smoothstep(0.7, 1, progress);
        const px = typePx(f, "body");
        setFont(ctx, 400, px, f.font);
        // a long line wraps (never an ellipsis), the block's last line where the single line sat
        const fit = fitText(ctx, next, {
          maxWidth: w * 0.8,
          maxPx: px,
          minPx: px * 0.75,
          maxLines: 2,
          weight: 400,
          family: f.font,
        });
        ctx.fillStyle = rgba(mix(P.ink, P.accent[1], 0.25), (0.38 + 0.3 * rise) * arrive);
        ctx.textAlign = "center";
        const ny = baseY + h * 0.2 - rise * h * 0.13 - (fit.lines.length - 1) * fit.px * 1.2;
        fit.lines.forEach((l, k) => ctx.fillText(l, w / 2, ny + k * fit.px * 1.2));
        ctx.textAlign = "start";
      }
    }
    void clamp;
  }
}
