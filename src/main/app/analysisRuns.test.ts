import { beforeEach, describe, expect, it } from "vitest";
import {
  analysisAsked,
  analysisRunning,
  windowAnalysisGone,
  windowAnalyzing,
} from "./analysisRuns";

beforeEach(() => windowAnalysisGone());

describe("what the window is analyzing", () => {
  it("counts an album asked for as running until the window picks it up, then by its word", () => {
    analysisAsked("srv", "al-1", 1_000);
    expect(analysisRunning("srv", "al-1", 5_000)).toBe(true);
    windowAnalyzing([{ serverUdn: "srv", albumId: "al-1" }]);
    // long past the pickup's grace, the window still names it
    expect(analysisRunning("srv", "al-1", 600_000)).toBe(true);
    windowAnalyzing([]);
    expect(analysisRunning("srv", "al-1", 600_000)).toBe(false);
  });

  it("lets an ask the window never names lapse", () => {
    analysisAsked("srv", "al-2", 0);
    windowAnalyzing([{ serverUdn: "srv", albumId: "other" }]);
    expect(analysisRunning("srv", "al-2", 14_000)).toBe(true);
    expect(analysisRunning("srv", "al-2", 16_000)).toBe(false);
  });

  it("forgets the queue when the window closes or reloads, and reads a bad list as empty", () => {
    windowAnalyzing([{ serverUdn: "srv", albumId: "al-3" }]);
    windowAnalysisGone();
    expect(analysisRunning("srv", "al-3", 0)).toBe(false);
    windowAnalyzing([{ serverUdn: "srv", albumId: "al-3" }]);
    windowAnalyzing("nonsense");
    expect(analysisRunning("srv", "al-3", 0)).toBe(false);
    windowAnalyzing([{ serverUdn: 7, albumId: "al-3" }, null]);
    expect(analysisRunning("srv", "al-3", 0)).toBe(false);
  });
});
