import * as THREE from "three";
import type { SceneFrame, SceneKey, SceneSettingDef, SceneSettings, ThreeScene } from "../types";
import { easeTowards } from "../../clock";
import { PresenceTracker } from "../../presence";
import { deepDispose, toColor } from "../../three";
import { sceneFont, typePx } from "../../type";
import { clamp, fitText, mix, rgba } from "../lib";
import {
  CHOP_TAU,
  COLS,
  CREST_TAU,
  EYE_HEIGHT,
  GLINT_TAU,
  HALO_TAU,
  HIT_REFRACTORY_MS,
  HIT_THRESHOLD,
  MINI_COLS,
  MINI_ROWS,
  MOON_DIR,
  ROWS,
  SURGE_TAU,
  SWELL_TAU,
  TRAINS,
  WARM_TAU,
  seaPatch,
  waveSpeed,
} from "./model";

/** How fast the surge follows a kick: a sea takes a moment to heave. */
const SURGE_RISE = 0.18;

/**
 * SEA: Tide's sibling in three dimensions (after ThreeUI's Tideform and
 * Emberline, which are previews only; the technique is public). An open sea
 * from a low deck: three long swells and three chops, Gerstner wave trains
 * crossed in a vertex shader over a patch that reaches the horizon, rolling
 * toward you. The swell's height is how loud, slowly; the chop is how
 * noisy the sound is; a kick heaves the swell and a drop heaves it more. A
 * moon sits low ahead and its glade of glints runs down the water: the
 * glints are micro-facets the moon catches, and they fire on the hats; a
 * snare lights the crests. The horizon dissolves into the sky's color, the
 * dark gradient dithered. The current line rides above the water.
 */
export const SEA_KEY: SceneKey = {
  reads: [
    {
      shows: "The swell",
      means: "the overall loudness, following slowly. A kick heaves it and a drop heaves it more",
    },
    { shows: "The chop", means: "how noisy the sound is" },
    {
      shows: "The moon",
      means: "low on the horizon, with its reflection running down the water toward you",
    },
    { shows: "Glints in the reflection", means: "hi-hats. A snare lights the wave crests" },
    { shows: "The water's warmth", means: "a chorus" },
    { shows: "Words over the water", means: "the current lyric, with the next line waiting below" },
  ],
  honesty: [
    "The waves are a picture, not the waveform. Only the loudness and the noisiness move the water.",
  ],
};

export const SEA_SETTINGS: SceneSettingDef[] = [
  { key: "words", label: "Words", kind: "toggle", default: true },
  { key: "sway", label: "Sway", kind: "toggle", default: true },
];

/** The trains unrolled into the vertex shader: a Gerstner sum with its analytic normal. Each
 *  train's horizontal reach (Q·A) is its share of the sharpening budget over the count, so the
 *  crests never loop however the amplitudes move. Chops fade with distance, where the patch's
 *  rows are too sparse to carry them. */
const TRAIN_GLSL = TRAINS.map((t, i) => {
  const len = Math.hypot(t.dir[0], t.dir[1]);
  const k = (2 * Math.PI) / t.length;
  const w = k * waveSpeed(t.length);
  const scale = t.kind === "swell" ? "uSwell" : "uChop * chopAtten";
  return /* glsl */ `
  {
    vec2 D = vec2(${(t.dir[0] / len).toFixed(5)}, ${(t.dir[1] / len).toFixed(5)});
    float k = ${k.toFixed(6)};
    float A = ${t.amp.toFixed(4)} * ${scale};
    float f = k * dot(D, position.xz) - ${w.toFixed(6)} * uTime + ${(i * 1.7).toFixed(2)};
    float C = cos(f);
    float S = sin(f);
    float QA = ${(t.steep / TRAINS.length).toFixed(4)} / k;
    P.x += D.x * QA * C;
    P.z += D.y * QA * C;
    P.y += A * S;
    N.x -= D.x * k * A * C;
    N.z -= D.y * k * A * C;
    N.y -= k * QA * S;
  }`;
}).join("\n");

