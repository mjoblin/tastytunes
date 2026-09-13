import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type {
  SceneFrame,
  SceneKey,
  SceneRecord,
  SceneSettingDef,
  SceneSettings,
  ThreeScene,
} from "../types";
import { easeTowards } from "../../clock";
import {
  deepDispose,
  projectToScreen,
  recordLevel,
  recordTexture,
  toColor,
  type RecordTexture,
} from "../../three";
import { clamp, mix, rgba, wrap } from "../lib";
import { coverageToSdf } from "../sdf";
import { driftRecord } from "../survey/model";
import {
  BEHIND_SECONDS,
  BULGE,
  CAMERA_DROP,
  DEFAULT_AHEAD_SECONDS,
  DEFAULT_HITS,
  HEAT_TAU,
  HIT_FLOORS,
  HIT_REFRACTORY_MS,
  HIT_THRESHOLDS,
  KICK_REFRACTORY_MS,
  PULSES,
  PULSE_LIFE_MS,
  PULSE_SPEED,
  PULSE_START,
  RADIUS,
  UNITS_PER_SECOND,
  laneOfAngle,
  SIGN_LEAD_SECONDS,
  signAngle,
  zOfSeconds,
} from "./model";

/**
 * CONDUIT, shown as TUNNEL (renamed 2026-09-08; the id and the file keep the old name so
 * saved settings still resolve).
 *
 * CONDUIT: the tunnel through the track ahead (after packscape's Slipstream
 * in its Conduit costume, in this app's voice). The flight path is the
 * track's time; the horizon is half a minute from now. Six ribbons wrap the
 * pipe, bass at the floor and air at the ceiling, each bulging inward with
 * its register's level, so the shape of the chorus is a pipe closing around
 * you before it arrives. Rings mark the seconds. A gold light burns at the
 * end of the wire. The lines are PAINTED ON THE WALL at their times, curved
 * with it and standing on its bulge, so they come toward you like signs in
 * a tunnel, gold while heard and back to ink after, and they sweep past
 * whole. The hits are the file's own drum onsets: a kick sends a RING OF
 * LIGHT down the pipe, a snare throws speed lines, a hat flickers the light
 * at the end; the wall's warmth is the passage's intensity, slowly, so the
 * drums stay legible as drums. A DROP: through the last of the build the
 * whole picture fades to black, then blooms back in from the light at the
 * end and settles. The camera flies a slow, never quite straight
 * path and rolls a little; a hit never touches it, so the flight never
 * stops moving forward.
 */
export const CONDUIT_KEY: SceneKey = {
  reads: [
    {
      shows: "The tunnel",
      means:
        "The track's timeline. The near end is your position and the far end is half a minute ahead",
    },
    {
      shows: "Six ribbons, floor to ceiling",
      means:
        "Bass at the floor to highs at the ceiling. A ribbon bulges inward with its band's level",
    },
    {
      shows: "The rings",
      means:
        "The beats, with the first beat of each bar heavier. When the beat cannot be found, one ring a second",
    },
    {
      shows: "The light at the end",
      means:
        "The overall loudness, following slowly. It grows in a chorus, flickers on a hi-hat and dims in a silence",
    },
    {
      shows: "A drop",
      means:
        "The view narrows through the build-up and goes dark, then opens again from the light at the end when the drop lands",
    },
    { shows: "The wall's warmth", means: "How intense the music is, following slowly" },
    {
      shows: "Signs painted on the wall",
      means: "The lyrics, each where it is sung. The line being sung is gold and largest",
    },
    { shows: "A ring of light down the tunnel", means: "A kick drum" },
    { shows: "Speed lines", means: "A snare" },
    {
      shows: "The glow",
      means: "A bloom on the light, the rings and the speed lines (the Glow switch turns it off)",
    },
  ],
  honesty: [
    "The tunnel ahead is the track's real loudness, smoothed to half a second.",
    "Drum hits are found in the audio itself. Brushed drums and heavy distortion confuse them, and a hard-plucked bass can count as a kick.",
  ],
};

export const CONDUIT_SETTINGS: SceneSettingDef[] = [
  {
    key: "ahead",
    label: "Ahead",
    kind: "slider",
    min: 16,
    max: 60,
    step: 2,
    default: DEFAULT_AHEAD_SECONDS,
    unit: "s",
  },
  { key: "signs", label: "Signs", kind: "toggle", default: true, full: true },
  { key: "streaks", label: "Speed lines", kind: "toggle", default: true },
  { key: "glow", label: "Glow", kind: "toggle", default: true, full: true },
  {
    key: "hits",
    label: "Hits",
    kind: "select",
    options: [
      { value: "big", label: "Big" },
      { value: "most", label: "Most" },
      { value: "all", label: "All" },
    ],
    default: DEFAULT_HITS,
  },
];

const VERTEX = /* glsl */ `
uniform sampler2D uHeights;
uniform float uHead;
uniform float uSeconds;
uniform float uBulge;
varying float vLane;
varying float vLevel;
varying float vSecs;
varying float vAngle;
varying vec3 vWorld;
void main() {
  // the tube runs along z; a vertex's time is now plus its distance ahead
  float secsAhead = position.z / ${UNITS_PER_SECOND}.0;
  float t = uHead + secsAhead;
  float theta = atan(position.y, position.x);
  // distance from the floor around either side: 0 at the floor, 1 at the ceiling
  float d = theta + 1.5707963;
  d = mod(d + 6.2831853, 6.2831853);
  if (d > 3.14159265) d = 6.2831853 - d;
  float lane = d / 3.14159265;
  float level = texture2D(uHeights, vec2(clamp(t / uSeconds, 0.0, 1.0), lane)).r;
  float r = length(position.xy);
  float radius = r - level * uBulge;
  vec3 p = vec3(position.xy / max(r, 1.0) * radius, position.z);
  vLane = lane;
  vLevel = level;
  vSecs = t;
  vAngle = theta;
  vWorld = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAGMENT = /* glsl */ `
