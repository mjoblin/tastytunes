import { describe, expect, it } from "vitest";
import type { MediaNode } from "@shared/model";
import { arrivalsOf, noteArrivals } from "./albumArrivals";

const album = (
  title: string,
  art: string | null = null,
): Pick<MediaNode, "title" | "artist" | "albumArtist" | "artUrl"> => ({
  title,
  artist: "Band",
  albumArtist: undefined,
  artUrl: art,
});

describe("when each album arrived", () => {
  it("knows no day for the albums of a server's first index, and today for one that comes later", () => {
    noteArrivals("uuid:a", [album("One"), album("Two")], false, 1000);
    expect(arrivalsOf("uuid:a")).toEqual({ "one|band": 0, "two|band": 0 });
    noteArrivals("uuid:a", [album("One"), album("Two"), album("Three")], false, 5000);
    expect(arrivalsOf("uuid:a")["three|band"]).toBe(5000);
    // seen again later, or gone and back: still the day it first came
    noteArrivals("uuid:a", [album("One"), album("Three")], false, 9000);
    noteArrivals("uuid:a", [album("One"), album("Two"), album("Three")], false, 9500);
    expect(arrivalsOf("uuid:a")).toEqual({ "one|band": 0, "two|band": 0, "three|band": 5000 });
  });

  it("tells a new edition by its picture where the server keeps addresses", () => {
    noteArrivals("uuid:b", [album("Record", "http://h/aa/us/c.jpg")], true, 1000);
    noteArrivals(
      "uuid:b",
      [album("Record", "http://h/aa/us/c.jpg"), album("Record", "http://h/aa/jp/c.jpg")],
      true,
      2000,
    );
    expect(arrivalsOf("uuid:b")["record|band|/aa/jp/c.jpg"]).toBe(2000);
    expect(arrivalsOf("uuid:b")["record|band|/aa/us/c.jpg"]).toBe(0);
  });

  it("reads most of a server's albums new at once as the server renaming them, not an import", () => {
    const many = (prefix: string): ReturnType<typeof album>[] =>
      Array.from({ length: 40 }, (_, i) => album(`${prefix} ${i}`));
    noteArrivals("uuid:c", many("Old"), false, 1000);
    noteArrivals("uuid:c", many("Renamed"), false, 2000);
    expect(Object.values(arrivalsOf("uuid:c")).every((at) => at === 0)).toBe(true);
    // a real batch, under half the library, is an import
    noteArrivals(
      "uuid:c",
      [...many("Renamed"), ...Array.from({ length: 25 }, (_, i) => album(`Batch ${i}`))],
      false,
      3000,
    );
    expect(arrivalsOf("uuid:c")["batch 0|band"]).toBe(3000);
  });
});