const SEA_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSwell;
uniform float uChop;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vHeight;
void main() {
  vec3 P = position;
  vec3 N = vec3(0.0, 1.0, 0.0);
  float chopAtten = 1.0 - smoothstep(50.0, 170.0, length(position.xz));
  ${TRAIN_GLSL}
  vWorld = P;
  vNormal = N;
  vHeight = P.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(P, 1.0);
}`;

const SEA_FRAGMENT = /* glsl */ `
// common carries rand(), which the dithering chunk calls; ShaderMaterial includes nothing by itself
#include <common>
#include <dithering_pars_fragment>
uniform vec3 uGold;
uniform vec3 uWater;
uniform vec3 uDeep;
uniform vec3 uHorizon;
uniform vec3 uMoon;
uniform vec3 uEye;
uniform float uLight;
uniform float uGlint;
uniform float uSharp;
uniform float uTime;
uniform float uWarm;
uniform float uCrest;
uniform float uMoonLight;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vHeight;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec3 N = normalize(vNormal);
  float dist = length(vWorld.xz);
  // the wind's cat's-paws: two octaves of smooth noise drifting over the water tilt the normal a
  // little, so the moon's glade breaks up the way a real one does; a hat roughens them for a moment
  vec2 rp = vWorld.xz * 1.6 + vec2(uTime * 0.35, -uTime * 0.5);
  float n1 = vnoise(rp) - 0.5;
  float n2 = vnoise(rp * 2.7 + 11.0) - 0.5;
  float n3 = vnoise(rp.yx * 1.9 - 5.0) - 0.5;
  vec2 tilt = vec2(n1 + 0.5 * n2, n3 + 0.5 * n2) * (0.12 + 0.12 * uGlint);
  N = normalize(N + vec3(tilt.x, 0.0, tilt.y));
  vec3 V = normalize(uEye - vWorld);
  vec3 L = normalize(uMoon);
  float s = max(dot(reflect(-L, N), V), 0.0);
  // the glint is a tight exponential lobe, the glade a broad one: no pow()
  float glint = exp(-(1.0 - s) * uSharp);
  float glade = exp(-(1.0 - s) * 12.0);
  // the glints that FIRE: a fine lattice of facets a few pixels wide, laid on the SCREEN (a
  // lattice in world units scaled by distance is a projection and degenerates into stripes),
  // re-rolled a few times a second, a few of them catching the moon each moment inside the
  // glade and many more on a hat
  vec2 gc = floor(gl_FragCoord.xy / 6.0);
  float gr = hash(gc + floor(uTime * 6.0) * 0.37);
  // a soft dot in its cell, only where the facet all but faces the moon, a few percent of them
  float dotIn = 1.0 - smoothstep(0.12, 0.45, length(fract(gl_FragCoord.xy / 6.0) - 0.5));
  float facing = exp(-(1.0 - s) * 36.0);
  float fire = step(0.985 - 0.06 * uGlint, gr) * dotIn * facing * smoothstep(4.0, 25.0, dist);
  float lit = max(dot(N, L), 0.0);
  float crest = smoothstep(-0.6, 2.2, vHeight);
  vec3 water = mix(uDeep, uWater, 0.3 + 0.7 * crest);
  water = mix(water, uGold, uWarm * 0.1);
  vec3 col = water * (0.6 + 0.4 * lit) + uWater * uCrest * crest * 0.35;
  col += uGold * uMoonLight * (glade * 0.22 + glint * (0.6 + 1.2 * uGlint) + fire * (0.5 + 1.5 * uGlint));
  // the horizon dissolves into the sky
  float fog = smoothstep(120.0, 430.0, dist);
  gl_FragColor = vec4(mix(col, uHorizon, fog), 1.0);
  #include <dithering_fragment>
}`;

// THE SKY: a full-screen quad at the far plane, colored by the view direction (reconstructed
// from the inverse projection-view), so the horizon's glow, the moon and the stars sit where
// the camera's pitch puts them and the sea always covers what is below the horizon.
const SKY_VERTEX = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.99999, 1.0);
}`;

