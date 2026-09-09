import * as THREE from "three";
import type {
  Rgb,
  SceneFrame,
  SceneKey,
  ScenePointer,
  SceneSettingDef,
  SceneSettings,
  ThreeScene,
} from "../types";
import { toColor } from "../../three";
import { clamp, mix, wrap } from "../lib";
import { DEFAULT_PARAMS, Fluid } from "./fluid";
import {
  EMIT_HZ,
  LIFT,
  PULSE_ONSET,
  PUSH,
  SPLAT_RADIUS,
  VENT_INSET,
  WHIRLPOOL_ONSET,
  dyeDissipation,
  ventFor,
  ventX,
  whirlpoolFor,
} from "./model";

/**
 * THE WORDS' LAYER: the current lyric as a solid layer over the gas, not ink in it. The letters
 * are also the fluid's OBSTACLE (Fluid.setObstacle), so the gas parts around them and curls
 * through their counters; with nothing under a letter, it is lit from the gas AROUND it (four
 * taps a little way out), and the flow past it bends it a hair. Drawn after the water.
 */
const WORDS_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
const WORDS_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uText;
uniform sampler2D uDye;
uniform sampler2D uVel;
uniform vec2 uOrigin;
uniform vec2 uSize;
uniform vec3 uColor;
uniform float uExposure;
uniform float uLight;
uniform float uRefract;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  // the gas around the letter, not under it (a solid holds nothing): four taps a little way out
  vec2 o = vec2(0.012, 0.02);
  vec2 vel = 0.25 * (texture2D(uVel, vUv + vec2(o.x, 0.0)).xy + texture2D(uVel, vUv - vec2(o.x, 0.0)).xy
    + texture2D(uVel, vUv + vec2(0.0, o.y)).xy + texture2D(uVel, vUv - vec2(0.0, o.y)).xy);
  vec2 q = (vUv - uOrigin) / uSize + (vel * uRefract) / uSize;
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) discard;
  float a = texture2D(uText, q).a * uAlpha;
  if (a < 0.01) discard;
  vec3 dye = 0.25 * (texture2D(uDye, vUv + vec2(o.x, 0.0)).rgb + texture2D(uDye, vUv - vec2(o.x, 0.0)).rgb
    + texture2D(uDye, vUv + vec2(0.0, o.y)).rgb + texture2D(uDye, vUv - vec2(0.0, o.y)).rgb) * uExposure;
  float m = max(dye.r, max(dye.g, dye.b));
  vec3 hue = dye / max(m, 0.0001);
  float cover = clamp(m * 0.7, 0.0, 1.0);
  vec3 col = mix(uColor, mix(uColor, hue, 0.75), cover * (1.0 - 0.5 * uLight));
  gl_FragColor = vec4(col, a);
}
`;

/**
 * CONFLUENCE, shown as INK (renamed 2026-09-08; the id and the file keep the old name so
 * saved settings still resolve).
 *
 * CONFLUENCE: ink in water (after packscape's Confluence, in this app's
 * voice). A real fluid. Six vents along the bottom, one per band (a low register rose from the bottom
 * and a high one falls from the top, each in its own color from the art, and
 * the front where they meet is that pair's balance. Ink lingers, so the
 * water carries the last little while as marbling. A hit pulses the loudest
 * register; a big hit spins a whirlpool. The current line is written into
 * the water as ink and drifts apart over its life. Drag the pointer and you
 * stir it.
 */
export const CONFLUENCE_KEY: SceneKey = {
  reads: [
    {
      shows: "Six vents along the bottom",
      means: "one per frequency band, bass at the left. A vent's gas rises as loud as its band",
    },
    { shows: "A puff from the low vents", means: "a kick drum. A big one spins a whirlpool" },
    { shows: "A gust across the frame", means: "a snare" },
    { shows: "A flicker at the high vents", means: "a hi-hat" },
    { shows: "Every vent bursting", means: "a drop" },
    {
      shows: "The words",
      means:
        "the current lyric. The gas flows around the letters and lights them from the sides when the Solid switch is on; off, it passes through them",
    },
    { shows: "The pointer", means: "stirs the gas" },
  ],
  honesty: [
    "The vents are frequency bands, not instruments, and the gas shows about the last fifteen seconds.",
  ],
};

export const CONFLUENCE_SETTINGS: SceneSettingDef[] = [
  { key: "vigor", label: "Vigor", kind: "slider", min: 0.1, max: 2, step: 0.1, default: 1 },
  {
    key: "memory",
    label: "Memory",
    kind: "slider",
    min: 5,
    max: 40,
    step: 1,
    default: 15,
    unit: "s",
  },
  { key: "whirlpools", label: "Whirlpools", kind: "toggle", default: false },
  { key: "words", label: "Words", kind: "toggle", default: true },
  { key: "solid", label: "Solid", kind: "toggle", default: false },
  { key: "stir", label: "Stir", kind: "toggle", default: false },
];

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** A register's ink: the art's first color for the bass end, the third for the air. */
function registerColor(P: SceneFrame["palette"], register: number): Rgb {
  const t = register / 5;
  const c =
    t < 0.5 ? mix(P.accent[0], P.accent[1], t * 2) : mix(P.accent[1], P.accent[2], (t - 0.5) * 2);
  // on paper the ink is the color itself; on the faceplate it is brightened toward the ink
  return P.light ? mix(c, P.ink, 0.15) : mix(c, P.ink, 0.25);
}

export class Confluence implements ThreeScene {
  readonly kind = "three" as const;
  settings: SceneSettings = {};
  pointer: ScenePointer | null = null;
  private fluid: Fluid | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private quad: THREE.Mesh | null = null;
  private w = 1;
  private h = 1;
  private emitAcc = 0;
  private lastPulse = 0;
  private lastWhirl = 0;
  private handed: 1 | -1 = 1;
  private lastPointer: { x: number; y: number } | null = null;
  private shownLine = "";
  private lineSince = 0;
  /** When the last line ended: the words fade out over it (a hole in the gas with no words in
   *  it hung for a second when they vanished at once). */
  private endedAt = 0;
  private textCanvas = document.createElement("canvas");
  private textTexture: THREE.CanvasTexture | null = null;
  /** The words' layer over the water and its box (0..1, y up). */
  private words: THREE.Mesh | null = null;
  private wordsMaterial: THREE.ShaderMaterial | null = null;
  private wordsBox = { w: 0, h: 0 };

  init(renderer: THREE.WebGLRenderer, w: number, h: number): void {
    void renderer;
    this.w = w;
    this.h = h;
    // the water itself waits for the first frame, which knows whether this is a tile
    this.textCanvas.width = 1024;
    this.textCanvas.height = 256;
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.fluid?.resize(w / Math.max(1, h));
  }

  dispose(): void {
    this.fluid?.dispose();
    this.fluid = null;
    this.quad?.geometry.dispose();
    this.words?.geometry.dispose();
    this.wordsMaterial?.dispose();
    this.textTexture?.dispose();
    this.textTexture = null;
  }

  /** The current line as a texture whose alpha is the letters: one size for every line, wrapped
   *  to two rows when it is long, shrinking only when two rows still will not fit (a long line
   *  used to shrink to a single row, so lines differed wildly in size: the user's word). */
  private renderText(text: string, font: string): { texture: THREE.Texture } {
    const c = this.textCanvas;
    const g = c.getContext("2d");
    if (!g) throw new Error("no 2d");
    g.clearRect(0, 0, c.width, c.height);
    let px = 72;
    let lines: string[] = [text];
    const fit = (): void => {
      g.font = `600 ${px}px ${font}`;
      lines = wrap(g, text, c.width * 0.94);
    };
    fit();
    while (
      (lines.length > 2 || lines.some((l) => g.measureText(l).width > c.width * 0.94)) &&
      px > 56
    ) {
      px -= 4;
      fit();
    }
    if (lines.length === 2) {
      // Greedy wrapping strands one word on the second row; split where the rows are closest.
      const words = text.split(/\s+/).filter(Boolean);
      const limit = c.width * 0.94;
      let best: string[] | null = null;
      let bestGap = Infinity;
      for (let k = 1; k < words.length; k++) {
        const top = words.slice(0, k).join(" ");
        const bottom = words.slice(k).join(" ");
        const w1 = g.measureText(top).width;
        const w2 = g.measureText(bottom).width;
        if (w1 > limit || w2 > limit) continue;
        const gap = Math.abs(w1 - w2);
        if (gap < bestGap) {
          bestGap = gap;
          best = [top, bottom];
        }
      }
      if (best) lines = best;
    }
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    const lineH = px * 1.1;
    const y0 = c.height / 2 - ((lines.length - 1) * lineH) / 2;
    lines.forEach((l, i) => g.fillText(l, c.width / 2, y0 + i * lineH));
    if (!this.textTexture) this.textTexture = new THREE.CanvasTexture(c);
    this.textTexture.needsUpdate = true;
    return { texture: this.textTexture };
  }

  draw(renderer: THREE.WebGLRenderer, f: SceneFrame): void {
    if (!this.fluid) {
      this.fluid = new Fluid(this.w / Math.max(1, this.h), f.mini ? 0.3 : 1);
      this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fluid.displayMaterial);
      this.quad.frustumCulled = false;
      this.scene.add(this.quad);
      this.wordsMaterial = new THREE.ShaderMaterial({
        vertexShader: WORDS_VERTEX,
        fragmentShader: WORDS_FRAGMENT,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uText: { value: null },
          uDye: { value: null },
          uVel: { value: null },
          uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
          uSize: { value: new THREE.Vector2(0.01, 0.01) },
          uColor: { value: new THREE.Color() },
          uExposure: { value: 2.3 },
          uLight: { value: 0 },
          uRefract: { value: 0.00006 },
          uAlpha: { value: 0 },
        },
      });
      this.words = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.wordsMaterial);
      this.words.frustumCulled = false;
      this.words.renderOrder = 1;
      this.words.visible = false;
      this.scene.add(this.words);
    }
    const fluid = this.fluid;
    const P = f.palette;
    // a drop's build quickens everything up to the release
    const vigor =
      num(this.settings.vigor, 1) * (f.reduced ? 0.6 : 1) * (1 + 0.8 * (f.drop?.build ?? 0));
    const memory = num(this.settings.memory, 15);
    const aspect = this.w / Math.max(1, this.h);

    // THE VENTS: each band's gas, metered out at a steady rate from its vent along the bottom,
    // and a gentle lift across the frame so it keeps rising and curling
    const dark = toColor(P.bg);
    this.emitAcc += f.dt * EMIT_HZ;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      for (let r = 0; r < 6; r++) {
        const e = ventFor(r, f.bands[r], vigor, Math.random);
        if (!e) continue;
        fluid.splat(
          e.x,
          e.y,
          e.dx,
          e.dy,
          e.radius,
          toColor(registerColor(P, r)),
          (e.ink / EMIT_HZ) * 12,
        );
      }
      fluid.splat(0.5, 0.4, 0, LIFT * vigor, 0.03, dark, 0);
    }
    // THE DRUMS. A kick puffs a low vent (the stereo image leans it toward the side the sound
    // sits), a hi-hat flickers a high one, a snare sends a gust across the frame from alternating
    // sides; without an onset list the strip's transient puffs the loudest band's vent
    const puff = (band: number, strength: number, scale = 1): void => {
      fluid.splat(
        clamp(ventX(band) + 0.1 * f.pan + (Math.random() - 0.5) * 0.04, 0.03, 0.97),
        VENT_INSET + 0.02,
        (Math.random() - 0.5) * 12,
        PUSH * (0.9 + 0.7 * strength) * vigor * scale,
        SPLAT_RADIUS * (1.6 + 1.2 * strength) * scale,
        toColor(registerColor(P, band)),
        0.45 * strength * scale,
      );
    };
    const gust = (strength: number): void => {
      this.handed = this.handed === 1 ? -1 : 1;
      fluid.splat(
        this.handed === 1 ? 0.06 : 0.94,
        0.35 + Math.random() * 0.3,
        this.handed * PUSH * (0.5 + 0.6 * strength) * vigor,
        0,
        0.02,
        dark,
        0,
      );
    };
    const whirl = (strength: number): void => {
      if (this.settings.whirlpools === false || f.reduced || f.now - this.lastWhirl < 1200) return;
      this.lastWhirl = f.now;
      this.handed = this.handed === 1 ? -1 : 1;
      const wp = whirlpoolFor(strength, this.handed, Math.random);
      fluid.vortex(wp.x, wp.y, wp.spin, wp.radius);
      fluid.splat(wp.x + 0.05, wp.y, 0, 0, 0.004, toColor(P.gold), 0.25);
    };
    // a drop: every vent bursts and a gust from below blows the sky clear; a whirlpool and a
    // gold bloom in the middle
    if (f.drop?.onDrop) {
      for (let r = 0; r < 6; r++) puff(r, 1, 1.6);
      fluid.splat(0.5, 0.12, 0, PUSH * 2.5 * vigor, 0.06, dark, 0);
      this.lastWhirl = 0;
      whirl(1);
      fluid.splat(0.5, 0.5, 0, 0, 0.02, toColor(P.gold), 0.6);
    }
    if (f.hitsKnown) {
      for (const hit of f.hits) {
        if (hit.type === "kick") {
          puff(Math.random() < 0.5 ? 0 : 1, hit.strength);
          if (hit.strength >= 0.7) whirl(hit.strength);
        } else if (hit.type === "snare") gust(hit.strength);
        else puff(Math.random() < 0.5 ? 4 : 5, hit.strength, 0.55);
      }
    } else {
      if (f.onset > PULSE_ONSET && f.now - this.lastPulse > 140) {
        this.lastPulse = f.now;
        let top = 0;
        for (let r = 1; r < 6; r++) if (f.bands[r] > f.bands[top]) top = r;
        puff(top, f.onset);
      }
      if (f.onset > WHIRLPOOL_ONSET) whirl(f.onset);
    }
    // THE WORDS, a solid layer over the gas (stamped as ink before, they dissolved into a mess).
    // A new line renders its texture once; each frame the layer reads the latest dye and flow
    const line = this.settings.words !== false && !f.mini && f.lyric ? f.lyric.text : "";
    if (line !== this.shownLine) {
      if (line) {
        this.shownLine = line;
        this.lineSince = f.now;
        const { texture } = this.renderText(line, f.font);
        // the box shows the WHOLE text canvas at the canvas's own proportions, so every line
        // is the same size and shape whatever its length (it used to be sized from the line's
        // width with its height divided by it: a short line grew and stretched tall, the user's
        // word), and narrower than before so the letters read as words, not a wall
        const boxW = 0.72;
        const boxH = boxW * (this.textCanvas.height / this.textCanvas.width) * aspect;
        this.wordsBox = { w: boxW, h: boxH };
        if (this.wordsMaterial) this.wordsMaterial.uniforms.uText.value = texture;
      } else {
        // the line ended: the texture and box stay while the words fade out
        this.shownLine = "";
        this.endedAt = f.now;
      }
    }
    const wordsAlpha = f.reduced
      ? this.shownLine
        ? 1
        : 0
      : this.shownLine
        ? clamp((f.now - this.lineSince) / 350)
        : 1 - clamp((f.now - this.endedAt) / 600);
    const showing = wordsAlpha > 0.01 && !!this.textTexture;
    // the letters are the fluid's solid: the gas flows around them (Fluid.setObstacle), and the
    // water under them holds nothing; without a line every cell is open
    // (the Solid switch, in-mode and off by default, makes the words the fluid's obstacle)
    if (showing && wordsAlpha > 0.5 && this.textTexture && this.settings.solid === true)
      fluid.setObstacle(this.textTexture, 0.5, 0.5, this.wordsBox.w, this.wordsBox.h);
    else fluid.setObstacle(null, 0, 0, 0, 0);
    if (this.words && this.wordsMaterial) {
      const u = this.wordsMaterial.uniforms;
      this.words.visible = showing;
      u.uDye.value = fluid.dyeTexture;
      u.uVel.value = fluid.velocityTexture;
      (u.uOrigin.value as THREE.Vector2).set(0.5 - this.wordsBox.w / 2, 0.5 - this.wordsBox.h / 2);
      (u.uSize.value as THREE.Vector2).set(this.wordsBox.w, this.wordsBox.h);
      (u.uColor.value as THREE.Color).copy(
        toColor(P.light ? mix(P.ink, P.accent[1], 0.2) : mix(P.ink, P.gold, 0.25)),
      );
      u.uExposure.value = P.light ? 1.7 : 2.3;
      u.uLight.value = P.light ? 1 : 0;
      u.uAlpha.value = wordsAlpha;
    }
    // the stir: the pointer's motion pushes the water where it passes
    const p = this.pointer;
    if (this.settings.stir !== false && p) {
      if (this.lastPointer) {
        const dx = p.x - this.lastPointer.x;
        const dy = p.y - this.lastPointer.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.5) {
          fluid.splat(
            p.x / this.w,
            1 - p.y / this.h,
            dx * 5,
            -dy * 5,
            0.0035,
            toColor(P.ink),
            p.down ? 0.08 : 0,
          );
        }
      }
      this.lastPointer = { x: p.x, y: p.y };
    } else this.lastPointer = null;

    fluid.setWater(toColor(P.bg), P.light);
    fluid.setExposure(P.light ? 1.7 : 2.3);
    fluid.step(renderer, Math.min(f.dt, 1 / 30), {
      ...DEFAULT_PARAMS,
      dyeDissipation: dyeDissipation(memory),
    });
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }
}
