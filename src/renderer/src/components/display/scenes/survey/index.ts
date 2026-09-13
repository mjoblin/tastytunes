import * as THREE from "three";
import type {
  SceneFrame,
  SceneKey,
  SceneRecord,
  SceneSettingDef,
  SceneSettings,
  ThreeScene,
} from "../types";
import { easeTowards } from "../../clock";
import { PresenceTracker } from "../../presence";
import {
  deepDispose,
  projectToScreen,
  recordTexture,
  toColor,
  type RecordTexture,
} from "../../three";
import { typePx, sceneFont } from "../../type";
import { clamp, fitText, mix, rgba } from "../lib";
import { WeatherState } from "../weather";
import {
  COLUMNS,
  CONTOUR_STEP,
  LANES,
  MAP_DEPTH,
  MAP_WIDTH,
  RELIEF_HEIGHT,
  driftRecord,
  xOfSeconds,
} from "./model";

/**
 * SURVEY, shown as CONTOUR (renamed 2026-09-08; the id and the file keep the old name so
 * saved settings still resolve).
 *
 * SURVEY: the map of the song (after packscape's Survey, in this app's
 * voice). The whole track is ground, laid left to right like a timeline; the
 * six registers are ranges receding from the bass in front to the air
 * behind; a contour line at every eighth of full scale in the range's own
 * color from the art, a heavier one every fourth; a faint graticule every
 * ten seconds and every minute. The gold now-line sweeps across and LIGHTS
 * the land as it passes: what is played is lit, what is to come waits in
 * the dusk. The camera sways gently over it; the lines are flags planted
 * along the front edge at their times, and the sections shade the ground.
 */
export const SURVEY_KEY: SceneKey = {
  reads: [
    { shows: "The ground", means: "The whole track, from left to right" },
    {
      shows: "Six mountain ranges, front to back",
      means: "Bass at the front to highs at the back. A range's height is that band's level",
    },
    {
      shows: "Contour lines",
      means: "One for every eighth of the full height, heavier at every half",
    },
    {
      shows: "The gold line",
      means: "Your position. The land behind it is lit and the land ahead is dark",
    },
    {
      shows: "Flags along the front edge",
      means:
        "The lyrics, each where it is sung. The gold one is the line being sung and older ones fade",
    },
    { shows: "Shaded stretches of ground", means: "The track's sections, warmer for a chorus" },
    {
      shows: "The weather",
      means:
        "The section playing. The ground is warmer and the sky brighter in a chorus, and the far ranges misty in a quiet passage",
    },
  ],
  honesty: [
    "Each band is scaled to its own loudest moment in the track, so a quiet track still has mountains.",
  ],
};

export const SURVEY_SETTINGS: SceneSettingDef[] = [
  { key: "relief", label: "Relief", kind: "slider", min: 0.5, max: 2, step: 0.1, default: 1 },
  { key: "sway", label: "Sway", kind: "toggle", default: true },
  { key: "contours", label: "Contours", kind: "toggle", default: true },
];

const VERTEX = /* glsl */ `
uniform sampler2D uHeights;
uniform float uRelief;
uniform vec2 uSize;
varying vec3 vWorld;
varying float vHeight;
varying vec3 vNormal;
varying float vLane;
void main() {
  vec2 uv = vec2(position.x / uSize.x, 1.0 - position.z / uSize.y);
  float h = texture2D(uHeights, uv).r;
  float texel = 1.0 / 400.0;
  float hx = texture2D(uHeights, uv + vec2(texel, 0.0)).r - texture2D(uHeights, uv - vec2(texel, 0.0)).r;
  float hz = texture2D(uHeights, uv + vec2(0.0, texel * 2.0)).r - texture2D(uHeights, uv - vec2(0.0, texel * 2.0)).r;
  vec3 displaced = vec3(position.x, h * uRelief, position.z);
  vWorld = displaced;
  vHeight = h;
  vLane = uv.y;
  vNormal = normalize(vec3(-hx * uRelief / (texel * 2.0 * uSize.x), 1.0, -hz * uRelief / (texel * 4.0 * uSize.y)));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}`;

