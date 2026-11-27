/**
 * A scene's colors from its cover: worked out once and kept, plain art's answer kept with them, and
 * a cover that didn't come (the app or the page's server out of reach a moment) asked for again,
 * after a beat and a longer one as the wash's is, and at the next ask after those.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/** A cover's colors once every ask has had its time (the re-asks at 3 s and 10 s). */
async function settled<T>(asked: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(13_000);
  return asked;
}

describe("a scene's colors from its cover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchArt.mockReset();
    pixels.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for a cover that didn't come again after a beat, and keeps it once it does", async () => {
    fetchArt.mockResolvedValueOnce(null).mockResolvedValue(COVER);
    pixels.mockResolvedValue(solid(200, 40, 40));
    const asked = coverColors("/art/0000000000000000000000a1", false);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchArt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const colors = await asked;
    expect(fetchArt).toHaveBeenCalledTimes(2);
    expect(colors?.accent.length).toBeGreaterThan(0);
    expect(colors?.tint).toBeDefined();
    expect(await coverColors("/art/0000000000000000000000a1", false)).toBe(colors);
    expect(fetchArt).toHaveBeenCalledTimes(2);
  });

  it("asks at 3 s and 10 s, as the wash does, then lets the miss go for the next ask", async () => {
    fetchArt.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    fetchArt.mockResolvedValue(COVER);
    pixels.mockResolvedValue(solid(200, 120, 40));
    const asked = coverColors("/art/0000000000000000000000a5", false);
    // a second scene asking meanwhile shares that ask
    expect(coverColors("/art/0000000000000000000000a5", false)).toBe(asked);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchArt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchArt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchArt).toHaveBeenCalledTimes(3);
    expect(await asked).toBeNull();
    // the next ask asks afresh
    expect(
      (await coverColors("/art/0000000000000000000000a5", false))?.accent.length,
    ).toBeGreaterThan(0);
    expect(fetchArt).toHaveBeenCalledTimes(4);
  });

  it("asks again after a fetch that failed outright", async () => {
    fetchArt.mockRejectedValueOnce(new Error("unreachable")).mockResolvedValue(COVER);
    pixels.mockResolvedValue(solid(40, 200, 40));
    expect(
      (await settled(coverColors("/art/0000000000000000000000a2", false)))?.accent.length,
    ).toBeGreaterThan(0);
    expect(fetchArt).toHaveBeenCalledTimes(2);
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
