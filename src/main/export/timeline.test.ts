import { describe, expect, it } from "vitest";
import type { Features } from "@shared/analysisCodec";
import { buildTimeline } from "./timeline";

const features = {
  sections: {
    bounds: Float32Array.from([30, 60]),
    kinds: Uint8Array.from([0, 1, 1]),
    energy: Float32Array.from([0.2, 0.9, 0.85]),
  },
  drops: {
    buildFrom: Float32Array.from([50]),
    at: Float32Array.from([60]),
    strength: Float32Array.from([0.7]),
    chill: Float32Array.from([1]),
    breath: Float32Array.from([1]),
    cut: Float32Array.from([1]),
  },
  silences: Float32Array.from([88, 90]),
} as unknown as Features;
const strip = {
  fps: 2,
  bands: new Uint8Array(0),
  loud: Uint8Array.from({ length: 180 }, (_, i) => (i >= 120 && i < 122 ? 255 : 100)),
};
const lyrics = [
  { at_seconds: 5, text: "first line" },
  { at_seconds: 35, text: "into the part that repeats" },
  { at_seconds: 70, text: "last line" },
];

describe("the timeline built for the reader", () => {
  it("gives each section its lyric lines and says which part comes back loudest, never verse or chorus", () => {
    const { sections } = buildTimeline(features, strip, lyrics, 90);
    expect(sections.map((s) => [s.start_seconds, s.end_seconds, s.kind])).toEqual([
      [0, 30, "other"],
      [30, 60, "repeated_loud"],
      [60, 90, "repeated_loud"],
    ]);
    expect(sections[1].lyrics.map((l) => l.text)).toEqual(["into the part that repeats"]);
    expect(JSON.stringify(sections)).not.toMatch(/verse|chorus/);
    expect(sections[0].mean_loudness_dbfs).toBeCloseTo(-36.5, 0);
  });

  it("lists the moments to cut on, in order", () => {
    const { moments } = buildTimeline(features, strip, lyrics, 90);
    expect(moments.map((m) => m.what)).toEqual([
      "quietest_second",
      "first_lyric",
      "build_starts",
      "drop",
      "loudest_second",
      "last_lyric",
      "silence_starts",
      "silence_ends",
    ]);
    const at = moments.map((m) => m.at_seconds);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(moments.find((m) => m.what === "drop")).toEqual({
      at_seconds: 60,
      what: "drop",
      strength: 0.7,
    });
    expect(moments.find((m) => m.what === "loudest_second")?.at_seconds).toBe(60);
  });

  it("runs the last section to the strip's end when the length is unknown", () => {
    const { sections } = buildTimeline(features, strip, [], null);
    expect(sections.at(-1)?.end_seconds).toBe(90);
  });

  it("is empty, not wrong, without an analysis or lyrics", () => {
    expect(buildTimeline(null, null, [], null)).toEqual({ sections: [], moments: [] });
  });
});