// common carries rand(), which the dithering chunk calls; ShaderMaterial includes nothing by itself
#include <common>
#include <dithering_pars_fragment>
uniform float uBloomOnly;
uniform vec3 uTint;
uniform float uTintAmt;
uniform float uHaze;
uniform vec3 uBg;
uniform vec3 uInk;
uniform vec3 uGold;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
uniform float uLight;
uniform float uHead;
uniform float uAheadUnits;
uniform float uHeat;
uniform float uPulseZ[8];
uniform float uPulseAmp[8];
uniform float uBeatPeriod;
uniform float uBeatPhase0;
uniform float uDownbeat;
uniform float uFlash;
varying float vLane;
varying float vLevel;
varying float vSecs;
varying float vAngle;
varying vec3 vWorld;
void main() {
  // the wall's base is the faceplate, cast a little toward the art's own hue
  vec3 base = mix(uBg, uTint, uTintAmt);
  vec3 hue = vLane < 0.5 ? mix(uA, uB, vLane * 2.0) : mix(uB, uC, (vLane - 0.5) * 2.0);
  // the ribbon: bright where its register is loud, its own color; the wall between is the faceplate
  float ribbon = 0.12 + 0.88 * vLevel;
  vec3 wall = mix(base, hue, ribbon * (0.42 + 0.25 * uHeat) * (1.0 - uLight) + uLight * ribbon * 0.45);
  // ribbon borders: a faint seam at each register's edge
  float seam = smoothstep(0.0, 0.03, min(fract(vLane * 6.0), 1.0 - fract(vLane * 6.0)));
  wall = mix(mix(wall, base, 0.25 * (1.0 - uLight)), wall, seam);
  // rings: one a second, faint ink; the rail: a gold line along the floor
  // rings: one a beat when the track has a grid (the downbeat heavier), else one a second
  float beatPos = (vSecs - uBeatPhase0) / uBeatPeriod;
  float ring = 1.0 - smoothstep(0.0, 0.08 / uBeatPeriod, min(fract(beatPos), 1.0 - fract(beatPos)));
  float bar = uDownbeat >= 0.0 && mod(floor(beatPos + 0.5) - uDownbeat, 4.0) < 0.5 ? 1.0 : 0.0;
  wall = mix(wall, uInk, ring * (0.12 + 0.16 * bar));
  // the drop's flash
  wall = mix(wall, uGold, uFlash * 0.35);
  // pulses: a kick's ring of gold light, wherever it has reached down the pipe
  float glowSum = 0.0;
  for (int i = 0; i < 8; i++) {
    float band = 1.0 - smoothstep(0.0, 20.0 + 24.0 * uPulseAmp[i], abs(vWorld.z - uPulseZ[i]));
    wall = mix(wall, uGold, band * uPulseAmp[i] * 0.75);
    glowSum += band * uPulseAmp[i];
  }
  // the bloom pass sees only what glows: the rings and the drop's flash, on black
  if (uBloomOnly > 0.5) {
    gl_FragColor = vec4(uGold * (glowSum * 0.6 + uFlash * 0.6), 1.0);
    return;
  }
  float floor = 1.0 - smoothstep(0.0, 0.05, abs(vAngle + 1.5707963));
  wall = mix(wall, uGold, floor * 0.5);
  // near the camera it is lit; the far end dissolves toward the light
  float ahead = clamp(vWorld.z / uAheadUnits, 0.0, 1.0);
  float lit = 1.0 - smoothstep(0.35, 1.0, ahead) * 0.85;
  wall *= mix(lit, 1.0, uLight * 0.7);
  // THE HAZE: the air before the light glows, and the far wall dissolves into it rather than
  // into the dark. The dark end used to show through the corona as a hard crescent wherever a
  // loud passage bulged the pipe inward near the light; what shows there now is the haze
  vec3 hazeColor = mix(base, uGold, uHaze);
  float fog = smoothstep(0.45, 0.92, ahead);
  vec3 far = mix(hazeColor, uGold * (0.95 + 0.25 * uHaze), smoothstep(0.82, 1.0, ahead));
  gl_FragColor = vec4(mix(wall, far, fog), 1.0);
  #include <dithering_fragment>
}`;

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** A kick's ring of light on its way down the pipe. */
interface Pulse {
  z: number;
  strength: number;
  amp: number;
  born: number;
}

// SPEED LINES IN THE SCENE. A pool of line segments inside the pipe, thrown toward the
// camera on a hit: gold at the head, nothing at the tail, additive so they read as light.
// They used to be 2D strokes on the overlay from a guessed vanishing point; in the scene
// they sit at a real depth, bloom with the rest of the light and pass behind the signs.
// Each is a TAPERED RIBBON (two triangles), not a line segment: WebGL draws every line one
// pixel wide whatever is asked, and at that width they were hairlines the eye slid past (the
// user, 2026-09-12: "make the speed lines more obvious"). A ribbon has a width in world
// units, so it grows in perspective as it nears, and it is wide at the head and a sliver at
// the tail, a dart of light rather than a stroke.
const STREAK_POOL = 240;
/** A ribbon's width at its head, in world units, at a hit of no strength and of full. */
const STREAK_WIDTH_MIN = 4;
const STREAK_WIDTH_MAX = 10;
/** Its width at the tail. */
const STREAK_TAIL_WIDTH = 0.8;
/** Soft additive discs of light in the air before the sun. */
const HAZE_LAYERS = 3;
interface StreakPool {
  mesh: THREE.Mesh;
  /** Four vertices a ribbon: head left, head right, tail left, tail right. */
  positions: Float32Array;
  colors: Float32Array;
  angle: Float32Array;
  radius: Float32Array;
  z: Float32Array;
  len: Float32Array;
  width: Float32Array;
  speed: Float32Array;
  age: Float32Array;
  life: Float32Array;
  strength: Float32Array;
  live: Uint8Array;
  next: number;
}

// THE LIGHT AT THE END, drawn by a shader: a granulated disc darker toward its limb, a thin
// bright rim, a corona that falls off exponentially and crackles, a few slow rays. It used
// to be a canvas texture on a sprite; drawn per pixel it stays crisp at any size, breathes
// with the loudness and flickers on the hats without redrawing anything. No pow().
const SUN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const SUN_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uLoud;
uniform float uFlick;
uniform float uQuiet;
uniform float uLight;
uniform float uBloomScale;
uniform vec3 uGold;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float ang = atan(p.y, p.x);
  float discR = 0.34 + 0.04 * uLoud;
  // the disc: slow granulation, a touch darker toward the limb. Gently: at 0.6 limb
  // darkening and a gold floor, the edge zone went dark gold wherever the noise ran low,
  // and the bloom only whitens the middle, so a dark crescent drifted round the rim
  float gran = fbm(p * 4.0 + vec2(uTime * 0.15, -uTime * 0.11));
  float limb = 1.0 - smoothstep(0.0, discR, r) * 0.35;
  float disc = 1.0 - smoothstep(discR - 0.02, discR + 0.01, r);
  vec3 surface = mix(uGold, vec3(1.0), 0.4 + 0.4 * gran) * limb;
  // a thin bright rim right at the edge
  float rim = exp(-abs(r - discR) * 40.0) * 0.6;
  // the corona: exponential falloff that reaches further when the music is loud, crackling
  // with noise in the plane (noise in the angle would seam at the back)
  float outside = step(discR, r);
  float crackle = fbm(p * 3.0 + vec2(uTime * 0.2, uTime * 0.13));
  float corona = exp(-(r - discR) * (4.5 - 1.5 * uLoud)) * (0.45 + 0.55 * crackle) * outside * 1.3;
  // a few slow rays; integer frequencies so they close around the seam
  float rays = max(0.0, sin(ang * 9.0 + uTime * 0.3)) * max(0.0, sin(ang * 5.0 - uTime * 0.17));
  rays = rays * exp(-(r - discR) * 2.5) * outside * 0.22;
  float glow = corona * (0.6 + 0.4 * uFlick) + rays;
  vec3 col = surface * disc + uGold * (rim + glow);
  float alpha = disc + clamp(glow * 0.9 + rim, 0.0, 1.0) * (1.0 - disc);
  // the plane's edge must never show
  alpha *= 1.0 - smoothstep(0.82, 1.0, r);
  float dim = (1.0 - 0.5 * uQuiet) * mix(1.0, 0.6, uLight);
  gl_FragColor = vec4(col * dim * uBloomScale, alpha * dim);
}
`;

