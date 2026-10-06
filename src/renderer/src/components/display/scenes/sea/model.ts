/**
 * The Sea's decisions, with no three.js in them: an open sea seen from a low
 * deck, crossed wave trains rolling toward the viewer, a moon low ahead
 * whose glade of glints runs down the water. Pure, so a pin can hold the
 * arithmetic.
 */

/** One Gerstner wave train. */
export interface WaveTrain {
  /** Direction of travel in the water plane (x across, z toward the horizon; the trains
   *  run toward negative z, so they come at the viewer). */
  dir: [number, number];
  /** Wavelength in world units. */
  length: number;
  /** The train's amplitude at swell (or chop) 1. */
  amp: number;
  /** Its share of the crest-sharpening budget, 0..1: how far its crests lean. */
  steep: number;
  /** Swells follow the loudness slowly; chops follow the noisiness. */
  kind: "swell" | "chop";
}

/** Three long swells and three chops, crossed so no two crests agree for long. */
export const TRAINS: WaveTrain[] = [
  { dir: [0.12, -1], length: 64, amp: 1.0, steep: 0.55, kind: "swell" },
  { dir: [-0.3, -1], length: 41, amp: 0.62, steep: 0.5, kind: "swell" },
  { dir: [0.5, -0.9], length: 24, amp: 0.34, steep: 0.5, kind: "swell" },
  { dir: [0.85, -0.55], length: 9.5, amp: 0.2, steep: 0.6, kind: "chop" },
  { dir: [-0.7, -0.8], length: 5.2, amp: 0.11, steep: 0.65, kind: "chop" },
  { dir: [0.25, -1], length: 3.1, amp: 0.06, steep: 0.7, kind: "chop" },
];

/** Deep water: a train's speed from its wavelength (the dispersion relation, g = 9.8). */
export const waveSpeed = (length: number): number => Math.sqrt((9.8 * length) / (2 * Math.PI));

/** The deck: where the eye sits over the mean water, and how far the patch reaches. */
export const EYE_HEIGHT = 5.5;
export const NEAR = 1.4;
export const FAR = 560;
/** The moon's direction: low ahead, a little to the right, so its glade runs down the frame. */
export const MOON_DIR: [number, number, number] = [0.3, 0.155, 1];
/** The patch's rows and columns for the stage and for a picker tile. */
export const ROWS = 220;
export const COLS = 200;
export const MINI_ROWS = 80;
export const MINI_COLS = 72;
/** How the swell and the chop follow the music (eased, seconds), and how the drums let go. */
export const SWELL_TAU = 1.2;
export const CHOP_TAU = 0.8;
export const SURGE_TAU = 0.35;
export const GLINT_TAU = 0.12;
export const CREST_TAU = 0.25;
export const HALO_TAU = 0.6;
export const WARM_TAU = 2;
/** Without an onset list, the strip's transient a glint must clear, and its refractory. */
export const HIT_THRESHOLD = 0.4;
export const HIT_REFRACTORY_MS = 220;

/**
 * The patch: rows spaced geometrically from the bow to the horizon (dense underfoot, where
 * the chops live, sparse far off where only the swells survive), each row wide enough for
 * any aspect ratio the stage can take. The eye sits at the origin looking down +z.
 */
export function seaPatch(
  rows: number,
  cols: number,
): { position: Float32Array; index: Uint32Array } {
  const position = new Float32Array((rows + 1) * (cols + 1) * 3);
  const index = new Uint32Array(rows * cols * 6);
  const ratio = FAR / NEAR;
  let p = 0;
  for (let r = 0; r <= rows; r++) {
    const z = NEAR * Math.exp(Math.log(ratio) * (r / rows));
    const halfW = 1.9 * z + 2.5;
    for (let c = 0; c <= cols; c++) {
      position[p++] = ((c / cols) * 2 - 1) * halfW;
      position[p++] = 0;
      position[p++] = z;
    }
  }
  let k = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + cols + 1;
      index[k++] = a;
      index[k++] = b;
      index[k++] = a + 1;
      index[k++] = a + 1;
      index[k++] = b;
      index[k++] = b + 1;
    }
  return { position, index };
}
