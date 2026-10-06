/**
 * FRAME TIMING every scene shares (after packscape's stage/clock). A scene
 * stepped by a raw frame delta is one clock event from breaking: a hidden
 * window hands over seconds and teleports everything; a clock adjustment
 * hands over a NEGATIVE delta and ages things backwards; one NaN poisons a
 * position forever. Clamping at the point of use is the same fix in every
 * scene, so it lives here. Nothing here reads the clock itself.
 */

/** Longest step a scene may take in one frame. */
export const MAX_FRAME_SECONDS = 0.1;

/** A frame delta in seconds, finite and within [0, MAX_FRAME_SECONDS]. */
export const frameDelta = (delta: number): number =>
  !Number.isFinite(delta) || delta <= 0 ? 0 : Math.min(delta, MAX_FRAME_SECONDS);

/**
 * Exponential approach with a TIME CONSTANT in seconds, frame-rate
 * independent exactly: two half frames compose to one whole frame because
 * exp does. After tau the gap has closed by 63%, after three by 95%. The
 * form every scene reaches for first, `v += (t - v) * 0.1`, settles twice
 * as fast on a 120 Hz display; this one never. Nonsense in any argument
 * leaves the current value alone rather than poisoning it.
 */
export const easeTowards = (current: number, target: number, dt: number, tau: number): number => {
  if (!Number.isFinite(target)) return current;
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(dt) || dt <= 0) return current;
  return current + (target - current) * (1 - Math.exp(-dt / Math.max(tau, 1 / 120)));
};

/**
 * THE BREATH: a fast attack and a slow release. A hit reaches the picture
 * inside its attack; the calm after takes the release to settle. Asymmetric
 * on purpose: symmetric easing at either constant reads as flicker or as
 * nothing (packscape's dream). Both constants in seconds.
 */
export class Breath {
  value: number;
  constructor(
    readonly attackTau: number,
    readonly releaseTau: number,
    initial = 0,
  ) {
    this.value = initial;
  }
  step(target: number, dt: number): number {
    this.value = easeTowards(
      this.value,
      target,
      dt,
      target > this.value ? this.attackTau : this.releaseTau,
    );
    return this.value;
  }
  snap(value: number): void {
    if (Number.isFinite(value)) this.value = value;
  }
}
