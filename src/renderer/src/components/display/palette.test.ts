/**
 * A scene's colors from its cover: worked out once and kept, plain art's answer kept with them, and
 * a cover that didn't come (the app or the page's server out of reach a moment) asked for again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchArt = vi.fn<(url: string) => Promise<{ dataUrl: string } | null>>();
const pixels = vi.fn<() => Promise<Uint8ClampedArray | null>>();
vi.mock("@/api", () => ({ tt: { fetchArt: (url: string) => fetchArt(url) } }));
vi.mock("@/lib/coverPixels", () => ({ coverPixels: () => pixels() }));
const { coverColors } = await import("./palette");

/** A 40 × 40 picture of one color. */
const solid = (r: number, g: number, b: number): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(40 * 40 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
  return data;
};
const COVER = { dataUrl: "data:image/png;base64,iVBOR" };

describe("a scene's colors from its cover", () => {
  beforeEach(() => {
    fetchArt.mockReset();
    pixels.mockReset();
  });

  it("asks for a cover that didn't come again, and keeps it once it does", async () => {
    fetchArt.mockResolvedValueOnce(null).mockResolvedValue(COVER);
    pixels.mockResolvedValue(solid(200, 40, 40));
    expect(await coverColors("/art/0000000000000000000000a1", false)).toBeNull();
    const colors = await coverColors("/art/0000000000000000000000a1", false);
    expect(colors?.accent.length).toBeGreaterThan(0);
    expect(colors?.tint).toBeDefined();
    expect(await coverColors("/art/0000000000000000000000a1", false)).toBe(colors);
    expect(fetchArt).toHaveBeenCalledTimes(2);
  });

  it("asks again after a fetch that failed outright", async () => {
    fetchArt.mockRejectedValueOnce(new Error("unreachable")).mockResolvedValue(COVER);
    pixels.mockResolvedValue(solid(40, 200, 40));
    expect(await coverColors("/art/0000000000000000000000a2", false)).toBeNull();
    expect(
      (await coverColors("/art/0000000000000000000000a2", false))?.accent.length,
    ).toBeGreaterThan(0);
  });

  it("asks again after a picture whose pixels couldn't be read", async () => {
    fetchArt.mockResolvedValue(COVER);
    pixels.mockResolvedValueOnce(null).mockResolvedValue(solid(40, 40, 200));
    expect(await coverColors("/art/0000000000000000000000a3", false)).toBeNull();
    expect(
      (await coverColors("/art/0000000000000000000000a3", false))?.accent.length,
    ).toBeGreaterThan(0);
  });

  it("keeps plain art's answer: no hues of its own, never asked for again", async () => {
    fetchArt.mockResolvedValue(COVER);
    pixels.mockResolvedValue(solid(128, 128, 128));
    const plain = await coverColors("/art/0000000000000000000000a4", false);
    expect(plain).toEqual({ accent: [] });
    expect(await coverColors("/art/0000000000000000000000a4", false)).toBe(plain);
    expect(fetchArt).toHaveBeenCalledTimes(1);
  });
});
