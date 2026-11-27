import { describe, expect, it, vi } from "vitest";

vi.mock("@/api", () => ({ tt: { radioCover: () => Promise.resolve(null) } }));
vi.mock("@/store", () => ({ useStore: () => true }));
const { radioSongOf, stationArtMemory } = await import("./radioCover");

describe("the song a station announces", () => {
  it("splits the station's line under its name into artist and song", () => {
    expect(radioSongOf({ isRadio: true, subtitle: "Crowded House - Weather With You" })).toEqual({
      artist: "Crowded House",
      song: "Weather With You",
    });
  });

  it("is nothing off the radio, or for a line that doesn't split", () => {
    expect(
      radioSongOf({ isRadio: false, subtitle: "Crowded House - Weather With You" }),
    ).toBeNull();
    expect(radioSongOf({ isRadio: true, subtitle: "Breakfast with the Team" })).toBeNull();
    expect(radioSongOf({ isRadio: true, subtitle: null })).toBeNull();
    expect(radioSongOf(null)).toBeNull();
  });
});

describe("a station that sends its own song pictures", () => {
  it("keeps them once its picture changed with its song", () => {
    const m = stationArtMemory();
    expect(m.note("Paradise", "a", "https://p/1.jpg")).toBe(false);
    expect(m.note("Paradise", "a", "https://p/1.jpg")).toBe(false);
    expect(m.note("Paradise", "b", "https://p/2.jpg")).toBe(true);
    expect(m.note("Paradise", "c", "https://p/2.jpg")).toBe(true);
  });

  it("is not one while its logo stays the same from song to song", () => {
    const m = stationArtMemory();
    expect(m.note("Hits", "a", "https://logo")).toBe(false);
    expect(m.note("Hits", "b", "https://logo")).toBe(false);
    expect(m.note("Other", "a", "https://other")).toBe(false);
  });
});