const FRAGMENT = /* glsl */ `
// common carries rand(), which the dithering chunk calls; ShaderMaterial includes nothing by itself
#include <common>
#include <dithering_pars_fragment>
uniform vec3 uBg;
uniform vec3 uInk;
uniform vec3 uGold;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
uniform float uNowX;
uniform float uLight;
uniform float uBounds[24];
uniform float uKinds[25];
uniform float uBoundCount;
uniform float uRelease;
uniform float uContours;
uniform float uStep;
uniform float uSecondsPerUnit;
uniform vec2 uSize;
uniform vec3 uCamera;
uniform vec4 uWeather;
uniform vec3 uFog;
varying vec3 vWorld;
varying float vHeight;
varying vec3 vNormal;
varying float vLane;
void main() {
  // the range's own color: bass wears the first accent, the middle the second, air the third
  vec3 hue = vLane < 0.5 ? mix(uA, uB, vLane * 2.0) : mix(uB, uC, (vLane - 0.5) * 2.0);
  // ground: the faceplate's near-black or the paper, hill-shaded from a low warm sun
  vec3 sun = normalize(vec3(-0.5, 0.55, 0.7));
  float shade = clamp(dot(normalize(vNormal), sun), 0.0, 1.0);
  vec3 ground = mix(uBg, mix(uInk, hue, 0.6), (0.16 + 0.3 * vHeight) * (1.0 - uLight) + uLight * (0.12 + 0.3 * vHeight));
  ground = mix(ground, mix(ground, uGold, 0.35), shade * 0.55 * (1.0 - uLight));
  ground = mix(ground, mix(ground, uInk, 0.35), shade * 0.45 * uLight);
  // contours in the range's color, heavier every fourth
  float level = vHeight / uStep;
  float f = fract(level);
  float band = smoothstep(0.0, 0.05, min(f, 1.0 - f));
  float fourth = step(0.5, fract(floor(level + 0.5) / 4.0 + 0.125) * 0.0 + (mod(floor(level + 0.5), 4.0) < 0.5 ? 1.0 : 0.0));
  float line = (1.0 - band) * step(0.02, vHeight) * uContours;
  ground = mix(ground, mix(hue, uInk, 0.15), line * (0.45 + 0.4 * fourth));
  // the graticule: every ten seconds faint, every minute a little more
  float secs = vWorld.x * uSecondsPerUnit;
  float g10 = 1.0 - smoothstep(0.0, 0.9, abs(fract(secs / 10.0) - 0.5) * 10.0 * 0.18);
  float g60 = 1.0 - smoothstep(0.0, 0.9, abs(fract(secs / 60.0) - 0.5) * 60.0 * 0.04);
  ground = mix(ground, uInk, (g10 * 0.05 + g60 * 0.1) * (1.0 - vHeight * 0.6));
  // the sections: alternate shading, warmer where the chorus is, a hairline at each edge
  float sec = 0.0;
  float edge = 0.0;
  for (int i = 0; i < 24; i++) {
    if (float(i) < uBoundCount) {
      if (vWorld.x > uBounds[i]) sec += 1.0;
      edge = max(edge, 1.0 - smoothstep(0.0, 5.0, abs(vWorld.x - uBounds[i])));
    }
  }
  float kind = 0.0;
  for (int i = 0; i < 25; i++) if (abs(float(i) - sec) < 0.5) kind = uKinds[i];
  ground = mix(ground, uGold, kind * 0.09 * (1.0 - uLight * 0.5));
  ground = mix(ground, uInk, mod(sec, 2.0) * 0.035 + edge * 0.2);
  // the weather at now (scenes/weather): warmth toward gold, a glow, eased across the boundaries
  ground = mix(ground, uGold, uWeather.x * 0.07 * (1.0 - uLight * 0.4));
  ground *= 0.9 + 0.2 * uWeather.y;
  // now: the gold line, and the light it leaves behind
  float ahead = smoothstep(uNowX - 24.0, uNowX + 24.0, vWorld.x);
  float dusk = mix(1.0, 0.55, ahead);
  ground *= mix(dusk, 1.0, uLight * 0.6);
  float nowGlow = exp(-abs(vWorld.x - uNowX) * 0.012);
  ground += uGold * nowGlow * (0.3 + 0.5 * uRelease) * (1.0 - uLight * 0.5);
  float nowLine = 1.0 - smoothstep(1.5, 5.0, abs(vWorld.x - uNowX));
  ground = mix(ground, uGold, nowLine * 0.9);
  // fog toward the far ranges, nearer in the weather's haze, in the sky's color
  float dist = distance(vWorld, uCamera);
  float haze = uWeather.z;
  float fog = smoothstep(1900.0 - 1000.0 * haze, 3600.0 - 1300.0 * haze, dist);
  gl_FragColor = vec4(mix(ground, uFog, fog), 1.0);
  #include <dithering_fragment>
}`;

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** THE MAP'S WIDTH IS THE PICTURE. The 38° field is the wall's, at 16:9, where the whole
 *  range fits across; a squarer canvas (the Now Playing tile) keeps that horizontal field
 *  and opens the vertical one to match, rather than cropping the ends of the range (the
 *  user, 2026-09-12: "contour currently doesn't fit in the square tile"). */
