/**
 * A PRESS THAT ACTS ONLY WHEN HELD (0.17.0, standby on another screen): the power disc puts the
 * streamer in standby only for a press held STANDBY_HOLD_MS, never for a tap, so a brushing hand
 * or a tap meant for the volume beside it can't send the room to sleep. A ring fills around the
 * disc over the hold, and goes back in RING_BACK_MS when the press ends early, with a hint saying
 * how standby is reached (display/PageTransport).
 */

/** How long the power disc is held for standby. */
export const STANDBY_HOLD_MS = 750;
/** The ring's way back when a press ends early. */
export const RING_BACK_MS = 150;
/** How long the hint after a short press stays. */
export const SHORT_HINT_MS = 2_000;

export interface HoldPress {
  /** The press began: `held` follows after the hold, unless it ends first. */
  down(): void;
  /** The press ended (lifted, left the disc, cancelled): `short` when it ended before the hold.
   *  A second end (the lift after a leave) is nothing. */
  end(): void;
  /** Let go with nothing said (the disc is gone). */
  stop(): void;
}

/** A press that calls `held` once when it lasts `ms`, and `short` when it ends before. */
export function holdPress(ms: number, on: { held(): void; short(): void }): HoldPress {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    down() {
      stop();
      timer = setTimeout(() => {
        timer = null;
        on.held();
      }, ms);
    },
    end() {
      if (!timer) return;
      stop();
      on.short();
    },
    stop,
  };
}
