import { describe, expect, it } from "vitest";
import {
  analysisOutdated,
  FEATURES_VERSION,
  measuredWaveformOnly,
  type AnalysisFeatures,
  type AudioAnalysis,
} from "./audio";

const whole = (over: Partial<AudioAnalysis> = {}): AudioAnalysis => ({
  dr: 11,
  peakDb: -0.3,
  rmsDb: -14,
  crestDb: 13.7,
  peakQ: [],
  rmsQ: [],
  lufs: -12,
  lra: 6,
  truePeakDb: -0.2,
  loudHist: [1, 2],
  strip: null,
  onsets: null,
  features: { version: FEATURES_VERSION } as AnalysisFeatures,
  ...over,
});

describe("whether a stored analysis is current", () => {
  it("is outdated when any measurement predates it, or the features are an older version's", () => {
    expect(analysisOutdated(whole())).toBe(false);
    for (const field of ["loudHist", "strip", "onsets", "features"] as const) {
      const st = whole();
      delete st[field];
      expect(analysisOutdated(st), field).toBe(true);
    }
    expect(
      analysisOutdated(whole({ features: { version: FEATURES_VERSION - 1 } as AnalysisFeatures })),
    ).toBe(true);
  });

  it("keeps a measurement stored as null: measured as far as the file allows", () => {
    const waveform = whole({
      loudHist: null,
      strip: null,
      onsets: null,
      features: null,
      lufs: null,
    });
    expect(analysisOutdated(waveform)).toBe(false);
    expect(measuredWaveformOnly(waveform)).toBe(true);
    expect(measuredWaveformOnly(whole())).toBe(false);
  });
});
