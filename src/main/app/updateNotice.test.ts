import { describe, expect, it, vi } from "vitest";
import type { UpdateState } from "@shared/model";

vi.mock("electron", () => ({ Notification: class {} }));
const { shouldAnnounce } = await import("./updateNotice");

const offered = (version: string): UpdateState => ({
  phase: "available",
  version,
  percent: null,
  canDownload: true,
  url: "https://example.invalid/releases/latest",
  error: null,
});
const on = { updateCheck: true, updateNotified: null };

describe("shouldAnnounce", () => {
  it("announces an offered version while no window is in view", () => {
    expect(shouldAnnounce(offered("0.16.1"), on, false)).toBe(true);
  });

  it("stays quiet while the window is in view: the Update button says it there", () => {
    expect(shouldAnnounce(offered("0.16.1"), on, true)).toBe(false);
  });

  it("announces each version once", () => {
    expect(shouldAnnounce(offered("0.16.1"), { ...on, updateNotified: "0.16.1" }, false)).toBe(
      false,
    );
    expect(shouldAnnounce(offered("0.16.2"), { ...on, updateNotified: "0.16.1" }, false)).toBe(
      true,
    );
  });

  it("stays quiet with automatic checks off, and for anything but an offer", () => {
    expect(shouldAnnounce(offered("0.16.1"), { ...on, updateCheck: false }, false)).toBe(false);
    for (const phase of ["idle", "downloading", "downloaded", "error"] as const) {
      expect(shouldAnnounce({ ...offered("0.16.1"), phase }, on, false)).toBe(false);
    }
  });
});
