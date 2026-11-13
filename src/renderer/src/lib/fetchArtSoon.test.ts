/**
 * A cover through main, asked again when main could not answer; a picture already in hand (a data
 * URL: the file's embedded cover, the log's own copy) answered as it is, never sent to main, which
 * fetches only addresses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchArt = vi.fn<(url: string) => Promise<{ dataUrl: string } | null>>();
vi.mock("@/api", () => ({ tt: { fetchArt: (url: string) => fetchArt(url) } }));
const { fetchArtSoon } = await import("./fetchArtSoon");

describe("fetchArtSoon", () => {
  beforeEach(() => fetchArt.mockReset());

  it("answers a picture already in hand as it is, without asking main", async () => {
    const inHand = "data:image/jpeg;base64,/9j/4AAQ";
    expect(await fetchArtSoon(inHand, () => true)).toEqual({ dataUrl: inHand });
    expect(fetchArt).not.toHaveBeenCalled();
  });

  it("fetches an address through main", async () => {
    fetchArt.mockResolvedValueOnce({ dataUrl: "data:image/png;base64,iVBOR" });
    expect(await fetchArtSoon("http://192.0.2.1/art.jpg", () => true)).toEqual({
      dataUrl: "data:image/png;base64,iVBOR",
    });
    expect(fetchArt).toHaveBeenCalledWith("http://192.0.2.1/art.jpg");
  });
});
