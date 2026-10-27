/**
 * Only a card-sized picture is kept: a card's cover (480 px, a server's or the app's), never a
 * chosen artist picture (up to 1,200 px) or a picture that came as it was.
 */
import { describe, expect, it } from "vitest";
import { KEEP_ART_MAX_PX, keepable } from "./artKeep";

describe("keepable", () => {
  it("keeps a card's cover, square or not", () => {
    expect(keepable(480, 480)).toBe(true);
    expect(keepable(320, 320)).toBe(true);
    expect(keepable(480, 360)).toBe(true);
    expect(keepable(KEEP_ART_MAX_PX, KEEP_ART_MAX_PX)).toBe(true);
  });
  it("leaves anything larger than a card, and a picture with no size", () => {
    expect(keepable(1200, 900)).toBe(false);
    expect(keepable(3000, 3000)).toBe(false);
    expect(keepable(480, 1200)).toBe(false);
    expect(keepable(0, 0)).toBe(false);
  });
});
