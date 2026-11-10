// THE ACCENT FROM THE ALBUM ART (Settings › Appearance › Accent color › Album art): the cover's average color,
// its vivid pixels counting most, the hue kept and the saturation and lightness held to the theme's
// range. A cover with no real color in it keeps the built accent: a grey's hue is only rounding
// noise, and lifting its saturation would turn that noise into a strong, arbitrary color. A cover
// with a little color gets a soft accent of that color, as soft as the default accent, growing stronger
// as the cover's color does until a clearly colorful cover's accent is at full strength, so there is
// no line where a pale cover jumps to a loud color. On paper the accent is also text and a button's
// fill, so it darkens until each of those forms holds its floor. Pure, so it can be tested;
// useArtAccent draws the cover and passes its pixels.

import { hslToRgb, rgbToHsl, roundRgb, type Rgb } from "./color";

/** How much real color a cover needs: the summed chroma of its pixels (a 32 × 32 sample), and the
 *  chroma of their average (0–1), under which the average is a grey with a cast. */
export const MIN_COLOR = 3;
export const MIN_AVERAGE_CHROMA = 0.02;

/** The accent's strength follows the cover's color: at MIN_AVERAGE_CHROMA it is as soft as the
 *  default accent, sand (its HSL saturation in each theme; the test pins it to styles.css), and by
 *  FULL_CHROMA, a clearly colorful cover, it is at full strength (50% to 85%). */
export const SOFT_SATURATION = { dark: 0.28, light: 0.14 };
export const FULL_CHROMA = 0.12;

/** The light theme's grounds and the accent's darker forms, as styles.css draws them (the test
 *  pins each one to it). The forms are sRGB mixes of the accent toward black, or its wash over a
 *  ground. */
export const LIGHT = {
  paper: [242, 238, 230] as Rgb, // --color-bg
  raised: [224, 218, 204] as Rgb, // --color-raised, the darkest ground the accent's text sits on
  ink: 0.69, // --color-accentink, the accent as text
  inkWash: 0.57, // --color-accentink-wash, as text on its own wash
  wash: 0.18, // --color-accentdim, the wash
  button: 0.78, // --color-accentbutton, a button's fill under paper-colored text
};

/** WCAG AA: 4.5:1 for text, 3:1 for a control or graphic. */
const TEXT_FLOOR = 4.5;
const GRAPHIC_FLOOR = 3;

/** The accent for a cover's pixels (RGBA, as a canvas returns them), or null to keep the built
 *  accent. */
export function artAccent(data: ArrayLike<number>, theme: "dark" | "light"): Rgb | null {
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let weight = 0;
  let color = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] < 200) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 32 || min > 232) continue; // near-black and near-white say nothing about the color
    const chroma = (max - min) / 255;
    const w = chroma + 0.05; // vivid pixels count most; grey ones a little, to temper a small patch
    wr += r * w;
    wg += g * w;
    wb += b * w;
    weight += w;
    color += chroma;
  }
  if (color < MIN_COLOR) return null;
  const avg: Rgb = [wr / weight, wg / weight, wb / weight];
  const chroma = (Math.max(...avg) - Math.min(...avg)) / 255;
  if (chroma < MIN_AVERAGE_CHROMA) return null;

  const [h, s, l] = rgbToHsl(...avg);
  const full = Math.min(Math.max(s, 0.5), 0.85);
  const soft = SOFT_SATURATION[theme];
  const sat = soft + (full - soft) * strength(chroma);
  if (theme === "dark") return roundRgb(hslToRgb(h, sat, Math.min(Math.max(l, 0.55), 0.68)));
  // paper: a darker range, then darker still until every form reads
  let light = Math.min(Math.max(l, 0.34), 0.46);
  let rgb = roundRgb(hslToRgb(h, sat, light)); // judged as drawn, in whole steps
  while (!holdsOnPaper(rgb) && light > 0.1) {
    light -= 0.005;
    rgb = roundRgb(hslToRgb(h, sat, light));
  }
  return rgb;
}

/** How far a cover's color takes its accent from soft to full strength (0–1), eased at both ends. */
function strength(chroma: number): number {
  const t = Math.min(
    Math.max((chroma - MIN_AVERAGE_CHROMA) / (FULL_CHROMA - MIN_AVERAGE_CHROMA), 0),
    1,
  );
  return t * t * (3 - 2 * t);
}

/** Whether an accent's forms on paper all hold their floors. */
export function holdsOnPaper(fill: Rgb): boolean {
  const toward = (k: number): Rgb => [fill[0] * k, fill[1] * k, fill[2] * k];
  const wash = LIGHT.raised.map((g, i) => fill[i] * LIGHT.wash + g * (1 - LIGHT.wash)) as Rgb;
  return (
    contrast(fill, LIGHT.paper) >= GRAPHIC_FLOOR &&
    contrast(toward(LIGHT.ink), LIGHT.raised) >= TEXT_FLOOR &&
    contrast(toward(LIGHT.inkWash), wash) >= TEXT_FLOOR &&
    contrast(LIGHT.paper, toward(LIGHT.button)) >= TEXT_FLOOR
  );
}

export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
