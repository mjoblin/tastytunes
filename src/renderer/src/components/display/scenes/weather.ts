import type { SceneFrame } from "./types";
import { easeTowards } from "../clock";
import { lerp } from "./lib";

/**
 * SECTIONS AS WEATHER (after ThreeUI's Landscape, which cross-fades whole
 * systems: time of day, rain, storm, snow). The analysis knows the song's
 * sections, which of them are the chorus and how much energy each carries,
 * so Terrain's sky and Survey's ground wear a WEATHER per section: warmth
 * (toward gold), glow (a brighter sky), haze (mist over the far ranges) and
 * stars (a clear quiet night). Each change is eased over about two seconds
 * from the boundary the analysis found, and the next section's weather
 * arrives early through the last few seconds before it, so the sky
 * brightens toward a chorus before the chorus lands. One home for both
 * scenes, so they can never read a section two ways.
 */
export interface Weather {
  warm: number;
  glow: number;
  haze: number;
  stars: number;
}

/** No sections (radio, an older analysis): what both scenes looked like before there was weather. */
export const NEUTRAL: Weather = { warm: 0, glow: 0.5, haze: 0, stars: 0.5 };
/** The time constant of a change in seconds: 95% of the way in about two. */
export const WEATHER_TAU = 0.7;
/** How many seconds before a boundary the next section's weather begins to show, and how much of it. */
export const ANTICIPATE_SECONDS = 4;
export const ANTICIPATE_SHARE = 0.6;

/** A section's weather from its kind and its energy (0..1 against the track's loudest). */
export function weatherFor(kind: "chorus" | "other", energy: number): Weather {
  const e = Math.min(1, Math.max(0, energy));
  if (kind === "chorus")
    return {
      warm: 0.6 + 0.4 * e,
      glow: 0.55 + 0.45 * e,
      haze: 0.15 + 0.35 * e,
      stars: 0.15,
    };
  return {
    warm: 0.15 * e,
    glow: 0.15 + 0.45 * e,
    haze: 0.45 * (1 - e),
    stars: 0.45 + 0.55 * (1 - e),
  };
}

const blend = (a: Weather, b: Weather, t: number): Weather => ({
  warm: lerp(a.warm, b.warm, t),
  glow: lerp(a.glow, b.glow, t),
  haze: lerp(a.haze, b.haze, t),
  stars: lerp(a.stars, b.stars, t),
});

/** The weather a frame asks for: this section's, leaning toward the next one's as the
 *  boundary nears. */
export function targetWeather(section: SceneFrame["section"]): Weather {
  if (!section) return NEUTRAL;
  const here = weatherFor(section.kind, section.energy);
  if (section.nextKind && section.untilNext < ANTICIPATE_SECONDS) {
    const t = (1 - section.untilNext / ANTICIPATE_SECONDS) * ANTICIPATE_SHARE;
    return blend(here, weatherFor(section.nextKind, section.nextEnergy), t);
  }
  return here;
}

/** The eased weather a scene draws with; step it once a frame. */
export class WeatherState {
  readonly value: Weather = { ...NEUTRAL };

  step(f: SceneFrame): Weather {
    const t = targetWeather(f.section);
    // under reduced motion the changes take twice as long
    const tau = f.reduced ? WEATHER_TAU * 2 : WEATHER_TAU;
    const v = this.value;
    v.warm = easeTowards(v.warm, t.warm, f.dt, tau);
    v.glow = easeTowards(v.glow, t.glow, f.dt, tau);
    v.haze = easeTowards(v.haze, t.haze, f.dt, tau);
    v.stars = easeTowards(v.stars, t.stars, f.dt, tau);
    return v;
  }
}
