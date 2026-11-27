/**
 * The deck scenes' picture: decoded once per address and kept, and one that didn't come asked for
 * again after a beat and a longer one, as the wash's is, and at the next ask after those.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchArt = vi.fn<(url: string) => Promise<{ dataUrl: string } | null>>();
vi.mock("@/api", () => ({ tt: { fetchArt: (url: string) => fetchArt(url) } }));
/** A picture that decodes, as a browser's does. */
class Picture {
  src = "";
  decode(): Promise<void> {
    return Promise.resolve();
  }
}
vi.stubGlobal("Image", Picture);
const { artImage } = await import("./feed");

const COVER = { dataUrl: "data:image/png;base64,iVBOR" };

describe("the deck scenes' picture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchArt.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for a picture that didn't come again after a beat, and keeps it once it does", async () => {
    fetchArt.mockResolvedValueOnce(null).mockResolvedValue(COVER);
    const asked = artImage("/art/0000000000000000000000b1");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchArt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const img = await asked;
    expect(img?.src).toBe(COVER.dataUrl);
    expect(await artImage("/art/0000000000000000000000b1")).toBe(img);
    expect(fetchArt).toHaveBeenCalledTimes(2);
  });

  it("asks at 3 s and 10 s, then lets the miss go for the next ask", async () => {
    fetchArt.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    fetchArt.mockResolvedValue(COVER);
    const asked = artImage("/art/0000000000000000000000b2");
    await vi.advanceTimersByTimeAsync(13_000);
    expect(fetchArt).toHaveBeenCalledTimes(3);
    expect(await asked).toBeNull();
    expect((await artImage("/art/0000000000000000000000b2"))?.src).toBe(COVER.dataUrl);
    expect(fetchArt).toHaveBeenCalledTimes(4);
  });

  it("draws a picture already in hand as it is, never asking for it", async () => {
    const inHand = "data:image/jpeg;base64,/9j/4AAQ";
    expect((await artImage(inHand))?.src).toBe(inHand);
    expect(fetchArt).not.toHaveBeenCalled();
  });
});
