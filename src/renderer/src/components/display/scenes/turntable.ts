import type { Scene, SceneFrame, SceneKey, SceneSettingDef, SceneSettings } from "./types";
import { easeTowards } from "../clock";
import { sceneFont } from "../type";
import { TAU, arcText, clamp, ellipsize, hashStr, mix, rgb, rgba, rng } from "./lib";

/**
 * TURNTABLE. The album on a record deck, seen from above: the cover printed on the label,
 * turning at 33⅓ while the track plays and coasting to a stop on a pause; the tonearm
 * lying in the groove at the track's position, from the lead-in at the edge to the run-out
 * by the label; the sleeve beside the deck. Everything that moves is the streamer's report
 * (playing or paused, the position, the length), so the scene draws for any source. For an
 * analyzed track the grooves carry the track's loudness as real vinyl does, a louder
 * passage cut wider and catching more light; for anything else they are plain. The record's
 * sheen stays where the light is while the record turns beneath it, as it does on a deck.
 */
export const TURNTABLE_KEY: SceneKey = {
  reads: [
    { shows: "The label", means: "The album art, turning while the track plays." },
    {
      shows: "The tonearm",
      means: "Track position, from the edge of the record in toward the label.",
    },
    {
      shows: "The grooves",
      means: "The track's loudness, lighter where it is louder. For an analyzed track.",
    },
    { shows: "The sleeve", means: "The album art." },
    { shows: "The line beneath", means: "The lyric being sung." },
  ],
  honesty: ["A station has no track position, so the tonearm rests a little way in."],
};

export const TURNTABLE_SETTINGS: SceneSettingDef[] = [
  { key: "sleeve", label: "Sleeve", kind: "toggle", default: true, full: true },
];

/** 33⅓ revolutions a minute, in radians a second. */
const SPEED = (TAU * (100 / 3)) / 60;
/** The groove's span as shares of the record's radius: the lead-in to the run-out. */
const GROOVE_OUT = 0.955;
const GROOVE_IN = 0.37;
const LABEL = 0.33;
/** The record's radius against the deck's scale: a size up from the arm and the plinth, so it
 *  fills more of the deck (user, 2026-10-06). */
const RECORD = 1.1;
/** Where the stylus rests for a station, which has no position. */
const RADIO_SHARE = 0.18;

interface Disc {
  key: string;
  canvas: HTMLCanvasElement;
}

export class Turntable implements Scene {
  settings: SceneSettings = {};
  private angle = 0;
  private omega = 0;
  /** The arm's share of the groove, eased, and how far it is lifted toward its rest (1). */
  private armShare = 0;
  private armRest = 1;
  private disc: Disc | null = null;

