import { describe, expect, it } from "vitest";
import { DRIFT_PX, driftTo, musicGoing } from "./rest";

describe("a screen left on", () => {
  it("rests only when the music has stopped, never through a track change", () => {
    for (const s of ["play", "buffering", "connecting"] as const) expect(musicGoing(s)).toBe(true);
    for (const s of ["pause", "stop", "ready", null] as const) expect(musicGoing(s)).toBe(false);
  });

  it("drifts within a few pixels of center", () => {
    expect(driftTo(() => 0)).toEqual([-DRIFT_PX, -DRIFT_PX]);
    expect(driftTo(() => 0.5)).toEqual([0, 0]);
    const seq = [0.1, 0.9];
    let i = 0;
    const [x, y] = driftTo(() => seq[i++]);
    expect(Math.abs(x)).toBeLessThanOrEqual(DRIFT_PX);
    expect(Math.abs(y)).toBeLessThanOrEqual(DRIFT_PX);
  });
});
