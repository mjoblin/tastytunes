import { describe, expect, it } from "vitest";
import { mbidOf, photosOf } from "./fanart";

describe("fanart.tv's artist photos", () => {
  it("are looked up by the MusicBrainz id at the end of the artist's MusicBrainz page", () => {
    expect(mbidOf("https://musicbrainz.org/artist/a74b1b7f-71a5-4011-9441-d0b5e4122711")).toBe(
      "a74b1b7f-71a5-4011-9441-d0b5e4122711",
    );
    expect(mbidOf("https://musicbrainz.org/artist/a74b1b7f-71a5-4011-9441-d0b5e4122711?x=1")).toBe(
      "a74b1b7f-71a5-4011-9441-d0b5e4122711",
    );
    expect(mbidOf("https://musicbrainz.org/release/abc")).toBeNull();
    expect(mbidOf(null)).toBeNull();
  });

  it("are the artist's square photos, most liked first, each once, web addresses only", () => {
    const body = {
      name: "Band",
      artistthumb: [
        { url: "https://assets.fanart.tv/fanart/a.jpg", likes: "1" },
        { url: "https://assets.fanart.tv/fanart/b.jpg", likes: "7" },
        { url: "https://assets.fanart.tv/fanart/a.jpg", likes: "0" },
        { url: "javascript:alert(1)", likes: "9" },
      ],
      artistbackground: [{ url: "https://assets.fanart.tv/fanart/wide.jpg", likes: "50" }],
    };
    expect(photosOf(body)).toEqual([
      "https://assets.fanart.tv/fanart/b.jpg",
      "https://assets.fanart.tv/fanart/a.jpg",
    ]);
    expect(photosOf({ albums: {} })).toEqual([]);
    expect(photosOf(null)).toEqual([]);
  });
});
