import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/model";

const settings = { ...DEFAULT_SETTINGS };
vi.mock("../data/persist", () => ({ getSettings: () => settings }));
const mbFetch = vi.fn<(url: string, urgent?: boolean) => Promise<unknown>>();
vi.mock("./mb", () => ({
  MB: "http://mb.test",
  mbFetch: (url: string, urgent?: boolean) => mbFetch(url, urgent),
}));
const { coverGroups, leadArtist, looseKey, wantedRadioCover, withoutVersion } =
  await import("./radioCover");
type Rec = Parameters<typeof coverGroups>[0][number];

const rec = (
  title: string,
  artist: string,
  releases: Array<[id: string, type: string, date: string, extra?: string[], status?: string]>,
  score = 100,
): Rec => ({
  id: `${title}-${artist}`,
  title,
  score,
  "artist-credit": [{ name: artist }],
  releases: releases.map(([id, type, date, extra = [], status = "Official"]) => ({
    status,
    date,
    "release-group": { id, "primary-type": type, "secondary-types": extra },
  })),
});

describe("a station's song, read for a cover", () => {
  it("compares letters and digits only", () => {
    expect(looseKey("Hey, Soul Sister")).toBe(looseKey("Hey Soul Sister"));
    expect(looseKey("Beyoncé")).toBe(looseKey("Beyonce"));
    expect(looseKey("P!nk")).toBe("pnk");
  });

  it("sets a closing version's note aside, and keeps one that opens the title", () => {
    expect(withoutVersion("Love Story (Taylor's Version)")).toBe("Love Story");
    expect(withoutVersion("Something Better [Cydelix Remix]")).toBe("Something Better");
    expect(withoutVersion("(You Drive Me) Crazy")).toBe("(You Drive Me) Crazy");
    expect(withoutVersion("Smooth")).toBe("Smooth");
  });

  it("takes the first credited artist", () => {
    expect(leadArtist("Sam Fender feat. Olivia Dean")).toBe("Sam Fender");
    expect(leadArtist("Rudimental feat. Jess Glynne, Macklemore & Dan Caplen")).toBe("Rudimental");
    expect(leadArtist("Lady Gaga & Bruno Mars")).toBe("Lady Gaga");
    expect(leadArtist("ROSE, Bruno Mars")).toBe("ROSE");
    expect(leadArtist("Florence and the Machine")).toBe("Florence and the Machine");
    expect(leadArtist("Lil Nas X")).toBe("Lil Nas X");
  });
});

describe("the albums whose cover stands for the song", () => {
  it("is the official album first, then a single, the earliest of each", () => {
    const got = coverGroups(
      [
        rec("Smooth", "Santana", [
          ["single", "Single", "1999-06-01"],
          ["album", "Album", "1999-06-15"],
          ["later-album", "Album", "2004-01-01"],
          ["bootleg", "Album", "1998-01-01", [], "Bootleg"],
        ]),
      ],
      "Santana feat. Rob Thomas",
      "Smooth",
    );
    expect(got).toEqual(["album", "later-album", "single"]);
  });

  it("never stands a compilation, a live record or a mix for the song", () => {
    const got = coverGroups(
      [
        rec("Closer", "The Chainsmokers", [
          ["hits", "Album", "2016-01-01", ["Compilation"]],
          ["live", "Album", "2016-02-01", ["Live"]],
          ["single", "Single", "2016-07-29"],
        ]),
      ],
      "The Chainsmokers feat. Halsey",
      "Closer",
    );
    expect(got).toEqual(["single"]);
  });

  it("needs the lead artist and the song's title, else finds nothing", () => {
    const cover = rec("Weather With You", "Someone Else", [["cover", "Album", "2001-01-01"]]);
    expect(coverGroups([cover], "Crowded House", "Weather With You")).toEqual([]);
    const otherSong = rec("Better Be Home Soon", "Crowded House", [["x", "Album", "1988-01-01"]]);
    expect(coverGroups([otherSong], "Crowded House", "Weather With You")).toEqual([]);
    const weak = rec("Weather With You", "Crowded House", [["y", "Album", "1991-01-01"]], 60);
    expect(coverGroups([weak], "Crowded House", "Weather With You")).toEqual([]);
    // a show's name or a station that puts the song first matches no recording
    expect(coverGroups([otherSong], "Weather With You", "Crowded House")).toEqual([]);
  });

  it("finds a band whose name holds an ampersand by its first word", () => {
    const got = coverGroups(
      [rec("Little Lion Man", "Mumford & Sons", [["sigh", "Album", "2009-10-02"]])],
      "Mumford & Sons",
      "Little Lion Man",
    );
    expect(got).toEqual(["sigh"]);
  });

  it("prefers the recording titled exactly as the station has it", () => {
    const recs = [
      rec("Love Story", "Taylor Swift", [["fearless", "Album", "2008-11-11"]]),
      rec("Love Story (Taylor's Version)", "Taylor Swift", [["tv", "Album", "2021-04-09"]]),
    ];
    expect(coverGroups(recs, "Taylor Swift", "Love Story (Taylor's Version)")).toEqual(["tv"]);
    // without an exact title, the note set aside on both sides still matches
    expect(coverGroups([recs[0]], "Taylor Swift", "Love Story (Remastered)")).toEqual(["fearless"]);
  });
});

describe("whether a cover is asked at all", () => {
  it("asks nothing with either switch off", async () => {
    settings.radioCovers = false;
    expect(await wantedRadioCover("Crowded House", "Weather With You")).toBeNull();
    settings.radioCovers = true;
    settings.albumArtLookup = false;
    expect(await wantedRadioCover("Crowded House", "Weather With You")).toBeNull();
    expect(mbFetch).not.toHaveBeenCalled();
    settings.albumArtLookup = true;
  });
});