const SKY_FRAGMENT = /* glsl */ `
#include <common>
#include <dithering_pars_fragment>
uniform mat4 uInvPV;
uniform vec3 uEye;
uniform vec3 uMoon;
uniform vec3 uBg;
uniform vec3 uInk;
uniform vec3 uHorizon;
uniform vec3 uMoonCol;
uniform float uHalo;
uniform float uLight;
uniform float uTime;
uniform float uStars;
varying vec2 vNdc;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec4 w = uInvPV * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(w.xyz / w.w - uEye);
  float el = dir.y;
  // the glow on the horizon fades up into the faceplate (or the paper)
  vec3 col = mix(uHorizon, uBg, smoothstep(0.0, 0.42, el));
  // stars on the faceplate only: one to a cell of the sky, placed within it, each with its
  // own slow twinkle, thinning toward the horizon
  vec2 sp = dir.xy / max(0.2, dir.z) * 40.0;
  vec2 cell = floor(sp);
  float r = hash(cell);
  vec2 at = fract(sp) - vec2(hash(cell + 1.1), hash(cell + 2.2));
  float star = (1.0 - smoothstep(0.0, 0.09, length(at))) * step(0.93, r);
  star *= 0.55 + 0.45 * sin(uTime * (1.0 + 2.0 * r) + r * 40.0);
  star *= smoothstep(0.0, 0.15, el) * uStars;
  col += uInk * star * 0.7;
  // the moon: a disc with a soft edge and an exponential halo that flares on a drop
  float cosA = dot(dir, normalize(uMoon));
  float ang = acos(clamp(cosA, -1.0, 1.0));
  float disc = 1.0 - smoothstep(0.03, 0.036, ang);
  float halo = exp(-ang * 7.0) * (0.35 + 0.65 * uHalo);
  col = mix(col, uMoonCol, disc);
  col += uMoonCol * halo * mix(0.45, 0.2, uLight);
  // below the horizon the sea covers this; the seam wears the horizon's own color
  col = mix(uHorizon, col, smoothstep(-0.01, 0.005, el));
  gl_FragColor = vec4(col, 1.0);
  #include <dithering_fragment>
}`;

