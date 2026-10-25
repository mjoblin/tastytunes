/**
 * The Tracks view's tempo facet: twenty-bpm bands, the measured tracks only, slowest first.
 */
import { describe, expect, it } from "vitest";
import type { MediaNode } from "@shared/model";
import {
  drOptionsOf,
  orderArtists,
  tempoBandLabel,
  tempoBandOf,
  tempoOptionsOf,
} from "./lensShared";

describe("the tempo facet", () => {
  it("puts a tempo in its twenty-bpm band, the ends open", () => {
    expect(tempoBandOf(62)).toBe("0");
    expect(tempoBandOf(79)).toBe("0");
    expect(tempoBandOf(80)).toBe("80");
    expect(tempoBandOf(119)).toBe("100");
    expect(tempoBandOf(165)).toBe("160");
    expect(tempoBandOf(180)).toBe("180");
    expect(tempoBandOf(212)).toBe("180");
    expect(tempoBandOf(null)).toBeNull();
    expect(tempoBandOf(0)).toBeNull();
  });

  it("names the bands as a reader asks for them", () => {
    expect(tempoBandLabel("0")).toBe("Under 80 bpm");
    expect(tempoBandLabel("160")).toBe("160–179 bpm");
    expect(tempoBandLabel("180")).toBe("180 bpm and up");
  });

  it("offers the bands the measured tracks fall in, slowest first, with their counts", () => {
    expect(tempoOptionsOf([120, 165, null, 170, 72, 121])).toEqual([
      { value: "0", label: "Under 80 bpm", count: 1 },
      { value: "120", label: "120–139 bpm", count: 2 },
      { value: "160", label: "160–179 bpm", count: 2 },
    ]);
    expect(tempoOptionsOf([null, null])).toEqual([]);
    // the DR facet beside it, for the order's contrast: most dynamic first
    expect(drOptionsOf([9, 12]).map((o) => o.value)).toEqual(["12", "9"]);
  });
});

describe("the Artists lens's orders", () => {
  const album = (title: string, extra: Partial<MediaNode> = {}): MediaNode =>
    ({
      id: title,
      title,
      parentId: null,
      isContainer: true,
      upnpClass: "object.container.album.musicAlbum",
      ...extra,
    }) as MediaNode;
  // in name order, as the index gives them
  const artists = [
    { name: "Alvvays", albums: [album("Antisocialites", { recentRank: 2 })], plays: 4 },
    {
      name: "The Cure",
      albums: [album("Songs of a Lost World", { addedAt: 200 }), album("Disintegration")],
      plays: 9,
    },
    { name: "Ellie Goulding", albums: [], plays: 0 },
    { name: "Wet Leg", albums: [album("Moisturizer", { addedAt: 300 })], plays: 4 },
    { name: "Wilco", albums: [album("Cousin", { recentRank: 1 })], plays: 0 },
  ];
  const names = (xs: typeof artists): string[] => xs.map((a) => a.name);
  const plays = (a: (typeof artists)[number]): number => a.plays;

  it("keeps the index's name order for Name", () => {
    expect(names(orderArtists(artists, "name", false, plays))).toEqual(names(artists));
  });

  it("puts the most played first, ties and the unplayed in name order", () => {
    expect(names(orderArtists(artists, "plays", false, plays))).toEqual([
      "The Cure",
      "Alvvays",
      "Wet Leg",
      "Ellie Goulding",
      "Wilco",
    ]);
  });

  it("ranks an artist by their newest album: dated newest first, then a server's list, then the rest by name", () => {
    expect(names(orderArtists(artists, "added", false, plays))).toEqual([
      "Wet Leg",
      "The Cure",
      "Wilco",
      "Alvvays",
      "Ellie Goulding",
    ]);
  });

  it("turns the whole list when reversed", () => {
    expect(names(orderArtists(artists, "plays", true, plays))).toEqual([
      "Wilco",
      "Ellie Goulding",
      "Wet Leg",
      "Alvvays",
      "The Cure",
    ]);
  });
});
