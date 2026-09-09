import * as THREE from "three";
import type { Rgb, SceneRecord } from "./scenes/types";

// The scenes compute their own colors in their own shaders from the app's
// tokens: no color management, no output transform, what a shader writes is
// what shows (three would otherwise brighten the faceplate's near-black clear
// color into grey on its way to sRGB).
THREE.ColorManagement.enabled = false;

/**
 * THREE.JS for the scenes (user call 2026-09-06, after packscape's Stage3D):
 * the renderer a "three" scene draws through, the disposal discipline
 * (create once, dispose once: geometry, material, texture, target), and the
 * one thing every world scene reads: THE RECORD AS A TEXTURE. The feed's
 * normalized strip (six registers × frames) uploaded once per track as a
 * float texture, so a heightfield, a tunnel wall or a fluid's emitters can
 * all sample the same track in a vertex or fragment shader.
 */
export function makeRenderer(
  canvas: HTMLCanvasElement,
  dpr: number,
  w: number,
  h: number,
): THREE.WebGLRenderer | null {
  try {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    return renderer;
  } catch (e) {
    console.warn("[display] three.js renderer failed:", e);
    return null;
  }
}

export function disposeRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.dispose();
  renderer.forceContextLoss();
}

/** Dispose everything a scene graph owns: geometry, materials and their textures. */
export function deepDispose(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const m of mats) {
      for (const v of Object.values(m as unknown as Record<string, unknown>)) {
        if (v instanceof THREE.Texture) v.dispose();
      }
      const sm = m as THREE.ShaderMaterial;
      if (sm.uniforms) {
        for (const u of Object.values(sm.uniforms))
          if (u.value instanceof THREE.Texture) u.value.dispose();
      }
      m.dispose();
    }
  });
}

export const toColor = (c: Rgb): THREE.Color => new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255);

/** A world point on the overlay canvas, or null when it is behind the camera or off screen. */
export function projectToScreen(
  p: THREE.Vector3,
  camera: THREE.Camera,
  w: number,
  h: number,
  out = new THREE.Vector3(),
): { x: number; y: number; depth: number } | null {
  out.copy(p).project(camera);
  if (out.z > 1 || out.z < -1) return null;
  const x = (out.x * 0.5 + 0.5) * w;
  const y = (1 - (out.y * 0.5 + 0.5)) * h;
  if (x < -w * 0.2 || x > w * 1.2 || y < -h * 0.2 || y > h * 1.2) return null;
  return { x, y, depth: out.z };
}

/**
 * The record as a float texture: `columns` texels wide (the track resampled
 * to a fixed width, box-averaged), six rows (one register each, bass at
 * row 0), one channel. Linear filtering on both axes, so a shader reading
 * between two registers gets a smooth ridge and between two columns a
 * smooth slope. Null record → null.
 */
export interface RecordTexture {
  texture: THREE.DataTexture;
  columns: number;
  /** Seconds of track per column. */
  secondsPerColumn: number;
  /** The whole record's seconds. */
  seconds: number;
}

export function recordTexture(record: SceneRecord, columns: number): RecordTexture {
  const { frames, fps } = record;
  // never finer than two columns a second: the strip's ten frames would comb the beat into the ground
  const cols = Math.max(2, Math.min(columns, Math.round((frames / fps) * 2)));
  const raw = new Float32Array(cols * 6);
  const per = frames / cols;
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * per);
    const b = Math.max(a + 1, Math.floor((c + 1) * per));
    for (let band = 0; band < 6; band++) {
      let s = 0;
      for (let i = a; i < b; i++) s += record.bands[i * 6 + band];
      raw[band * cols + c] = s / (b - a);
    }
  }
  // a light three-tap smoothing along time
  const data = new Float32Array(cols * 6);
  for (let band = 0; band < 6; band++)
    for (let c = 0; c < cols; c++) {
      const l = raw[band * cols + Math.max(0, c - 1)];
      const m = raw[band * cols + c];
      const r = raw[band * cols + Math.min(cols - 1, c + 1)];
      data[band * cols + c] = 0.25 * l + 0.5 * m + 0.25 * r;
    }
  const texture = new THREE.DataTexture(data, cols, 6, THREE.RedFormat, THREE.FloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { texture, columns: cols, secondsPerColumn: per / fps, seconds: frames / fps };
}

/** The level the wall shader reads at (u along the track, 0..1; lane 0..1), sampled from the
 *  record texture's own data the way the GPU does (bilinear, clamped to the edges): anything
 *  that must sit ON a displaced wall asks this rather than the raw strip, or it sinks in. */
export function recordLevel(tex: RecordTexture, u: number, lane: number): number {
  const data = tex.texture.image.data as Float32Array;
  const cols = tex.columns;
  const x = Math.min(1, Math.max(0, u)) * cols - 0.5;
  const y = Math.min(1, Math.max(0, lane)) * 6 - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (c: number, r: number): number =>
    data[Math.min(5, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}