const FOV_WIDE = 38;
const WIDE_ASPECT = 16 / 9;
const HALF_WIDTH_TAN = Math.tan(((FOV_WIDE / 2) * Math.PI) / 180) * WIDE_ASPECT;
const fovFor = (aspect: number): number =>
  aspect >= WIDE_ASPECT ? FOV_WIDE : (2 * Math.atan(HALF_WIDTH_TAN / aspect) * 180) / Math.PI;

export class Survey implements ThreeScene {
  readonly kind = "three" as const;
  settings: SceneSettings = {};
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV_WIDE, 1, 10, 6000);
  private material: THREE.ShaderMaterial | null = null;
  private ground: THREE.Mesh | null = null;
  private tex: RecordTexture | null = null;
  private texFor: SceneRecord | null = null;
  private drift = driftRecord();
  private phase = 0;
  private relief = 1;
  private nowX = 0;
  private names = new PresenceTracker(700, 1400);
  private tmp = new THREE.Vector3();
  /** The section's weather (scenes/weather), eased. */
  private weather = new WeatherState();

  init(renderer: THREE.WebGLRenderer, w: number, h: number): void {
    void renderer;
    const geometry = new THREE.PlaneGeometry(MAP_WIDTH, MAP_DEPTH, 400, LANES * 12);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(MAP_WIDTH / 2, 0, MAP_DEPTH / 2);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      // dithered: the dusk beyond the now-line runs into near-black, where 8-bit banding shows
      dithering: true,
      uniforms: {
        uHeights: { value: null },
        uRelief: { value: RELIEF_HEIGHT },
        uSize: { value: new THREE.Vector2(MAP_WIDTH, MAP_DEPTH) },
        uBg: { value: new THREE.Color(0, 0, 0) },
        uInk: { value: new THREE.Color(1, 1, 1) },
        uGold: { value: new THREE.Color(1, 0.7, 0.3) },
        uA: { value: new THREE.Color() },
        uB: { value: new THREE.Color() },
        uC: { value: new THREE.Color() },
        uNowX: { value: 0 },
        uLight: { value: 0 },
        uContours: { value: 1 },
        uStep: { value: CONTOUR_STEP },
        uSecondsPerUnit: { value: 1 },
        uBounds: { value: new Float32Array(24) },
        uKinds: { value: new Float32Array(25) },
        uBoundCount: { value: 0 },
        uRelease: { value: 0 },
        uCamera: { value: new THREE.Vector3() },
        uWeather: { value: new THREE.Vector4() },
        uFog: { value: new THREE.Color() },
      },
    });
    this.ground = new THREE.Mesh(geometry, this.material);
    this.scene.add(this.ground);
    this.resize(w, h);
  }

  resize(w: number, h: number): void {
    const aspect = w / Math.max(1, h);
    this.camera.aspect = aspect;
    this.camera.fov = fovFor(aspect);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    deepDispose(this.scene);
    this.tex?.texture.dispose();
    this.tex = null;
    this.texFor = null;
  }

  private ensureTexture(record: SceneRecord): RecordTexture {
    if (this.tex && this.texFor === record) return this.tex;
    this.tex?.texture.dispose();
    this.tex = recordTexture(record, COLUMNS);
    this.texFor = record;
    return this.tex;
  }

  /** The record's seconds: the track's duration when known, else the strip's own length. */
  private seconds(f: SceneFrame, tex: RecordTexture): number {
    return f.record ? (f.duration ?? tex.seconds) : (f.duration ?? 240);
  }

  draw(renderer: THREE.WebGLRenderer, f: SceneFrame): void {
    const m = this.material;
    if (!m) return;
    const P = f.palette;
    const record = f.record ?? this.drift;
    const tex = this.ensureTexture(record);
    const seconds = this.seconds(f, tex);
    const speed = f.reduced ? 0.3 : 1;
    this.phase += f.dt * speed;
    this.relief = easeTowards(this.relief, num(this.settings.relief, 1), f.dt, 0.6);
    // the now-line follows the smooth clock
    this.nowX = xOfSeconds(f.position, seconds);

    // the camera: in front of the bass range, looking across the map, swaying
    const sway =
      this.settings.sway !== false && !f.reduced ? Math.sin(this.phase * 0.09) * 0.12 : 0;
    const target = new THREE.Vector3(MAP_WIDTH * 0.5, 20, MAP_DEPTH * 0.5);
    const radius = 1480;
    const elevation = 0.62 + 0.04 * Math.sin(this.phase * 0.061);
    this.camera.position.set(
      target.x + Math.sin(sway) * radius,
      target.y + elevation * radius,
      target.z + Math.cos(sway) * radius,
    );
    this.camera.lookAt(target);

    const u = m.uniforms;
    u.uHeights.value = tex.texture;
    u.uRelief.value = RELIEF_HEIGHT * this.relief;
    (u.uBg.value as THREE.Color).copy(toColor(P.bg));
    (u.uInk.value as THREE.Color).copy(toColor(P.ink));
    (u.uGold.value as THREE.Color).copy(toColor(P.gold));
    (u.uA.value as THREE.Color).copy(toColor(P.accent[0]));
    (u.uB.value as THREE.Color).copy(toColor(P.accent[1]));
    (u.uC.value as THREE.Color).copy(toColor(P.accent[2]));
    u.uNowX.value = this.nowX;
    u.uRelease.value = f.drop?.release ?? 0;
    // the sections, as world x of their edges and a kind per section
    const bounds = u.uBounds.value as Float32Array;
    const kinds = u.uKinds.value as Float32Array;
    const secs = f.sections;
    const nb = Math.min(24, Math.max(0, secs.length - 1));
    for (let i = 0; i < 24; i++) bounds[i] = i < nb ? xOfSeconds(secs[i + 1].start, seconds) : 1e9;
    for (let i = 0; i < 25; i++) kinds[i] = secs[i]?.kind === "chorus" ? 1 : 0;
    u.uBoundCount.value = nb;
    u.uLight.value = P.light ? 1 : 0;
    u.uContours.value = this.settings.contours === false ? 0 : 1;
    u.uSecondsPerUnit.value = seconds / MAP_WIDTH;
    (u.uCamera.value as THREE.Vector3).copy(this.camera.position);
    // the weather: the sky (the clear color) and the fog brighten with the section's glow
    const W = this.weather.step(f);
    (u.uWeather.value as THREE.Vector4).set(W.warm, W.glow, W.haze, W.stars);
    const fogCol = mix(P.bg, P.accent[0], W.glow * (P.light ? 0.08 : 0.14));
    (u.uFog.value as THREE.Color).copy(toColor(fogCol));
    renderer.setClearColor(toColor(fogCol), 1);
    renderer.render(this.scene, this.camera);
  }

  overlay(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P } = f;
    const tex = this.tex;
    if (!tex) return;
    const seconds = this.seconds(f, tex);
    ctx.textBaseline = "alphabetic";
    // (the minute marks along the near edge are gone: the user found them meaningless here)

    // the lines as FLAGS along the front edge: each planted at its time on a post, the one
    // being heard gold and larger, the past fading behind the now-line (no future flags); a
    // flag that would print through one already placed waits (the current never waits)
    if (f.lyric) {
      const { lines, index, text } = f.lyric;
      this.names.step(text ? [String(index)] : [], f.dt);
      const drawn: Array<{ x: number; right: number; y: number }> = [];
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
      const near = lines
        .map((ln, i) => ({ ln, i }))
        // the lines already sung and the one being heard; the future's flags are gone (the user:
        // "their behavior is still too confusing in this screen")
        .filter(
          ({ ln, i }) =>
            ln.text && ln.t - f.position > -40 && (ln.t <= f.position + 0.05 || i === index),
        );
      near.sort((a, b) => (a.i === index ? -1 : b.i === index ? 1 : a.i - b.i));
      const small = typePx(f, "small") * 0.95;
      const body = typePx(f, "body");
      for (const { ln, i } of near) {
        const g = this.names.get(String(i));
        const d = ln.t - f.position;
        const post = 30 + 30 * g + (i % 2) * 24;
        const x = xOfSeconds(ln.t, seconds);
        const base = projectToScreen(this.tmp.set(x, 2, MAP_DEPTH + 40), this.camera, w, h);
        const top = projectToScreen(this.tmp.set(x, post, MAP_DEPTH + 40), this.camera, w, h);
        if (!base || !top) continue;
        // the flag is laid out ONCE at its full size, the size it reaches when heard: wrapped
        // there it never reflows as it grows, and its footprint for the collision test is its
        // final one, so a neighbour that would meet it is held back from the start instead of
        // popping in and out while it grows (the user: the future lyrics "move and jerk around
        // a lot when the current lyric zooms in"). A long line wraps to two, never an ellipsis
        const full = fitText(ctx, ln.text, {
          maxWidth: w * 0.26,
          maxPx: body,
          minPx: body * 0.8,
          maxLines: 2,
          weight: 500,
          family: f.font,
        });
        const px = (full.px * (small + (body - small) * g)) / body;
        sceneFont(ctx, f, px, g > 0.5 ? 500 : 400);
        const fit = full;
        const rows = full.lines.length;
        // the line being heard claims its final footprint from its first frame; the others claim
        // only what they draw, so the map stays as full of flags as it was
        const footPx = i === index ? full.px : px;
        const width = (full.width * footPx) / full.px;
        // a flag planted near the song's end would print past the frame: its text is pinned
        // so its full-size right edge stays inside the margin, the post still at its time
        // (the user: "the lyrics near the end of the song can go off screen")
        const left = Math.min(top.x + 5, w - 28 - full.width);
        if (
          g < 0.5 &&
          drawn.some(
            (o) =>
              Math.abs(o.y - top.y) < footPx * 1.3 * rows &&
              left < o.right + 12 &&
              left + width > o.x - 12,
          )
        )
          continue;
        drawn.push({ x: left, right: left + width + 6, y: top.y });
        // the line being heard keeps its approach alpha under the gold: judged as past the
        // instant it began, it dropped to 0.14 and climbed back with the gold (the same dip
        // the user saw in Terrain)
        const ahead = d >= 0 || i === index;
        const dist = ahead ? clamp(1 - Math.max(0, d) / 90) : clamp(1 + d / 40);
        const alpha = (ahead ? 0.2 + 0.35 * dist : 0.14 * dist) * (1 - g) + g;
        const color = mix(P.ink, P.gold, g);
        ctx.strokeStyle = rgba(color, alpha * 0.6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(top.x, top.y);
        ctx.stroke();
        ctx.fillStyle = rgba(color, alpha);
        fit.lines.forEach((l, k) => ctx.fillText(l, left, top.y - 3 - (rows - 1 - k) * px * 1.15));
      }
    }
  }
}
