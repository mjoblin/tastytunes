import { useEffect, useState } from "react";
import type { ZonePlayStateState } from "@shared/smoip";

/**
 * A SCREEN LEFT ON (0.17.0, Display on other screens): a tablet or a TV can't be kept from
 * holding one still picture for hours, and some burn it in. So when the music has stopped for a
 * while the page rests: it dims, and its picture drifts a few pixels every minute; the music
 * starting again brings it back at once. Standby is darker still (the page goes black).
 *
 * A LIGHT PAGE RESTS DARK: dimmed paper reads as a flat grey, so once its fade is done a page in
 * the light theme turns to the dark one, already dim, and is back in light the moment the music
 * starts. A resting screen looks the same whichever theme it shows, and gives off less light.
 */

/** How long without music before the page rests. */
export const REST_AFTER_MS = 2 * 60_000;
/** How often a resting page moves, and how far from center it may go. */
export const DRIFT_EVERY_MS = 60_000;
export const DRIFT_PX = 18;
/** How bright a resting page is. */
export const REST_OPACITY = 0.35;
/** How long the dimming takes; a light page turns dark once it is done. */
export const REST_FADE_MS = 3_000;

/** Whether the streamer is making music, or about to (a track change passes through these). */
export const musicGoing = (state: ZonePlayStateState | null | undefined): boolean =>
  state === "play" || state === "buffering" || state === "connecting";

/** The next place a resting picture drifts to: within DRIFT_PX of center, `random` in [0, 1). */
export function driftTo(random: () => number = Math.random): [number, number] {
  const at = (): number => Math.round((random() * 2 - 1) * DRIFT_PX);
  return [at(), at()];
}

/** Whether the page rests, where its picture has drifted to, and whether its fade is done (when a
 *  light page shows the dark theme). */
export function useRest(going: boolean): {
  resting: boolean;
  offset: [number, number];
  dark: boolean;
} {
  const [resting, setResting] = useState(false);
  const [offset, setOffset] = useState<[number, number]>([0, 0]);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    if (going) {
      setResting(false);
      setOffset([0, 0]);
      return;
    }
    const t = setTimeout(() => setResting(true), REST_AFTER_MS);
    return () => clearTimeout(t);
  }, [going]);
  useEffect(() => {
    if (!resting) return;
    setOffset(driftTo());
    const t = setInterval(() => setOffset(driftTo()), DRIFT_EVERY_MS);
    return () => clearInterval(t);
  }, [resting]);
  useEffect(() => {
    if (!resting) {
      setDark(false);
      return;
    }
    const t = setTimeout(() => setDark(true), REST_FADE_MS);
    return () => clearTimeout(t);
  }, [resting]);
  return { resting, offset, dark };
}
