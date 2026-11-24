import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { recordLevel, recordTexture } from "./three";
import type { SceneRecord } from "./scenes/types";

function record(frames: number): SceneRecord {
  const bands = new Float32Array(frames * 6);
  for (let i = 0; i < frames; i++)
    for (let b = 0; b < 6; b++) bands[i * 6 + b] = ((i * 7 + b * 13) % 100) / 100;
  return { fps: 10, frames, bands, loud: new Float32Array(frames) };
}

describe("the record texture the walls and the heightfield read", () => {
  it("is uploaded as half floats, which WebGL2 filters on every GPU without an extension", () => {
    const tex = recordTexture(record(600), 64);
    expect(tex.texture.type).toBe(THREE.HalfFloatType);
    expect(tex.texture.format).toBe(THREE.RedFormat);
    expect(tex.texture.minFilter).toBe(THREE.LinearFilter);
    expect(tex.texture.image.data).toBeInstanceOf(Uint16Array);
  });

  it("reads on the CPU what the GPU holds, so a marker sits on its wall", () => {
    const tex = recordTexture(record(600), 64);
    const half = tex.texture.image.data as Uint16Array;
    tex.levels.forEach((v, i) => expect(v).toBe(THREE.DataUtils.fromHalfFloat(half[i])));
    expect(Math.max(...tex.levels)).toBeGreaterThan(0.3);
    // at a column's center, on a lane's center, the level is that cell's own
    const u = (5 + 0.5) / tex.columns;
    const lane = (2 + 0.5) / 6;
    expect(recordLevel(tex, u, lane)).toBeCloseTo(tex.levels[2 * tex.columns + 5], 6);
  });
});
