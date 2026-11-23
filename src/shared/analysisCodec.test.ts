import { describe, expect, it } from "vitest";
import {
  featuresFromStored,
  featuresToStored,
  onsetsFromStored,
  onsetsToStored,
  stripFromStored,
  stripToStored,
  type Features,
} from "./analysisCodec";

const features: Features = {
  beats: { bpm: 120, confidence: 0.8, downbeat: 0, times: Float32Array.from([0.5, 1, 1.5]) },
  sections: {
    bounds: Float32Array.from([0, 30, 60]),
    kinds: Uint8Array.from([0, 1]),
    energy: Float32Array.from([0.2, 0.8]),
  },
  chroma: null,
  key: null,
  changes: Float32Array.from([12.3]),
  stereo: null,
  timbre: null,
  silences: Float32Array.from([100, 101.5]),
  drops: {
    buildFrom: Float32Array.from([40]),
    at: Float32Array.from([45.5]),
    strength: Float32Array.from([1]),
    chill: Float32Array.from([3]),
    breath: Float32Array.from([1]),
    cut: Float32Array.from([0.5]),
  },
};

describe("the analysis's packed formats, read where main reads them", () => {
  it("round-trips the features to the precision they are stored at", () => {
    const back = featuresFromStored(featuresToStored(features));
    expect(back.beats?.bpm).toBe(120);
    expect(Array.from(back.beats!.times)).toEqual([0.5, 1, 1.5]);
    expect(Array.from(back.sections!.bounds)).toEqual([0, 30, 60]);
    expect(Array.from(back.silences)).toEqual([100, 101.5]);
    expect(back.drops.at[0]).toBeCloseTo(45.5, 1);
    expect(back.drops.buildFrom[0]).toBeCloseTo(40, 1);
  });

  it("round-trips the onsets and the strip", () => {
    const onsets = {
      at: Float32Array.from([0.01, 0.5]),
      strength: Float32Array.from([1, 0.5]),
      type: Uint8Array.from([0, 2]),
    };
    const back = onsetsFromStored(onsetsToStored(onsets));
    expect(Array.from(back.type)).toEqual([0, 2]);
    expect(back.at[1]).toBeCloseTo(0.5, 2);
    const strip = {
      fps: 10,
      bands: Uint8Array.from([1, 2, 3, 4, 5, 6]),
      loud: Uint8Array.from([9]),
    };
    expect(stripFromStored(stripToStored(strip))).toEqual(strip);
  });
});
