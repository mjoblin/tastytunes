/**
 * The color conversions' one home: RGB to HSL and back for the primaries, a grey and a mixed color;
 * a round trip lands where it began; hslToRgb is unrounded and roundRgb draws it in whole steps.
 */
import { describe, expect, it } from "vitest";
import { hslToRgb, rgbToHsl, roundRgb } from "./color";

describe("rgbToHsl and hslToRgb", () => {
  it("read the primaries and a grey", () => {
    expect(rgbToHsl(255, 0, 0)).toEqual([0, 1, 0.5]);
    expect(rgbToHsl(0, 255, 0)[0]).toBeCloseTo(1 / 3);
    expect(rgbToHsl(0, 0, 255)[0]).toBeCloseTo(2 / 3);
    expect(rgbToHsl(128, 128, 128)).toEqual([0, 0, 128 / 255]);
  });

  it("go there and back", () => {
    const cases: [number, number, number][] = [
      [255, 0, 0],
      [132, 172, 162],
      [188, 169, 136],
      [12, 200, 77],
      [240, 168, 72],
    ];
    for (const c of cases) {
      expect(roundRgb(hslToRgb(...rgbToHsl(...c)))).toEqual(c);
    }
  });

  it("leave rounding to the caller", () => {
    const [r] = hslToRgb(0, 0.5, 0.33);
    expect(Number.isInteger(r)).toBe(false);
    expect(roundRgb([1.4, 1.5, 254.6])).toEqual([1, 2, 255]);
  });
});
