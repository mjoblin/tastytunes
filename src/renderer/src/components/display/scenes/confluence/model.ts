/**
 * Ink's decisions (the scene's code name is Confluence), with no three.js in
 * them. The gas is the picture; everything that goes INTO it is decided here.
 * Six VENTS along the bottom edge, one per band, bass at the left: each puts
 * out gas in proportion to its band's level, and a gentle lift keeps what
 * they put out rising. A kick puffs the low vents, a hi-hat flickers the high
 * ones, a snare sends a gust across the frame, a drop bursts every vent; a
 * big kick spins a whirlpool; the pointer stirs. The words are not ink any
 * more: they are a solid layer above the gas (see index.ts).
 *
 * The three-column model that came before (a low register rising to meet a
 * high one falling, the front their balance) is kept below, unused by the
 * scene: the user found six nozzles top and bottom read as plumbing
 * (2026-09-08). Hygiene: delete it once the vents have settled.
 */
/** Where the vents sit: just above the bottom edge, spread across the middle 82% of the width. */
export const VENT_INSET = 0.035;
/** How far a vent's gas may wander from its centre, in width units. */
export const VENT_HALF_WIDTH = 0.035;
/** Field units per second of gentle lift across the whole frame, so the gas keeps rising. */
export const LIFT = 6;

/** A vent's centre, 0..1 across: bass at the left, highs at the right. */
export function ventX(register: number): number {
  return 0.09 + (0.82 * (register + 0.5)) / 6;
}

/** One vent's emission this tick from its band's level (0..1); null below the noise floor. */
export function ventFor(
  register: number,
  level: number,
  vigour: number,
  unit: () => number,
): Emission | null {
  if (level < 0.06) return null;
  const jitter = (unit() * 2 - 1) * VENT_HALF_WIDTH;
  const x = Math.min(Math.max(ventX(register) + jitter, 0.01), 0.99);
  return {
    x,
    y: VENT_INSET,
    dx: (unit() * 2 - 1) * 8,
    dy: PUSH * (0.3 + 0.7 * level) * vigour,
    // the bass vents breathe wider than the high ones
    radius: SPLAT_RADIUS * (0.7 + 1.0 * level) * (1.3 - 0.1 * register),
    ink: (0.05 + 0.1 * level * level) * vigour,
    register,
  };
}

export const COLUMNS = 3;
export const EDGE_INSET = 0.03;
/** How far a plume may wander from its column, in width units. */
export const LANE_HALF_WIDTH = 0.07;
/** Field units per second a full-level register pushes. */
export const PUSH = 130;
export const SPLAT_RADIUS = 0.0026;
/** Emissions per second per register (each is two GPU passes). */
export const EMIT_HZ = 30;

export interface Emission {
  x: number;
  y: number;
  dx: number;
  dy: number;
  radius: number;
  ink: number;
  register: number;
}

/** A register's column centre, 0..1: bass, low and low-mid across the bottom, their partners above. */
export function columnX(register: number): number {
  const span = 1 - 0.12 * 2;
  return 0.12 + (span * ((register % COLUMNS) + 0.5)) / COLUMNS;
}

/** Whether a register enters from the bottom (rising) or the top (falling). */
export const rises = (register: number): boolean => register < COLUMNS;

/** One register's emission this tick from its level (0..1); null below the noise floor. */
export function emissionFor(
  register: number,
  level: number,
  vigour: number,
  unit: () => number,
): Emission | null {
  if (level < 0.06) return null;
  const up = rises(register);
  const jitter = (unit() * 2 - 1) * LANE_HALF_WIDTH;
  const x = Math.min(Math.max(columnX(register) + jitter, 0.01), 0.99);
  return {
    x,
    y: up ? EDGE_INSET : 1 - EDGE_INSET,
    // a little lean toward the middle, so the flows meet rather than stand in their columns
    dx: (unit() * 2 - 1) * 10 + (0.5 - x) * 18,
    dy: (up ? 1 : -1) * PUSH * (0.35 + 0.65 * level) * vigour,
    radius: SPLAT_RADIUS * (0.6 + 1.1 * level),
    ink: (0.05 + 0.1 * level * level) * vigour,
    register,
  };
}

/** A big hit's whirlpool: spun into the middle band where the flows meet, sides alternating. */
export interface Whirlpool {
  x: number;
  y: number;
  spin: number;
  radius: number;
}
export function whirlpoolFor(onset: number, handed: 1 | -1, unit: () => number): Whirlpool {
  return {
    x: 0.15 + unit() * 0.7,
    y: 0.38 + unit() * 0.24,
    spin: handed * (110 + 90 * onset),
    radius: 0.007,
  };
}

/** How fast ink lets go, per second, from how many seconds it should be remembered. */
export function dyeDissipation(memorySeconds: number): number {
  return 1 / Math.max(3, memorySeconds);
}

export const WHIRLPOOL_ONSET = 0.62;
export const PULSE_ONSET = 0.35;