/** A line painted on the wall: a curved patch of the pipe carrying its words. */
interface Sign {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** A distance field of the letters (sdf.ts), one byte a texel; the shader draws its edge. */
  texture: THREE.DataTexture;
  angle: number;
  /** World z-length of the patch (its height on the wall). */
  height: number;
  arc: number;
  /** How gold it is: eased toward 1 while its line is heard, back toward 0 after. */
  glow: number;
}

/** Sign patch geometry: unit radius, unit z-height, an arc centred on 0 (rotated per sign). */
function patchGeometry(arc: number, segments = 28): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= segments; j++) {
    const a = -arc / 2 + (arc * j) / segments;
    const x = Math.cos(a);
    const y = Math.sin(a);
    // u runs with the angle (screen left to right from inside, on the upper wall);
    // v puts the top of the letters NEARER the camera, which is upright on a ceiling
    pos.push(x, y, -0.5, x, y, 0.5);
    uv.push(j / segments, 1, j / segments, 0);
    if (j < segments) {
      const k = j * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const SIGN_ARC = Math.PI * 0.5;
const SIGN_SEGMENTS = 28;
const SIGN_LINE_UNITS = 46;
// the sign's field: the letters are laid out on a canvas this size, then turned into a
// distance field. Smaller than the old alpha canvas by a quarter of the bytes and crisper
// when magnified, because the shader thresholds a distance instead of blurring an edge
const SIGN_TEXELS_W = 640;
const SIGN_TEXELS_H = 250;
const SIGN_PX = 94;
const SIGN_PX_MIN = 35;
/** Texels the field reaches either side of the edge before saturating. */
const SIGN_SPREAD = 10;

const SIGN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
// the edge is where the field crosses one half; its width follows the screen-space rate of
// change of the field, so the letters are anti-aliased by about a pixel at any magnification
const SIGN_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float d = texture2D(uMap, vUv).r;
  float w = fwidth(d) * 0.7 + 0.004;
  float a = smoothstep(0.5 - w, 0.5 + w, d);
  gl_FragColor = vec4(uColor, a * uOpacity);
}
`;

export class Conduit implements ThreeScene {
  readonly kind = "three" as const;
  settings: SceneSettings = {};
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 1, 1, 8000);
  private material: THREE.ShaderMaterial | null = null;
  private tube: THREE.Mesh | null = null;
  private sun: THREE.Mesh | null = null;
  private sunMaterial: THREE.ShaderMaterial | null = null;
  /** A cap on the pipe's far end in the fog's color: without it the open end was a dark hole. */
  private cap: THREE.Mesh | null = null;
  /** Selective bloom: a composer that sees only what glows, and one that adds it to the picture. */
  private bloom: { base: EffectComposer; final: EffectComposer; pass: UnrealBloomPass } | null =
    null;
  private tex: RecordTexture | null = null;
  private texFor: SceneRecord | null = null;
  private drift = driftRecord();
  private phase = 0;
  private heat = 0;
  private lastHit = 0;
  private lastKick = 0;
  private pulses: Pulse[] = [];
  private sunFlick = 0;
  /** The drop's flash on the wall, and how much of a chorus this is, both eased. */
  private flash = 0;
  /** The drop's bloom blowout, 1 at the instant, eased away. */
  private blow = 0;
  private chorus = 0;
  /** The drop's camera lean, eased so the release settles rather than snaps. */
  private lean = 0;
  /** The drop's shudder: a small, fast, smooth jitter of the eye that dies in under a second. */
  private shake = 0;
  /** Where the camera stands and what it looks at this frame; the speed lines radiate from the aim. */
  private eye = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private aheadUnits = zOfSeconds(DEFAULT_AHEAD_SECONDS);
  private streaks: StreakPool | null = null;
  private hazeSprites: THREE.Sprite[] = [];
  /** How golden the far haze is, eased from the loudness. */
  private haze = 0.5;
  private signs = new Map<number, Sign>();
  private signsFor: readonly { t: number; text: string }[] | null = null;
  private font = "";
  private tmp = new THREE.Vector3();

  init(renderer: THREE.WebGLRenderer, w: number, h: number): void {
    void renderer;
    const length = zOfSeconds(BEHIND_SECONDS + 60);
    const geometry = new THREE.CylinderGeometry(RADIUS, RADIUS, length, 96, 220, true);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, length / 2 - zOfSeconds(BEHIND_SECONDS));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      // dithered: the wall fades a long way into near-black, where 8-bit banding shows
      dithering: true,
      uniforms: {
        uBloomOnly: { value: 0 },
        uHeights: { value: null },
        uHead: { value: 0 },
        uSeconds: { value: 1 },
        uBulge: { value: BULGE },
        uBg: { value: new THREE.Color() },
        uInk: { value: new THREE.Color() },
        uGold: { value: new THREE.Color() },
        uA: { value: new THREE.Color() },
        uB: { value: new THREE.Color() },
        uC: { value: new THREE.Color() },
        uLight: { value: 0 },
        uAheadUnits: { value: this.aheadUnits },
        uHeat: { value: 0 },
        uPulseZ: { value: new Float32Array(PULSES) },
        uPulseAmp: { value: new Float32Array(PULSES) },
        uBeatPeriod: { value: 1 },
        uBeatPhase0: { value: 0 },
        uDownbeat: { value: -1 },
        uFlash: { value: 0 },
        uTint: { value: new THREE.Color() },
        uTintAmt: { value: 0 },
        uHaze: { value: 0.5 },
      },
    });
    this.tube = new THREE.Mesh(geometry, this.material);
    this.tube.frustumCulled = false;
    this.scene.add(this.tube);
    this.cap = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS * 1.3, 48),
      // both sides: the circle faces +z, AWAY from the camera, and with front-side culling it
      // never drew. The sprite sun was large enough to hide the tube's open end behind it;
      // the shader sun is not, and the end showed as a dark disc round the light (THE
      // CRESCENT, found by the user from a crop: "the end of the tunnel being bigger than
      // the size consumed by the sun")
      new THREE.MeshBasicMaterial({ color: new THREE.Color(), side: THREE.DoubleSide }),
    );
    this.cap.frustumCulled = false;
    this.scene.add(this.cap);
    // the light at the end: a shader-drawn disc, rim and corona on a plane that faces down
    // the pipe. Normal blending: the disc must COVER the pipe's open end behind it (additive
    // light over that dark hole read as a darker disc inside a brighter ring)
    this.sunMaterial = new THREE.ShaderMaterial({
      vertexShader: SUN_VERTEX,
      fragmentShader: SUN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      // no depth test: the light is drawn over whatever is in front of it. The wall's bulge
      // (130 of the 300 radius) puts its silhouette, nine tenths of the way down the pipe,
      // right at the disc's edge, and with depth testing it bit the corona as a hard dark
      // crescent; the light is in the air, not behind the ribbons
      depthTest: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uLoud: { value: 0 },
        uFlick: { value: 0 },
        uQuiet: { value: 0 },
        uLight: { value: 0 },
        uBloomScale: { value: 1 },
        uGold: { value: new THREE.Color(1, 1, 1) },
      },
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.sunMaterial);
    this.sun.frustumCulled = false;
    this.scene.add(this.sun);
    // the haze in the air before the light: soft additive discs drawn over the wall (no depth
    // test: they are air, and from every angle the camera takes they sit in front of the far wall)
    {
      const c = document.createElement("canvas");
      c.width = 128;
      c.height = 128;
      const g = c.getContext("2d");
      if (g) {
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(0.5, "rgba(255,255,255,0.35)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
      }
      const tex = new THREE.CanvasTexture(c);
      for (let i = 0; i < HAZE_LAYERS; i++) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            opacity: 0,
          }),
        );
        sprite.frustumCulled = false;
        this.scene.add(sprite);
        this.hazeSprites.push(sprite);
      }
    }
    // the speed lines: a pool of ribbons, coloured per vertex so a dead one costs nothing
    {
      const positions = new Float32Array(STREAK_POOL * 12);
      const colors = new Float32Array(STREAK_POOL * 12);
      const index = new Uint16Array(STREAK_POOL * 6);
      for (let i = 0; i < STREAK_POOL; i++) {
        const v = i * 4;
        index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.streaks = {
        mesh,
        positions,
        colors,
        angle: new Float32Array(STREAK_POOL),
        radius: new Float32Array(STREAK_POOL),
        z: new Float32Array(STREAK_POOL),
        len: new Float32Array(STREAK_POOL),
        width: new Float32Array(STREAK_POOL),
        speed: new Float32Array(STREAK_POOL),
        age: new Float32Array(STREAK_POOL),
        life: new Float32Array(STREAK_POOL),
        strength: new Float32Array(STREAK_POOL),
        live: new Uint8Array(STREAK_POOL),
        next: 0,
      };
    }
    // SELECTIVE BLOOM. The light at the end, the kick rings, the drop's flash and the speed
    // lines bloom; the wall, the signs and the cap do not. The first composer renders the
    // scene with the wall reduced to its rings (uBloomOnly) and the signs and cap hidden, then
    // blurs it (UnrealBloomPass at half size); the second renders the scene as it is and adds
    // that glow on top. Strength, radius and threshold start where ThreeUI's Flux Vortex left
    // them (0.6 / 0.3 / 0.2).
    const size = renderer.getSize(new THREE.Vector2());
    const base = new EffectComposer(renderer);
    base.renderToScreen = false;
    base.addPass(new RenderPass(this.scene, this.camera));
    const pass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, size.x / 2), Math.max(1, size.y / 2)),
      0.6,
      0.3,
      0.2,
    );
    base.addPass(pass);
    const final = new EffectComposer(renderer);
    final.addPass(new RenderPass(this.scene, this.camera));
    final.addPass(
      new ShaderPass(
        new THREE.ShaderMaterial({
          uniforms: {
            baseTexture: { value: null },
            bloomTexture: { value: base.renderTarget2.texture },
          },
          vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
          fragmentShader: /* glsl */ `
uniform sampler2D baseTexture;
uniform sampler2D bloomTexture;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(baseTexture, vUv) + vec4(texture2D(bloomTexture, vUv).rgb, 0.0);
}`,
        }),
        "baseTexture",
      ),
    );
    this.bloom = { base, final, pass };
    this.resize(w, h);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.bloom?.base.setSize(w, h);
    this.bloom?.final.setSize(w, h);
  }

  dispose(): void {
    for (const s of this.signs.values()) this.dropSign(s);
    this.signs.clear();
    deepDispose(this.scene);
    this.bloom?.pass.dispose();
    this.bloom?.base.dispose();
    this.bloom?.final.dispose();
    this.bloom = null;
    this.tex?.texture.dispose();
    this.tex = null;
    this.texFor = null;
  }

  private ensureTexture(record: SceneRecord): RecordTexture {
    if (this.tex && this.texFor === record) return this.tex;
    this.tex?.texture.dispose();
    this.tex = recordTexture(record, 1200);
    this.texFor = record;
    return this.tex;
  }

  private dropSign(s: Sign): void {
    this.scene.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.material.dispose();
    s.texture.dispose();
  }

  /**
   * Paint a line onto a wall patch: wrapped to two lines, never an ellipsis. The paint is a
   * distance field of the letters, so the edge stays crisp however close the patch comes.
   */
  private makeSign(index: number, text: string, angle: number): Sign {
    const W = SIGN_TEXELS_W;
    const H = SIGN_TEXELS_H;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    const field = new Uint8Array(W * H);
    if (g) {
      let px = SIGN_PX;
      let lines = [text];
      const fit = (): void => {
        g.font = `600 ${px}px ${this.font}`;
        lines = wrap(g, text, W * 0.94);
      };
      fit();
      while (
        (lines.length > 2 || lines.some((l) => g.measureText(l).width > W * 0.94)) &&
        px > SIGN_PX_MIN
      ) {
        px -= 5;
        fit();
      }
      g.clearRect(0, 0, W, H);
      g.fillStyle = "#fff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      const lineH = px * 1.12;
      const y0 = H / 2 - ((lines.length - 1) * lineH) / 2;
      lines.forEach((l, i) => g.fillText(l, W / 2, y0 + i * lineH));
      // coverage to a field; rows flipped so v runs up the patch as the canvas texture's did
      const rgba = g.getImageData(0, 0, W, H).data;
      const mask = new Uint8Array(W * H);
      for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3] > 127 ? 1 : 0;
      coverageToSdf(mask, W, H, SIGN_SPREAD, field, true);
    }
    const texture = new THREE.DataTexture(field, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const material = new THREE.ShaderMaterial({
      vertexShader: SIGN_VERTEX,
      fragmentShader: SIGN_FRAGMENT,
      uniforms: {
        uMap: { value: texture },
        uColor: { value: new THREE.Color(1, 1, 1) },
        uOpacity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      // no depth test: the patch is re-fitted to the wall every frame (placeSigns), but where
      // it sat a hair inside a bulge the wall clipped the words; painted means always on top
      depthTest: false,
      // both faces: the patch's winding puts its front inward, and culling it left no sign at all
      side: THREE.DoubleSide,
    });
    // the patch keeps the field's aspect: its arc is fixed, its height follows
    const height = (SIGN_ARC * RADIUS * 0.8 * H) / W;
    const mesh = new THREE.Mesh(patchGeometry(SIGN_ARC, SIGN_SEGMENTS), material);
    mesh.rotation.z = angle;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    void index;
    return {
      mesh,
      material,
      texture,
      angle,
      glow: 0,
      height: Math.max(height, SIGN_LINE_UNITS),
      arc: SIGN_ARC,
    };
  }

  draw(renderer: THREE.WebGLRenderer, f: SceneFrame): void {
    const m = this.material;
    if (!m || !this.sun) return;
    const P = f.palette;
    const record = f.record ?? this.drift;
    const tex = this.ensureTexture(record);
    const seconds = f.record ? (f.duration ?? tex.seconds) : (f.duration ?? 240);
    const speed = f.reduced ? 0.3 : 1;
    this.phase += f.dt * speed;
    this.font = f.font;
    const ahead = zOfSeconds(num(this.settings.ahead, DEFAULT_AHEAD_SECONDS));
    this.aheadUnits = easeTowards(this.aheadUnits, ahead, f.dt, 0.8);

    // the hits: the file's own drum onsets when the track has them (exact to the clock and
    // typed), else the strip's transient. A kick sends a ring of light down the pipe, a snare
    // throws speed lines, a hat flickers the light at the end; the Hits setting is the floor a
    // hit must clear. The camera is never touched.
    const hitsKey = String(this.settings.hits ?? DEFAULT_HITS);
    if (f.hitsKnown) {
      const floor = HIT_FLOORS[hitsKey] ?? HIT_FLOORS[DEFAULT_HITS];
      for (const h of f.hits) {
        if (h.strength < floor) continue;
        if (h.type === "kick") this.kick(f, h.strength);
        else if (h.type === "snare")
          this.spawnStreaks(f, 3 + Math.round(7 * h.strength), h.strength);
        else this.sunFlick = Math.max(this.sunFlick, 0.3 + 0.5 * h.strength);
      }
    } else {
      const threshold = HIT_THRESHOLDS[hitsKey] ?? HIT_THRESHOLDS[DEFAULT_HITS];
      const hit = Math.max(f.onset, f.kick);
      if (hit > threshold && f.now - this.lastHit > HIT_REFRACTORY_MS) {
        this.lastHit = f.now;
        this.kick(f, hit);
        this.spawnStreaks(f, 3 + Math.round(7 * hit), hit);
      }
    }
    // the wall's warmth is the passage's intensity, slowly: never the hits, so a kick reads as
    // a kick and a loud passage as a warm one
    this.heat = easeTowards(this.heat, f.slowLoud, f.dt, HEAT_TAU);
    this.sunFlick = easeTowards(this.sunFlick, 0, f.dt, 0.08);
    // the rings travel and dim
    const pulseZ = m.uniforms.uPulseZ.value as Float32Array;
    const pulseAmp = m.uniforms.uPulseAmp.value as Float32Array;
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const pu = this.pulses[i];
      pu.z += PULSE_SPEED * f.dt;
      const age = (f.now - pu.born) / PULSE_LIFE_MS;
      if (age >= 1 || pu.z > this.aheadUnits) {
        this.pulses.splice(i, 1);
        continue;
      }
      pu.amp = pu.strength * (1 - age) * (1 - age);
    }
    for (let i = 0; i < PULSES; i++) {
      pulseZ[i] = this.pulses[i]?.z ?? -1e5;
      pulseAmp[i] = this.pulses[i]?.amp ?? 0;
    }

    // the camera flies a slow path through the room the pipe gives it, never quite straight
    // (two incommensurate sines per axis, periods of a minute or two), and rolls a little
    // about the axis it looks down; it stays clear of the wall at its fullest bulge
    const t = this.phase;
    const live = f.reduced ? 0 : 1;
    const wx = live * (Math.sin(t * 0.13) * 60 + Math.sin(t * 0.047 + 1.7) * 30);
    const wy = live * (Math.sin(t * 0.09 + 0.6) * 18 + Math.sin(t * 0.031 + 2.4) * 10);
    const roll = live * (Math.sin(t * 0.05) * 0.28 + Math.sin(t * 0.019 + 1.1) * 0.16);
    // the drop's shudder: a few units of fast, smooth jitter (sines, not noise per frame, so
    // it never strobes) that decays in about a third of a second; never under reduced motion
    this.shake = easeTowards(this.shake, 0, f.dt, 0.18);
    const sh = live * this.shake * 7;
    const jx = sh * (Math.sin(t * 37) * 0.6 + Math.sin(t * 53 + 1) * 0.4);
    const jy = sh * (Math.sin(t * 41 + 2) * 0.6 + Math.sin(t * 61) * 0.4);
    const jr = live * this.shake * 0.012 * Math.sin(t * 47);
    this.eye.set(wx + jx, -CAMERA_DROP + wy + jy, 0);
    this.aim.set(wx * 0.3, -CAMERA_DROP * 0.35 + wy * 0.3, this.aheadUnits);
    this.camera.position.copy(this.eye);
    this.camera.up.set(Math.sin(roll + jr), Math.cos(roll + jr), 0);
    this.camera.lookAt(this.aim);

    // the drop: the camera leans in through the build and snaps back at the release, when the
    // wall flashes and a triple ring goes down the pipe
    const build = f.drop?.build ?? 0;
    const release = f.drop?.release ?? 0;
    // the lean-in follows the build closely; the LETTING GO is slow (tau 1.6 s) whichever way
    // the release flag reads: released over a third of a second, the widening frame right
    // after the drop read as the camera being pushed back (the user, 2026-09-07)
    const leanAim = build * (1 - release);
    this.lean = easeTowards(this.lean, leanAim, f.dt, leanAim < this.lean ? 1.6 : 0.12);
    this.camera.fov = 62 - 7 * this.lean;
    this.camera.updateProjectionMatrix();
    if (f.drop?.onDrop) {
      this.flash = 1;
      this.shake = 1;
      this.blow = f.reduced ? 0 : 1;
      this.spawnStreaks(f, 36, 1);
      for (let k = 0; k < 3; k++) {
        if (this.pulses.length >= PULSES) this.pulses.shift();
        this.pulses.push({ z: PULSE_START - k * 70, strength: 1, amp: 1, born: f.now - k * 40 });
      }
    }
    this.flash = easeTowards(this.flash, 0, f.dt, 0.5);
    this.blow = easeTowards(this.blow, 0, f.dt, 0.45);
    this.chorus = easeTowards(this.chorus, f.section?.kind === "chorus" ? 1 : 0, f.dt, 0.8);

    const u = m.uniforms;
    // the beat grid, for the rings
    if (f.beat) {
      const period = 60 / f.beat.bpm;
      u.uBeatPeriod.value = period;
      u.uBeatPhase0.value = f.position - f.beat.phase * period;
      const beatInBar = Math.floor(f.beat.bar * 4) % 4;
      u.uDownbeat.value = (4 - beatInBar) % 4;
    } else {
      u.uBeatPeriod.value = 1;
      u.uBeatPhase0.value = 0;
      u.uDownbeat.value = -1;
    }
    u.uFlash.value = this.flash;
    u.uHeights.value = tex.texture;
    u.uHead.value = f.position;
    u.uSeconds.value = seconds;
    (u.uBg.value as THREE.Color).copy(toColor(P.bg));
    (u.uInk.value as THREE.Color).copy(toColor(P.ink));
    (u.uGold.value as THREE.Color).copy(toColor(P.gold));
    (u.uA.value as THREE.Color).copy(toColor(P.accent[0]));
    (u.uB.value as THREE.Color).copy(toColor(P.accent[1]));
    (u.uC.value as THREE.Color).copy(toColor(P.accent[2]));
    u.uLight.value = P.light ? 1 : 0;
    u.uAheadUnits.value = this.aheadUnits;
    u.uHeat.value = this.heat;
    // the art's cast over the wall's base, and how golden the far haze is
    if (P.tint) (u.uTint.value as THREE.Color).copy(toColor(P.tint));
    u.uTintAmt.value = P.tint ? (P.light ? 0.25 : 0.3) : 0;
    this.haze = easeTowards(
      this.haze,
      (0.5 + 0.3 * f.slowLoud + 0.2 * this.sunFlick) * (1 - 0.4 * f.quiet) * (P.light ? 0.5 : 1),
      f.dt,
      0.4,
    );
    u.uHaze.value = this.haze;

    this.updateStreaks(f, toColor(P.gold));
    // the signs, painted on the wall at their times, standing on its bulge
    this.placeSigns(f, seconds);

    if (this.sunMaterial) {
      const su = this.sunMaterial.uniforms;
      su.uTime.value = this.phase;
      su.uLoud.value = f.slowLoud;
      su.uFlick.value = this.sunFlick;
      su.uQuiet.value = f.quiet;
      su.uLight.value = P.light ? 1 : 0;
      (su.uGold.value as THREE.Color).copy(toColor(P.gold));
    }
    const sunSize =
      RADIUS *
      (2.3 + 1.2 * f.slowLoud + 0.35 * this.sunFlick) *
      (1 + 0.25 * this.chorus + 0.6 * this.lean);
    this.sun.scale.set(sunSize, sunSize, 1);
    this.sun.position.set(0, -CAMERA_DROP * 0.2, this.aheadUnits * 0.96);
    // the haze layers: deeper is smaller and brighter, all drifting a little
    for (let i = 0; i < this.hazeSprites.length; i++) {
      const sp = this.hazeSprites[i];
      const size = RADIUS * (2.6 - 0.5 * i) * (1 + 0.3 * f.slowLoud);
      sp.scale.set(size, size, 1);
      sp.position.set(
        Math.sin(this.phase * 0.11 + i * 2.1) * RADIUS * 0.08,
        -CAMERA_DROP * 0.2 + Math.cos(this.phase * 0.09 + i * 1.3) * RADIUS * 0.06,
        this.aheadUnits * (0.62 + 0.13 * i),
      );
      sp.material.color.copy(toColor(P.gold));
      sp.material.opacity = (0.05 + 0.035 * i) * this.haze * (P.light ? 0.6 : 1);
    }
    if (this.cap) {
      this.cap.position.set(0, 0, this.aheadUnits - 2);
      // the cap is the far end of the haze: the same bright gold the wall reaches there
      (this.cap.material as THREE.MeshBasicMaterial).color
        .copy(toColor(P.gold))
        .multiplyScalar(0.95 + 0.25 * this.haze);
    }
    renderer.setClearColor(toColor(P.bg), 1);
    if (this.bloom && this.settings.glow !== false && !f.mini) {
      // pass one: only what glows, on black; pass two: the picture, plus that glow
      u.uBloomOnly.value = 1;
      // THE BLOWOUT: at the drop the bloom itself blows open, the light and the wall's flash
      // flooding the frame, and eases back over a second and a half (never under reduced motion)
      const blow = this.blow;
      this.bloom.pass.strength = 0.6 + 2.4 * blow;
      this.bloom.pass.radius = 0.3 + 0.5 * blow;
      this.bloom.pass.threshold = 0.2 * (1 - 0.75 * blow);
      if (this.sunMaterial) this.sunMaterial.uniforms.uBloomScale.value = 0.35 + 1.4 * blow;
      for (const s of this.signs.values()) s.mesh.visible = false;
      if (this.cap) this.cap.visible = false;
      for (const sp of this.hazeSprites) sp.visible = false;
      renderer.setClearColor(0x000000, 1);
      this.bloom.base.render();
      u.uBloomOnly.value = 0;
      if (this.sunMaterial) this.sunMaterial.uniforms.uBloomScale.value = 1;
      for (const s of this.signs.values()) s.mesh.visible = true;
      if (this.cap) this.cap.visible = true;
      for (const sp of this.hazeSprites) sp.visible = true;
      renderer.setClearColor(toColor(P.bg), 1);
      this.bloom.final.render();
    } else renderer.render(this.scene, this.camera);
  }

  private placeSigns(f: SceneFrame, seconds: number): void {
    const lyric = f.lyric;
    const on = this.settings.signs !== false && lyric != null;
    const lines = lyric?.lines ?? null;
    if (this.signsFor !== lines) {
      for (const s of this.signs.values()) this.dropSign(s);
      this.signs.clear();
      this.signsFor = lines;
    }
    if (!on || !lines || !lyric) {
      for (const s of this.signs.values()) this.dropSign(s);
      this.signs.clear();
      return;
    }
    const aheadSecs = this.aheadUnits / UNITS_PER_SECOND;
    const P = f.palette;
    const wanted = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.text) continue;
      const d = ln.t - f.position;
      // the sign hangs SIGN_LEAD_SECONDS ahead of its moment (see model.ts)
      const at = d + SIGN_LEAD_SECONDS;
      if (at < 0 || at > aheadSecs) continue;
      wanted.add(i);
      let sign = this.signs.get(i);
      if (!sign) {
        sign = this.makeSign(i, ln.text, signAngle(i));
        this.signs.set(i, sign);
      }
      // the patch is fitted to the wall every frame: each vertex takes the radius the wall
      // shader gives that angle and time (the smoothed record, sampled as the GPU samples it),
      // a hair inside, so the words follow the ribbons' bulges instead of floating or sinking
      const tex = this.tex;
      const pos = sign.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let j = 0; j <= SIGN_SEGMENTS; j++) {
        const a = -SIGN_ARC / 2 + (SIGN_ARC * j) / SIGN_SEGMENTS;
        const lane = laneOfAngle(sign.angle + a);
        for (let side = 0; side < 2; side++) {
          const z = zOfSeconds(at) + (side === 0 ? -0.5 : 0.5) * sign.height;
          const level = tex
            ? recordLevel(tex, (f.position + z / UNITS_PER_SECOND) / seconds, lane)
            : 0;
          const r = RADIUS - level * BULGE - 3;
          pos.setXYZ(j * 2 + side, Math.cos(a) * r, Math.sin(a) * r, side === 0 ? -0.5 : 0.5);
        }
      }
      pos.needsUpdate = true;
      sign.mesh.scale.set(1, 1, sign.height);
      sign.mesh.position.set(0, 0, zOfSeconds(at));
      const near = clamp(1 - at / aheadSecs);
      // toward the light the signs thin out and warm toward it (the user's word: fade a little
      // the closer they are to the sun)
      // the same for a line being heard and one that is done: when the gold released, the
      // weight used to drop from a protected 0.85 to the distance fade, which read as the sign
      // fading out after its line (the user, 2026-09-07). Only the color changes now
      const far = clamp((at / aheadSecs - 0.55) / 0.45);
      const fog = 1 - far;
      // a sign sweeps past whole (no dissolve, at the user's word); it goes gold as its line
      // is heard and eases back to the color it had once the line is done
      const isNow = i === lyric.index;
      sign.glow = easeTowards(sign.glow, isNow ? 1 : 0, f.dt, isNow ? 0.2 : 0.8);
      // a finished line keeps its weight (only its color eases back: the user's word) and
      // slides off the frame like a road sign overhead; only its last sliver, letters the
      // size of the frame right at the corner, thins out, from three seconds out to gone at
      // one and a half (an earlier fade from seven read as fading after the line)
      const gone = clamp((at - 1.5) / 1.5);
      sign.material.uniforms.uOpacity.value = (0.35 + 0.6 * near) * fog * gone;
      (sign.material.uniforms.uColor.value as THREE.Color).copy(
        toColor(mix(mix(mix(P.ink, P.gold, 0.35 * near), P.gold, 0.5 * far), P.gold, sign.glow)),
      );
    }
    for (const [i, s] of this.signs) {
      if (!wanted.has(i)) {
        this.dropSign(s);
        this.signs.delete(i);
      }
    }
  }

  /** A kick: one ring of light sent down the pipe (a flam is one ring). */
  private kick(f: SceneFrame, strength: number): void {
    if (f.now - this.lastKick < KICK_REFRACTORY_MS) return;
    this.lastKick = f.now;
    if (this.pulses.length >= PULSES) this.pulses.shift();
    this.pulses.push({ z: PULSE_START, strength, amp: strength, born: f.now });
  }

  /** Speed lines from the vanishing point: n of them, living `life` ms plus up to `spread`. */
  private spawnStreaks(f: SceneFrame, n: number, strength: number): void {
    const s = this.streaks;
    if (!s || this.settings.streaks === false || f.reduced) return;
    for (let k = 0; k < n; k++) {
      const i = s.next;
      s.next = (s.next + 1) % STREAK_POOL;
      s.live[i] = 1;
      s.angle[i] = Math.random() * Math.PI * 2;
      s.radius[i] = RADIUS * (0.45 + 0.45 * Math.random());
      s.z[i] = Math.min(this.aheadUnits * 0.8, 500 + Math.random() * 900);
      s.len[i] = 70 + 90 * Math.random() + 60 * strength;
      s.width[i] = STREAK_WIDTH_MIN + (STREAK_WIDTH_MAX - STREAK_WIDTH_MIN) * strength;
      s.speed[i] = 1000 + 600 * Math.random() + 300 * strength;
      s.age[i] = 0;
      s.life[i] = 0.55 + 0.35 * Math.random();
      s.strength[i] = 0.35 + 0.65 * strength;
    }
  }

  // fly the live streaks toward the camera and write their vertices; a dead slot is black.
  // A ribbon's width runs along the wall's tangent at its angle, so on screen it lies across
  // the line from the vanishing point, and it is brightest at the head: the head's colour
  // sits a quarter over the gold, so the bloom pass takes it as light
  private updateStreaks(f: SceneFrame, gold: THREE.Color): void {
    const s = this.streaks;
    if (!s) return;
    const behind = this.camera.position.z + 20;
    const { positions: pos, colors: col } = s;
    for (let i = 0; i < STREAK_POOL; i++) {
      const o = i * 12;
      if (s.live[i]) {
        s.age[i] += f.dt;
        s.z[i] -= s.speed[i] * f.dt;
        const t = s.age[i] / s.life[i];
        if (t >= 1 || s.z[i] + s.len[i] < behind) s.live[i] = 0;
        else {
          const a = s.strength[i] * (1 - t) * (1 - t) * 1.25;
          const x = Math.cos(s.angle[i]) * s.radius[i];
          const y = Math.sin(s.angle[i]) * s.radius[i];
          const tx = -Math.sin(s.angle[i]);
          const ty = Math.cos(s.angle[i]);
          const wh = s.width[i] * 0.5;
          const wt = STREAK_TAIL_WIDTH * 0.5;
          const z0 = s.z[i];
          const z1 = s.z[i] + s.len[i];
          // head left, head right, tail left, tail right
          pos[o] = x - tx * wh;
          pos[o + 1] = y - ty * wh;
          pos[o + 2] = z0;
          pos[o + 3] = x + tx * wh;
          pos[o + 4] = y + ty * wh;
          pos[o + 5] = z0;
          pos[o + 6] = x - tx * wt;
          pos[o + 7] = y - ty * wt;
          pos[o + 8] = z1;
          pos[o + 9] = x + tx * wt;
          pos[o + 10] = y + ty * wt;
          pos[o + 11] = z1;
          for (let v = 0; v < 2; v++) {
            col[o + v * 3] = gold.r * a;
            col[o + v * 3 + 1] = gold.g * a;
            col[o + v * 3 + 2] = gold.b * a;
          }
          for (let v = 2; v < 4; v++) {
            col[o + v * 3] = gold.r * a * 0.08;
            col[o + v * 3 + 1] = gold.g * a * 0.08;
            col[o + v * 3 + 2] = gold.b * a * 0.08;
          }
          continue;
        }
      }
      col.fill(0, o, o + 12);
    }
    (s.mesh.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (s.mesh.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  overlay(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P } = f;
    // the drop's veil and bloom centre on the vanishing point
    const vp = projectToScreen(this.tmp.copy(this.aim), this.camera, w, h);
    // THE DROP: through the last three seconds of the lull the whole picture fades to black
    // (eased, so the dark arrives late and fast); at the drop it blooms back in from the light
    // at the end, white to gold, spreading and thinning over two and a half seconds, most of it
    // in the first. Under reduced motion the fade stays and the bloom is skipped: no flash.
    const d = f.drop;
    if (d && !f.mini) {
      if (d.until > 0 && d.until < 3) {
        const k = 1 - d.until / 3;
        ctx.fillStyle = rgba(P.bg, (0.7 + 0.3 * d.strength) * k * k * k);
        ctx.fillRect(0, 0, w, h);
      } else if (d.until <= 0 && d.until > -2.6 && !f.reduced) {
        // the bloom takes about a second to settle, then lingers thin
        const t = -d.until / 2.6;
        const a = Math.pow(1 - t, 1.6) * (0.6 + 0.4 * d.strength);
        const c = vp ?? { x: w / 2, y: h / 2 };
        const r = Math.min(w, h) * (0.45 + 2.6 * t);
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
        g.addColorStop(0, rgba([255, 255, 255], a));
        g.addColorStop(0.45, rgba(P.gold, a * 0.75));
        g.addColorStop(1, rgba(P.gold, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    }
  }
}