  /** The record without its label: the grooves (the track's loudness when it is known),
   *  the lead-in and run-out, the rim, and the sheen the light puts on it. Drawn once per
   *  track and size; a frame only turns the label above it. */
  private discFor(f: SceneFrame, R: number, scale: number): HTMLCanvasElement {
    const trackKey = `${f.title ?? ""}|${f.subtitle ?? ""}|${f.duration ?? 0}`;
    const key = `${Math.round(R * scale)}|${f.real ? 1 : 0}|${trackKey}`;
    if (this.disc?.key === key) return this.disc.canvas;
    const px = Math.max(2, Math.round(R * 2 * scale));
    const canvas = this.disc?.canvas ?? document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const g = canvas.getContext("2d");
    if (!g) return canvas;
    const c = px / 2;
    const rr = px / 2;
    g.clearRect(0, 0, px, px);
    g.fillStyle = "rgb(12,12,13)";
    g.beginPath();
    g.arc(c, c, rr, 0, TAU);
    g.fill();
    // the grooves: one ring per pixel or so, their shade the loudness at the time that ring
    // plays, outer first, with a little grain so the surface reads as cut, not painted
    const out = rr * GROOVE_OUT;
    const inn = rr * GROOVE_IN;
    const step = Math.max(1, px / 700);
    const rand = rng(hashStr(trackKey));
    const dur = f.duration ?? 0;
    for (let r = inn; r <= out; r += step) {
      const share = (out - r) / (out - inn);
      const loud = f.real && dur > 0 ? f.loudAt(share * dur) : 0.3;
      const lum = 13 + 17 * loud + (rand() - 0.5) * 5;
      g.strokeStyle = `rgb(${lum.toFixed(1)},${lum.toFixed(1)},${(lum + 1.5).toFixed(1)})`;
      g.lineWidth = step * 0.8;
      g.beginPath();
      g.arc(c, c, r, 0, TAU);
      g.stroke();
    }
    // the lead-in and the run-out: smooth, unmodulated bands
    g.strokeStyle = "rgb(20,20,22)";
    g.lineWidth = rr * (0.985 - GROOVE_OUT);
    g.beginPath();
    g.arc(c, c, rr * ((0.985 + GROOVE_OUT) / 2), 0, TAU);
    g.stroke();
    g.strokeStyle = "rgb(9,9,10)";
    g.lineWidth = rr * (GROOVE_IN - LABEL);
    g.beginPath();
    g.arc(c, c, rr * ((GROOVE_IN + LABEL) / 2), 0, TAU);
    g.stroke();
    // the rim
    g.strokeStyle = "rgba(255,255,255,0.12)";
    g.lineWidth = Math.max(1, rr * 0.006);
    g.beginPath();
    g.arc(c, c, rr * 0.996, 0, TAU);
    g.stroke();
    // the sheen: two opposed fans of light, fixed where the lamp is
    g.save();
    g.beginPath();
    g.arc(c, c, rr, 0, TAU);
    g.clip();
    const sheen = g.createConicGradient(-Math.PI * 0.72, c, c);
    sheen.addColorStop(0, "rgba(255,255,255,0)");
    sheen.addColorStop(0.06, "rgba(255,255,255,0.16)");
    sheen.addColorStop(0.13, "rgba(255,255,255,0)");
    sheen.addColorStop(0.5, "rgba(255,255,255,0)");
    sheen.addColorStop(0.56, "rgba(255,255,255,0.09)");
    sheen.addColorStop(0.63, "rgba(255,255,255,0)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    g.globalCompositeOperation = "screen";
    g.fillStyle = sheen;
    g.fillRect(0, 0, px, px);
    g.restore();
    this.disc = { key, canvas };
    return canvas;
  }

  draw(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P, deck } = f;
    const scale = ctx.getTransform().a || 1;
    const wide = !f.mini && w / h > 1.25;
    const light = P.light;

    // the room: the theme's ground, lit from the upper left
    ctx.fillStyle = rgb(P.bg);
    ctx.fillRect(0, 0, w, h);
    const lamp = ctx.createRadialGradient(w * 0.25, h * 0.1, 0, w * 0.25, h * 0.1, Math.max(w, h));
    lamp.addColorStop(0, rgba(light ? [255, 255, 255] : [255, 240, 220], light ? 0.35 : 0.06));
    lamp.addColorStop(1, rgba(P.bg, 0));
    ctx.fillStyle = lamp;
    ctx.fillRect(0, 0, w, h);

    // the deck on the right and the sleeve on the left, never touching; with the sleeve off
    // the deck comes to the middle
    const sleeve = wide && this.settings.sleeve !== false;
    // R is the deck's scale; the record is a size larger (RECORD) so it fills more of the
    // plinth (user, 2026-10-06). Out of the wide frame the whole deck is fitted and centered,
    // the arm's counterweight and cue lever on the right included (they ran off a tile's
    // edge): from the platter's left edge to the lever is about 2.69 R, from the
    // counterweight's top to the platter's bottom about 2.29 R
    const R = wide ? Math.min(h * 0.35, w * 0.2) : Math.min((w * 0.92) / 2.69, (h * 0.88) / 2.29);
    const Rr = R * RECORD;
    const cx = !wide ? w / 2 - R * 0.2 : sleeve ? w * 0.64 : w * 0.47;
    const cy = wide ? h * 0.47 : h * 0.48;
    if (sleeve) {
      // the sleeve the record came out of, a 12" sleeve being a touch larger than its
      // record (user, 2026-10-06: the art read too small beside it), set beside the plinth
      // and off the frame's left edge when it must be
      const S = Rr * 2.06;
      this.drawSleeve(ctx, f, cx - R * 1.36 - S / 2, cy, S);
    }

    // the plinth: the deck itself, a shade off the room
    if (wide) {
      const px0 = cx - R * 1.28;
      const py0 = cy - R * 1.24;
      const pw = R * 2.9;
      const ph = R * 2.48;
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${light ? 0.18 : 0.5})`;
      ctx.shadowBlur = R * 0.12;
      ctx.shadowOffsetY = R * 0.03;
      ctx.fillStyle = rgb(mix(P.bg, light ? [0, 0, 0] : [255, 255, 255], light ? 0.1 : 0.05));
      ctx.beginPath();
      ctx.roundRect(px0, py0, pw, ph, R * 0.06);
      ctx.fill();
      ctx.restore();
      // the plinth's edge, catching the light on the faceplate and a shade on paper
      ctx.strokeStyle = light ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(px0 + 0.5, py0 + 0.5, pw - 1, ph - 1, R * 0.06);
      ctx.stroke();
    }

    // the platter's edge, with the strobe's dots turning on its rim
    const turning = f.playing && deck.loaded && !f.reduced;
    this.omega = easeTowards(this.omega, turning ? SPEED : 0, f.dt, turning ? 0.25 : 0.7);
    this.angle = (this.angle + this.omega * f.dt) % TAU;
    ctx.fillStyle = light ? "rgb(150,150,156)" : "rgb(34,34,37)";
    ctx.beginPath();
    ctx.arc(cx, cy, Rr * 1.035, 0, TAU);
    ctx.fill();
    ctx.fillStyle = light ? "rgba(40,40,44,0.45)" : "rgba(210,210,215,0.35)";
    const dots = 90;
    for (let i = 0; i < dots; i++) {
      const a = this.angle + (i / dots) * TAU;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * Rr * 1.018, cy + Math.sin(a) * Rr * 1.018, Rr * 0.004, 0, TAU);
      ctx.fill();
    }

    // the record, then its label turning on it
    ctx.drawImage(this.discFor(f, Rr, scale), cx - Rr, cy - Rr, Rr * 2, Rr * 2);
    this.drawLabel(ctx, f, cx, cy, Rr * (wide ? LABEL : 0.36));
    ctx.fillStyle = "rgb(190,190,196)";
    ctx.beginPath();
    ctx.arc(cx, cy, Rr * 0.018, 0, TAU);
    ctx.fill();

    // the tonearm
    const share =
      f.duration && f.duration > 0
        ? clamp(f.position / f.duration)
        : deck.radio && deck.loaded
          ? RADIO_SHARE
          : 0;
    this.armShare = easeTowards(this.armShare, share, f.dt, 0.3);
    this.armRest = easeTowards(this.armRest, deck.loaded ? 0 : 1, f.dt, 0.45);
    this.drawArm(ctx, cx, cy, R, Rr, light);

    // the words, beneath the deck, when there are some to show
    const words = f.lyric?.text;
    if (words) {
      const px = sceneFont(ctx, f, wide ? "lead" : "body", 500);
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = rgba(P.ink, 0.92);
      const y = wide ? h * 0.93 : h * 0.96;
      ctx.fillText(ellipsize(ctx, words, w * 0.86), w / 2, y - px * 0.1);
      ctx.textAlign = "start";
    }
  }

  private drawSleeve(
    ctx: CanvasRenderingContext2D,
    f: SceneFrame,
    x: number,
    y: number,
    S: number,
  ): void {
    const P = f.palette;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.045);
    ctx.shadowColor = `rgba(0,0,0,${P.light ? 0.22 : 0.55})`;
    ctx.shadowBlur = S * 0.07;
    ctx.shadowOffsetX = S * 0.01;
    ctx.shadowOffsetY = S * 0.025;
    const art = f.deck.art;
    ctx.fillStyle = rgb(mix(P.bg, P.light ? [0, 0, 0] : [255, 255, 255], 0.1));
    ctx.fillRect(-S / 2, -S / 2, S, S);
    ctx.shadowColor = "transparent";
    if (art) {
      const side = Math.min(art.naturalWidth, art.naturalHeight);
      ctx.drawImage(
        art,
        (art.naturalWidth - side) / 2,
        (art.naturalHeight - side) / 2,
        side,
        side,
        -S / 2,
        -S / 2,
        S,
        S,
      );
    } else {
      // no picture: a plain sleeve with the title typeset on it
      ctx.fillStyle = rgba(P.ink, 0.85);
      ctx.textAlign = "center";
      sceneFont(ctx, f, S * 0.07, 600);
      ctx.fillText(ellipsize(ctx, f.title ?? "", S * 0.8), 0, -S * 0.02);
      sceneFont(ctx, f, S * 0.045, 400);
      ctx.fillStyle = rgba(P.dim, 0.9);
      ctx.fillText(ellipsize(ctx, f.subtitle ?? "", S * 0.8), 0, S * 0.07);
      ctx.textAlign = "start";
    }
    // the card's edge catching the light
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.strokeRect(-S / 2 + 0.5, -S / 2 + 0.5, S - 1, S - 1);
    ctx.restore();
  }

  private drawLabel(
    ctx: CanvasRenderingContext2D,
    f: SceneFrame,
    cx: number,
    cy: number,
    Lr: number,
  ): void {
    const P = f.palette;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.angle);
    ctx.beginPath();
    ctx.arc(0, 0, Lr, 0, TAU);
    ctx.clip();
    const art = f.deck.art;
    if (art) {
      const side = Math.min(art.naturalWidth, art.naturalHeight);
      ctx.drawImage(
        art,
        (art.naturalWidth - side) / 2,
        (art.naturalHeight - side) / 2,
        side,
        side,
        -Lr,
        -Lr,
        Lr * 2,
        Lr * 2,
      );
    } else {
      // no picture: a printed label in the art's color, the title around the top and the
      // artist around the bottom
      ctx.fillStyle = rgb(mix(P.accent[0], [0, 0, 0], 0.35));
      ctx.fillRect(-Lr, -Lr, Lr * 2, Lr * 2);
      ctx.fillStyle = rgba([250, 246, 238], 0.92);
      sceneFont(ctx, f, Lr * 0.16, 600);
      arcText(ctx, f.title ?? "", 0, 0, Lr * 0.72, -Math.PI / 2, Math.PI * 0.9);
      sceneFont(ctx, f, Lr * 0.12, 400);
      arcText(ctx, f.subtitle ?? "", 0, 0, -Lr * 0.72, -Math.PI / 2, Math.PI * 0.8);
      sceneFont(ctx, f, Lr * 0.11, 500, { mono: true });
      ctx.textAlign = "center";
      ctx.fillText("33⅓", 0, Lr * 0.42);
      ctx.textAlign = "start";
    }
    ctx.restore();
    // the label's edge, pressed into the vinyl
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = Math.max(1, Lr * 0.02);
    ctx.beginPath();
    ctx.arc(cx, cy, Lr, 0, TAU);
    ctx.stroke();
  }

  /** The arm swings about its pivot so the stylus sits on the groove at the arm's share:
   *  the stylus is where a circle of the arm's length about the pivot meets the groove's
   *  circle about the spindle. Lifted, it swings out to its rest beside the record. */
  private drawArm(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
    /** The record's radius, the grooves' scale. */
    Rr: number,
    light: boolean,
  ): void {
    const px = cx + R * 1.22;
    // low enough that the counterweight stays on the plinth
    const py = cy - R * 0.8;
    const L = R * 1.3;
    const dx = px - cx;
    const dy = py - cy;
    const d = Math.hypot(dx, dy);
    const ux = dx / d;
    const uy = dy / d;
    // the perpendicular toward the lower right, where the stylus meets the record
    const vx = -uy;
    const vy = ux;
    const r = Rr * (GROOVE_OUT - (GROOVE_OUT - GROOVE_IN) * this.armShare);
    const a = (r * r - L * L + d * d) / (2 * d);
    const hh = Math.sqrt(Math.max(0, r * r - a * a));
    const gxp = cx + a * ux + hh * vx;
    const gyp = cy + a * uy + hh * vy;
    const grooveAngle = Math.atan2(gyp - py, gxp - px);
    // the rest: down from the pivot, a touch outward so the lifted arm and its post clear the
    // record's edge
    const restAngle = Math.atan2(1, 0.04);
    const ang = grooveAngle + (restAngle - grooveAngle) * this.armRest;
    // DRAWN AS MACHINED PARTS, NOT PANELS (user, 2026-10-06: "the turntable arm/etc especially
    // looks a little too much like flat svg boxes"): every part is shaded as the solid it is,
    // lit from the room's lamp at the upper left: the tube a cylinder with its highlight on
    // the lamp's side, the counterweight a knurled drum, the bearing a domed cap on a bevelled
    // base, the headshell a tapered plate carrying a cartridge, with a finger lift. The shadow
    // falls further as the arm lifts to its rest.
    const lampX = -0.62;
    const lampY = -0.78;
    // which side of the tube (its local -y or +y) faces the lamp at this angle
    const lit = Math.sin(ang) * lampX - Math.cos(ang) * lampY > 0 ? -1 : 1;
    const steel = (lum: number, a = 1): string =>
      `rgba(${lum},${lum},${Math.min(255, lum + 6)},${a})`;

    // the cue lever and the arm rest's cradle, fixed to the plinth beside the pivot
    const rx = px + Math.cos(restAngle) * L * 0.72;
    const ry = py + Math.sin(restAngle) * L * 0.72;
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${light ? 0.25 : 0.5})`;
    ctx.shadowBlur = R * 0.02;
    ctx.shadowOffsetX = R * 0.008;
    ctx.shadowOffsetY = R * 0.012;
    const post = ctx.createRadialGradient(rx - R * 0.01, ry - R * 0.012, 0, rx, ry, R * 0.032);
    post.addColorStop(0, steel(170));
    post.addColorStop(1, steel(60));
    ctx.fillStyle = post;
    ctx.beginPath();
    ctx.arc(rx, ry, R * 0.032, 0, TAU);
    ctx.fill();
    ctx.restore();
    // the rubber pad the lifted arm sits on
    ctx.fillStyle = "rgb(30,30,33)";
    ctx.beginPath();
    ctx.arc(rx, ry, R * 0.017, 0, TAU);
    ctx.fill();
    const lx = px + R * 0.2;
    const ly = py + R * 0.16;
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(0.5);
    ctx.fillStyle = steel(40);
    ctx.beginPath();
    ctx.roundRect(-R * 0.03, -R * 0.03, R * 0.06, R * 0.06, R * 0.012);
    ctx.fill();
    const lever = ctx.createLinearGradient(0, -R * 0.012, 0, R * 0.012);
    lever.addColorStop(0, steel(200));
    lever.addColorStop(0.5, steel(130));
    lever.addColorStop(1, steel(70));
    ctx.fillStyle = lever;
    ctx.beginPath();
    ctx.roundRect(-R * 0.01, -R * 0.011, R * 0.13, R * 0.022, R * 0.011);
    ctx.fill();
    ctx.restore();

    // the pivot's base plate, bevelled: lit along its upper left edge, shaded along the lower
    // right
    const baseR = R * 0.14;
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${light ? 0.25 : 0.55})`;
    ctx.shadowBlur = R * 0.03;
    ctx.shadowOffsetX = R * 0.01;
    ctx.shadowOffsetY = R * 0.018;
    const plate = ctx.createRadialGradient(px - baseR * 0.3, py - baseR * 0.3, 0, px, py, baseR);
    plate.addColorStop(0, steel(70));
    plate.addColorStop(1, steel(38));
    ctx.fillStyle = plate;
    ctx.beginPath();
    ctx.arc(px, py, baseR, 0, TAU);
    ctx.fill();
    ctx.restore();
    const bevel = ctx.createLinearGradient(px - baseR, py - baseR, px + baseR, py + baseR);
    bevel.addColorStop(0, "rgba(255,255,255,0.35)");
    bevel.addColorStop(0.5, "rgba(255,255,255,0.04)");
    bevel.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.strokeStyle = bevel;
    ctx.lineWidth = Math.max(1, R * 0.008);
    ctx.beginPath();
    ctx.arc(px, py, baseR - R * 0.004, 0, TAU);
    ctx.stroke();

    // the arm, its shadow first, then the parts along it in the arm's own frame
    const tube = R * 0.032;
    const tubeStart = -R * 0.2;
    const tubeEnd = L * 0.9;
    const silhouette = (): void => {
      ctx.beginPath();
      ctx.roundRect(-R * 0.37, -R * 0.065, R * 0.17, R * 0.13, R * 0.03);
      ctx.roundRect(tubeStart, -tube / 2, tubeEnd - tubeStart, tube, tube / 2);
      ctx.fill();
      ctx.save();
      ctx.translate(tubeEnd, 0);
      ctx.rotate(-0.38);
      ctx.beginPath();
      ctx.roundRect(-R * 0.03, -R * 0.05, R * 0.2, R * 0.1, R * 0.02);
      ctx.fill();
      ctx.restore();
    };
    const lift = R * (0.035 + 0.04 * this.armRest);
    ctx.save();
    ctx.translate(px + lift * 0.6, py + lift);
    ctx.rotate(ang);
    ctx.filter = `blur(${Math.max(1, R * 0.022).toFixed(1)}px)`;
    ctx.fillStyle = `rgba(0,0,0,${light ? 0.22 : 0.5})`;
    silhouette();
    ctx.restore();

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);

    // the counterweight: a drum behind the pivot, rounded across its width, knurled
    const cw0 = -R * 0.37;
    const cwW = R * 0.17;
    const cwH = R * 0.13;
    const drum = ctx.createLinearGradient(0, (-lit * cwH) / 2, 0, (lit * cwH) / 2);
    drum.addColorStop(0, steel(150));
    drum.addColorStop(0.35, steel(95));
    drum.addColorStop(1, steel(32));
    ctx.fillStyle = drum;
    ctx.beginPath();
    ctx.roundRect(cw0, -cwH / 2, cwW, cwH, R * 0.03);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = Math.max(0.5, R * 0.004);
    for (let i = 1; i < 7; i++) {
      const x = cw0 + (cwW * i) / 7;
      ctx.beginPath();
      ctx.moveTo(x, -cwH / 2 + R * 0.01);
      ctx.lineTo(x, cwH / 2 - R * 0.01);
      ctx.stroke();
    }
    // the stub the weight rides on, between it and the bearing
    ctx.fillStyle = steel(90);
    ctx.fillRect(cw0 + cwW, -tube * 0.35, R * 0.04, tube * 0.7);

    // the tube: a cylinder in layers, the dark body, the lit face, and the highlight's line
    // on the lamp's side, with the shade along the far side
    const line = (width: number, color: string, offset: number): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(tubeStart, offset);
      ctx.lineTo(tubeEnd, offset);
      ctx.stroke();
    };
    line(tube, steel(96), 0);
    line(tube * 0.62, steel(176), lit * tube * 0.1);
    line(tube * 0.2, "rgba(255,255,255,0.9)", lit * tube * 0.22);
    line(tube * 0.18, "rgba(0,0,0,0.3)", -lit * tube * 0.36);

    // the headshell, turned by the arm's offset to follow the groove: a tapered plate, the
    // cartridge under it with its stylus at the front, and the finger lift to the side
    ctx.translate(tubeEnd, 0);
    ctx.rotate(-0.38);
    const shell = ctx.createLinearGradient(0, -R * 0.05, 0, R * 0.05);
    shell.addColorStop(lit < 0 ? 0 : 1, steel(190));
    shell.addColorStop(0.5, steel(120));
    shell.addColorStop(lit < 0 ? 1 : 0, steel(62));
    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.moveTo(-R * 0.03, -R * 0.03);
    ctx.lineTo(R * 0.16, -R * 0.05);
    ctx.quadraticCurveTo(R * 0.18, 0, R * 0.16, R * 0.05);
    ctx.lineTo(-R * 0.03, R * 0.03);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = Math.max(0.5, R * 0.004);
    ctx.stroke();
    // the cartridge: a dark body with a thin bright edge and two screws
    ctx.fillStyle = "rgb(22,22,25)";
    ctx.beginPath();
    ctx.roundRect(R * 0.035, -R * 0.03, R * 0.1, R * 0.06, R * 0.008);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(R * 0.035, -R * 0.03, R * 0.1, Math.max(0.5, R * 0.005));
    ctx.fillStyle = steel(170);
    for (const sx of [R * 0.06, R * 0.11]) {
      ctx.beginPath();
      ctx.arc(sx, 0, R * 0.007, 0, TAU);
      ctx.fill();
    }
    // the finger lift, a thin curl off the plate's side
    ctx.strokeStyle = steel(175);
    ctx.lineWidth = Math.max(1, R * 0.011);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(R * 0.13, -R * 0.045);
    ctx.quadraticCurveTo(R * 0.16, -R * 0.1, R * 0.21, -R * 0.105);
    ctx.stroke();
    ctx.restore();

    // the bearing on top of it all: a domed cap, its highlight toward the lamp
    const capR = R * 0.075;
    const dome = ctx.createRadialGradient(
      px - capR * 0.35,
      py - capR * 0.4,
      capR * 0.05,
      px,
      py,
      capR,
    );
    dome.addColorStop(0, steel(225));
    dome.addColorStop(0.45, steel(140));
    dome.addColorStop(1, steel(48));
    ctx.fillStyle = dome;
    ctx.beginPath();
    ctx.arc(px, py, capR, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = Math.max(0.5, R * 0.004);
    ctx.stroke();
  }
}
