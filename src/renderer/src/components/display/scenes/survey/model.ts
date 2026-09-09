import type { SceneRecord } from "../types";

/**
 * The Survey's decisions, with no three.js in them: the map of the song.
 * The whole track laid left to right, the six registers as ranges receding
 * from bass in front to air behind, the now-line sweeping across. Pure, so a
 * pin can hold the arithmetic.
 */

/** World units. The map is always this wide: the whole track fits, however long. */
export const MAP_WIDTH = 1600;
export const LANE_DEPTH = 88;
export const LANES = 6;
export const MAP_DEPTH = LANE_DEPTH * LANES;
/** World height of full scale at relief 1. */
export const RELIEF_HEIGHT = 150;
/** Columns the record is resampled to: one per two pixels of a wide stage. */
export const COLUMNS = 800;
/** Contour interval, as a fraction of full scale; every fourth line is heavier. */
export const CONTOUR_STEP = 1 / 8;

/** Where a moment sits along the map, world x (0 at the left edge). */
export function xOfSeconds(secs: number, seconds: number): number {
  if (!(seconds > 0)) return 0;
  return Math.min(1, Math.max(0, secs / seconds)) * MAP_WIDTH;
}

/** A register's centre line, world z: bass nearest the viewer, who stands at +z so
 *  that time runs left to right (a camera at −z looking down +z sees x mirrored). */
export function zOfLane(lane: number): number {
  return MAP_DEPTH - (lane + 0.5) * LANE_DEPTH;
}

/** Minute marks for the graticule labels: every minute, the last only if it is a whole one. */
export function minuteMarks(seconds: number): number[] {
  const out: number[] = [];
  for (let m = 60; m < seconds; m += 60) out.push(m);
  return out;
}

/**
 * A stand-in record for a track the app cannot read (radio, a cast, a library
 * it cannot reach): gentle hills from a few sines, so the map is a map and
 * not a plain. Deterministic, so it does not shimmer between frames.
 */
export function driftRecord(): SceneRecord {
  const frames = 600;
  const bands = new Float32Array(frames * LANES);
  const loud = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    let sum = 0;
    for (let b = 0; b < LANES; b++) {
      const v =
        0.35 +
        0.2 * Math.sin(t * 9.1 + b * 1.3) +
        0.12 * Math.sin(t * 23.7 - b * 0.7) +
        0.08 * Math.sin(t * 51.3 + b * 2.1);
      bands[i * LANES + b] = Math.min(1, Math.max(0, v));
      sum += v;
    }
    loud[i] = Math.min(1, Math.max(0, sum / LANES));
  }
  return { fps: 10, frames, bands, loud };
}
