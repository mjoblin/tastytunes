/**
 * Conduit's decisions, with no three.js in them: a flight down a pipe whose
 * axis is the track's time. The camera is now; ahead is what is coming, and
 * because the record is known the tunnel ahead is real, not a guess. Six
 * ribbons wrap the wall, bass at the floor and air at the ceiling, each
 * bulging inward with its register's level, so a chorus closes around you
 * before you reach it.
 */

/** World units per second of track: the conveyor's gearing. */
export const UNITS_PER_SECOND = 60;
/** Seconds of tunnel behind the camera and ahead of it (the default depth). */
export const BEHIND_SECONDS = 4;
export const DEFAULT_AHEAD_SECONDS = 36;
/** The pipe. */
export const RADIUS = 300;
/** How far a full-scale register bulges inward. */
export const BULGE = 130;
/** Where the camera rides: below the axis, on the bass floor's rail. */
export const CAMERA_DROP = 95;

/**
 * Which register a point on the wall belongs to, 0..1 across the six (bass 0,
 * air 1), from its angle in the pipe's frame (0 at starboard horizontal, the
 * floor at −π/2). Symmetric: both sides of the pipe wear the same ribbons,
 * floor-upward, so the picture reads from either seat.
 */
export function laneOfAngle(theta: number): number {
  // distance from the floor around either side, 0 at the floor, π at the ceiling
  let d = theta + Math.PI / 2;
  d = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d / Math.PI;
}

/** A sign's angle on the wall, 36° above horizontal, the lines alternating sides: high
 *  enough to read as a ceiling sign, low enough to stay in frame while its line is heard. */
export function signAngle(index: number): number {
  return index % 2 === 0 ? Math.PI * 0.2 : Math.PI * 0.8;
}
/** A sign hangs this many seconds AHEAD of its moment on the wall. The pipe is five
 *  seconds wide, so the wall beside the camera is out of frame: a sign at its own time
 *  had swept past long before its line was heard. The geometry: the camera rides 95 under
 *  the axis in a 62° frame, so a sign 36° up the wall (its top near 390 above the eye)
 *  starts leaving the frame about eleven seconds out and its middle is gone at seven and a
 *  half. Ten seconds put a sign already clipping as its line began, and a long line was
 *  largely out of view before it was done (user, 2026-09-07). Sixteen kept a sign whole
 *  for the first five seconds of its line; the user then asked for halfway back, so
 *  thirteen, then a little closer still: eleven and a half, whole for the first second of
 *  its line and readable for four or so, larger again on the wall. */
export const SIGN_LEAD_SECONDS = 11.5;

/** World z of a moment relative to now. */
export const zOfSeconds = (secondsFromNow: number): number => secondsFromNow * UNITS_PER_SECOND;

/** The heat envelope: a big hit grips at once and lets go over its time constant. */
export const HEAT_TAU = 1.4;
/** The Hits setting, on the file's own drum onsets: the strength (0..1 against the track's
 *  strongest hits) a hit must clear. "most" is the default; "all" takes the soft ones too;
 *  "big" keeps only the accents. */
export const HIT_FLOORS: Record<string, number> = { big: 0.65, most: 0.4, all: 0.15 };
/** The same setting when the track has no onset list (radio, an older analysis): the
 *  strip's transient (loudness or bass, whichever jumped more) above its slow average. */
export const HIT_THRESHOLDS: Record<string, number> = { big: 0.7, most: 0.5, all: 0.32 };
export const DEFAULT_HITS = "most";
/** Two hits closer than this are one: 250 ms allows 240 BPM on every beat. (700 ms here
 *  skipped every other kick above 86 BPM, which read as hits that missed.) */
export const HIT_REFRACTORY_MS = 250;
/** A kick is a RING OF LIGHT sent down the pipe: born where the wall first shows (the pipe
 *  beside the camera is out of frame, so a ring born at the camera would arrive late), it
 *  rushes toward the light at the end and dims as it goes. Two a second stay two rings. */
export const PULSE_START = 300;
export const PULSE_SPEED = 1400;
export const PULSE_LIFE_MS = 1400;
export const PULSES = 8;
/** Two kicks closer than this are a flam: one ring. */
export const KICK_REFRACTORY_MS = 180;
