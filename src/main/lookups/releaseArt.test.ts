import { describe, expect, it } from "vitest";
import { chooseRelease, imagesOf, RELEASE_IMAGES_MAX } from "./releaseArt";

const rel = (
  id: string,
  count: number,
  tracks: number,
  over: Record<string, unknown> = {},
): Parameters<typeof chooseRelease>[0][number] => ({
  id,
  status: "Official",
  date: "1997-06-16",
  media: [{ format: "CD", "track-count": tracks }],
  "cover-art-archive": { artwork: count > 0, count, back: count > 1 },
  ...over,
});

describe("the release whose scans stand for the album", () => {
  it("is the edition with the library's track count, then the most scans", () => {
    const releases = [rel("deluxe", 21, 27), rel("plain", 17, 12), rel("rich", 27, 12)];
    expect(chooseRelease(releases, 12)?.id).toBe("rich");
    expect(chooseRelease(releases, 27)?.id).toBe("deluxe");
    // the track count unknown: the most scans
    expect(chooseRelease(releases, null)?.id).toBe("rich");
  });

  it("prefers official, then a back cover, then the earliest, and none without scans", () => {
    expect(
      chooseRelease([rel("bootleg", 30, 12, { status: "Bootleg" }), rel("official", 5, 12)], 12)
        ?.id,
    ).toBe("official");
    expect(
      chooseRelease(
        [rel("late", 4, 12, { date: "2016-01-01" }), rel("early", 4, 12, { date: "1997-01-01" })],
        12,
      )?.id,
    ).toBe("early");
    expect(chooseRelease([rel("bare", 0, 12)], 12)).toBeNull();
  });
});

describe("a release's listing as the export uses it", () => {
  it("keeps the record's own scans in reading order at 1200 px, the raw ones left out", () => {
    const got = imagesOf({
      images: [
        { types: ["Booklet"], image: "b.jpg", thumbnails: { "1200": "b-1200.jpg" } },
        { types: ["Raw/Unedited"], image: "raw.jpg" },
        { types: ["Front"], image: "f.jpg", thumbnails: { large: "f-large.jpg" } },
        { types: ["Back"], comment: " rear ", image: "back.jpg" },
      ],
    });
    expect(got.map((g) => g.url)).toEqual(["f-large.jpg", "back.jpg", "b-1200.jpg"]);
    expect(got[1].comment).toBe("rear");
    const many = imagesOf({
      images: Array.from({ length: 40 }, (_, i) => ({ types: ["Booklet"], image: `${i}.jpg` })),
    });
    expect(many).toHaveLength(RELEASE_IMAGES_MAX);
  });
});
