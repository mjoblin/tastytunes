/**
 * The Tracks view's tempo facet: twenty-bpm bands, the measured tracks only, slowest first.
 */
import { describe, expect, it } from "vitest";
import { drOptionsOf, tempoBandLabel, tempoBandOf, tempoOptionsOf } from "./lensShared";

describe("the tempo facet", () => {
  it("puts a tempo in its twenty-bpm band, the ends open", () => {
    expect(tempoBandOf(62)).toBe("0");
    expect(tempoBandOf(79)).toBe("0");
    expect(tempoBandOf(80)).toBe("80");
    expect(tempoBandOf(119)).toBe("100");
    expect(tempoBandOf(165)).toBe("160");
    expect(tempoBandOf(180)).toBe("180");
    expect(tempoBandOf(212)).toBe("180");
    expect(tempoBandOf(null)).toBeNull();
    expect(tempoBandOf(0)).toBeNull();
  });

  it("names the bands as a reader asks for them", () => {
    expect(tempoBandLabel("0")).toBe("Under 80 bpm");
    expect(tempoBandLabel("160")).toBe("160–179 bpm");
    expect(tempoBandLabel("180")).toBe("180 bpm and up");
  });

  it("offers the bands the measured tracks fall in, slowest first, with their counts", () => {
    expect(tempoOptionsOf([120, 165, null, 170, 72, 121])).toEqual([
      { value: "0", label: "Under 80 bpm", count: 1 },
      { value: "120", label: "120–139 bpm", count: 2 },
      { value: "160", label: "160–179 bpm", count: 2 },
    ]);
    expect(tempoOptionsOf([null, null])).toEqual([]);
    // the DR facet beside it, for the order's contrast: most dynamic first
    expect(drOptionsOf([9, 12]).map((o) => o.value)).toEqual(["12", "9"]);
  });
});
