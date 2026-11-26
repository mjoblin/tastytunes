import { describe, expect, it, vi } from "vitest";
import type { ExportOptions } from "./exporter";

// The README states how many of the artist's pictures an export copies and how wide a Commons
// file can be from the constants the exporter and the photo lookup hold to, never as numbers
// typed into its text: here the constants are set to other values and the README follows.
const held = vi.hoisted(() => ({ max: 7, px: 960 }));
vi.mock("./pictureCaps", () => ({
  get ARTIST_PICTURES_MAX() {
    return held.max;
  },
}));
vi.mock("../lookups/commonsSizes", () => ({
  get COMMONS_CHOSEN_PX() {
    return held.px;
  },
}));

const { exportReadme } = await import("./exportReadme");

const opts: ExportOptions = { fill: false, redact: false, plays: false, audio: "link" };

describe("the README's numbers", () => {
  it("states how many of the artist's pictures are copied, and the Commons width", () => {
    for (const kind of ["track", "album"] as const) {
      const readme = exportReadme(kind, opts);
      expect(readme).toContain("At most seven of the artist's pictures are copied");
      expect(readme).toMatch(/A Commons file is copied at most 960 pixels\s+wide/);
      expect(readme).not.toMatch(/twelve of the artist's|1280/);
    }
  });

  it("writes a count in words up to twenty, and in digits past it", () => {
    held.max = 20;
    expect(exportReadme("track", opts)).toContain("At most twenty of the artist's pictures");
    held.max = 30;
    expect(exportReadme("track", opts)).toContain("At most 30 of the artist's pictures");
  });
});