export class Sea implements ThreeScene {
  readonly kind = "three" as const;
  settings: SceneSettings = {};
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.5, 900);
  private material: THREE.ShaderMaterial | null = null;
  private skyMaterial: THREE.ShaderMaterial | null = null;
  private sea: THREE.Mesh | null = null;
  private mini: boolean | null = null;
  private phase = 0;
  /** The water's state, eased: the swell and the chop follow the music, the rest are the drums. */
  private swell = 0.5;
  private chop = 0.4;
  private surge = 0;
  /** Where the surge is heading: a kick sets it, it decays, and `surge` follows with a rise
   *  time, because a sea takes a moment to heave (set directly, the whole sea's height popped
   *  on every kick; the user: "the water animation pops quite a lot"). */
  private surgeAim = 0;
  private glint = 0;
  private crest = 0;
  private halo = 0;
  private warm = 0;
  private lastHit = 0;
  private prevHighs = 0;
  private invPV = new THREE.Matrix4();
  private eye = new THREE.Vector3();
  private moon = new THREE.Vector3(...MOON_DIR).normalize();
  private words = new PresenceTracker(600, 900);

  init(renderer: THREE.WebGLRenderer, w: number, h: number): void {
    void renderer;
    this.material = new THREE.ShaderMaterial({
      vertexShader: SEA_VERTEX,
      fragmentShader: SEA_FRAGMENT,
      side: THREE.DoubleSide,
      // dithered: the water runs a long way into the dark, where 8-bit banding shows
      dithering: true,
      uniforms: {
        uTime: { value: 0 },
        uSwell: { value: 0.5 },
        uChop: { value: 0.4 },
        uGold: { value: new THREE.Color() },
        uWater: { value: new THREE.Color() },
        uDeep: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uMoon: { value: this.moon.clone() },
        uEye: { value: new THREE.Vector3() },
        uLight: { value: 0 },
        uGlint: { value: 0 },
        uSharp: { value: 260 },
        uWarm: { value: 0 },
        uCrest: { value: 0 },
        uMoonLight: { value: 1 },
      },
    });
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      dithering: true,
      uniforms: {
        uInvPV: { value: new THREE.Matrix4() },
        uEye: { value: new THREE.Vector3() },
        uMoon: { value: this.moon.clone() },
        uBg: { value: new THREE.Color() },
        uInk: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uMoonCol: { value: new THREE.Color() },
        uHalo: { value: 0 },
        uLight: { value: 0 },
        uTime: { value: 0 },
        uStars: { value: 1 },
      },
    });
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.skyMaterial);
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    this.scene.add(sky);
    this.resize(w, h);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    deepDispose(this.scene);
    this.sea = null;
  }

  /** The patch, built once the frame says whether this is a tile or the stage. */
  private ensurePatch(mini: boolean): void {
    if (this.sea && this.mini === mini) return;
    if (this.sea) {
      this.scene.remove(this.sea);
      this.sea.geometry.dispose();
      this.sea = null;
    }
    if (!this.material) return;
    const patch = mini ? seaPatch(MINI_ROWS, MINI_COLS) : seaPatch(ROWS, COLS);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(patch.position, 3));
    geometry.setIndex(new THREE.BufferAttribute(patch.index, 1));
    this.sea = new THREE.Mesh(geometry, this.material);
    // the shader displaces the rows; the flat patch's bounds would cull its crests at the edges
    this.sea.frustumCulled = false;
    this.scene.add(this.sea);
    this.mini = mini;
  }

  draw(renderer: THREE.WebGLRenderer, f: SceneFrame): void {
    const m = this.material;
    const sky = this.skyMaterial;
    if (!m || !sky) return;
    const P = f.palette;
    this.ensurePatch(f.mini);
    const speed = f.reduced ? 0.35 : 1;
    this.phase += f.dt * speed;
    const highs = (f.bands[4] + f.bands[5]) / 2;

    // the swell is how loud, slowly; the chop is how noisy; a kick heaves the swell, a hat
    // fires the glints, a snare lights the crests; a drop heaves the whole sea and flares the
    // moon. Without an onset list the strip's transient (with treble in it) does the work.
    const treble = highs - this.prevHighs;
    this.prevHighs = highs;
    if (f.hitsKnown) {
      for (const h of f.hits) {
        if (h.type === "kick") this.surgeAim = Math.max(this.surgeAim, h.strength);
        else if (h.type === "snare") this.crest = Math.max(this.crest, 0.3 + 0.7 * h.strength);
        else this.glint = Math.max(this.glint, 0.35 + 0.65 * h.strength);
      }
    } else {
      const hit = Math.max(f.onset, f.kick);
      if (hit > HIT_THRESHOLD && f.now - this.lastHit > HIT_REFRACTORY_MS) {
        this.lastHit = f.now;
        this.surgeAim = Math.max(this.surgeAim, hit);
        if (treble > 0.1 || highs > 0.4) this.glint = Math.max(this.glint, hit);
      }
    }
    if (f.drop?.onDrop) {
      this.surgeAim = Math.max(this.surgeAim, 1.6);
      this.halo = 1;
      this.crest = 1;
    }
    this.swell = easeTowards(this.swell, 0.3 + 0.9 * f.slowLoud, f.dt, SWELL_TAU);
    this.chop = easeTowards(this.chop, 0.2 + 1.0 * f.noisiness, f.dt, CHOP_TAU);
    this.surgeAim = easeTowards(this.surgeAim, 0, f.dt, SURGE_TAU);
    this.surge = easeTowards(this.surge, this.surgeAim, f.dt, SURGE_RISE);
    this.glint = easeTowards(this.glint, 0, f.dt, GLINT_TAU);
    this.crest = easeTowards(this.crest, 0, f.dt, CREST_TAU);
    this.halo = easeTowards(this.halo, 0, f.dt, HALO_TAU);
    this.warm = easeTowards(this.warm, f.section?.kind === "chorus" ? 1 : 0, f.dt, WARM_TAU);
    // a kick heaves the sea a little, on top of the slow swell (was half its strength, instantly)
    const swell = this.swell + 0.15 * this.surge;

    // the eye on the deck: it heaves with the SLOW swell and rolls a little (never with the
    // kicks, which read as the camera jolting), never under reduced motion
    const live = this.settings.sway !== false && !f.reduced ? 1 : 0;
    const t = this.phase;
    const heave = live * 0.35 * this.swell * Math.sin(t * 0.55);
    const roll = live * 0.02 * this.swell * Math.sin(t * 0.4 + 0.7);
    this.eye.set(0, EYE_HEIGHT + heave, 0);
    this.camera.up.set(Math.sin(roll), Math.cos(roll), 0);
    this.camera.position.copy(this.eye);
    this.camera.lookAt(0, EYE_HEIGHT - 3.2, 60);
    this.camera.updateMatrixWorld();
    this.invPV.multiplyMatrices(this.camera.matrixWorld, this.camera.projectionMatrixInverse);

    // the colors: the water wears the art's second color (Tide's rule), the horizon the first
    const water = P.light ? mix(P.accent[1], P.bg, 0.45) : P.accent[1];
    const deep = mix(water, P.bg, P.light ? 0.6 : 0.78);
    const horizon = mix(P.bg, P.accent[0], (P.light ? 0.1 : 0.12) + 0.2 * f.slowLoud);
    const moonCol = P.light ? P.gold : mix(P.gold, [255, 255, 255], 0.55);
    const u = m.uniforms;
    u.uTime.value = this.phase;
    u.uSwell.value = swell;
    u.uChop.value = this.chop;
    (u.uGold.value as THREE.Color).copy(toColor(P.gold));
    (u.uWater.value as THREE.Color).copy(toColor(water));
    (u.uDeep.value as THREE.Color).copy(toColor(deep));
    (u.uHorizon.value as THREE.Color).copy(toColor(horizon));
    (u.uEye.value as THREE.Vector3).copy(this.eye);
    u.uLight.value = P.light ? 1 : 0;
    u.uGlint.value = this.glint;
    // a hat broadens the lobe for a moment as well as brightening it
    u.uSharp.value = 260 - 140 * this.glint;
    u.uWarm.value = this.warm;
    u.uCrest.value = this.crest;
    u.uMoonLight.value = (P.light ? 0.55 : 1) * (1 - 0.6 * f.quiet);
    const s = sky.uniforms;
    (s.uInvPV.value as THREE.Matrix4).copy(this.invPV);
    (s.uEye.value as THREE.Vector3).copy(this.eye);
    (s.uBg.value as THREE.Color).copy(toColor(P.bg));
    (s.uInk.value as THREE.Color).copy(toColor(P.ink));
    (s.uHorizon.value as THREE.Color).copy(toColor(horizon));
    (s.uMoonCol.value as THREE.Color).copy(toColor(moonCol));
    s.uHalo.value = clamp(this.halo + 0.3 * f.slowLoud);
    s.uLight.value = P.light ? 1 : 0;
    s.uTime.value = this.phase;
    s.uStars.value = P.light ? 0 : 0.5 + 0.5 * f.quiet;
    renderer.setClearColor(toColor(P.bg), 1);
    renderer.render(this.scene, this.camera);
  }

  overlay(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    if (f.mini || !f.lyric || this.settings.words === false) return;
    const { w, h, palette: P } = f;
    const { text, next, index, lines } = f.lyric;
    const pres = this.words.step(text ? [String(index)] : [], f.dt);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const lead = typePx(f, "lead");
    // over the water, below the horizon, clear of the caption and the clock at the foot
    const baseY = h * 0.72;
    for (const [key, g] of pres) {
      const line = lines[Number(key)]?.text;
      if (!line) continue;
      sceneFont(ctx, f, "lead", 500);
      // a long line wraps to two (never an ellipsis), its last line where the single line sat
      const fit = fitText(ctx, line, {
        maxWidth: w * 0.86,
        maxPx: lead,
        minPx: lead * 0.7,
        maxLines: 2,
        weight: 500,
        family: f.font,
      });
      ctx.fillStyle = rgba(mix(mix(P.ink, P.accent[1], 0.2), P.gold, 0.5), g);
      const y0 = baseY + (1 - g) * 10 - (fit.lines.length - 1) * fit.px * 1.15;
      fit.lines.forEach((l, k) => ctx.fillText(l, w / 2, y0 + k * fit.px * 1.15));
    }
    if (next) {
      sceneFont(ctx, f, "caption", 400);
      ctx.fillStyle = rgba(P.dim, 0.55);
      const cpx = typePx(f, "caption");
      const nf = fitText(ctx, next, {
        maxWidth: w * 0.8,
        maxPx: cpx,
        minPx: cpx * 0.75,
        maxLines: 2,
        weight: 400,
        family: f.font,
      });
      nf.lines.forEach((l, k) => ctx.fillText(l, w / 2, baseY + lead * 1.4 + k * nf.px * 1.2));
    }
    ctx.textAlign = "start";
  }
}
