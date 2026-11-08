import { useStore } from "@/store";

// THE CHROME'S GROUND (0.15.0, the hygiene pass: the navigation panel and the playback bar each
// spelled the rule, and had drifted to different tones in dark). Clear under the full-window wash;
// in dark on the window's own ground; in light only, a panel tint that sets the frame back from
// the page, the bar's a little stronger behind its blur. A new piece of
// chrome takes a line here; the lint rule chrome-ground refuses the tint anywhere else, and S167
// measures the result.
const GROUND = {
  nav: "light:bg-panel/60",
  bar: "light:bg-panel/80 light:backdrop-blur",
} as const;

/** The classes for a piece of chrome's ground, or false where it sits on the window's own. */
export function useChromeGround(piece: keyof typeof GROUND): string | false {
  const ambientWindow = useStore((s) => s.ambientWindowActive);
  return !ambientWindow && GROUND[piece];
}
