import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/model";

const settings = { ...DEFAULT_SETTINGS };
vi.mock("../data/persist", () => ({ getSettings: () => settings }));
const mbFetch = vi.fn<(url: string, urgent?: boolean) => Promise<unknown>>();
vi.mock("./mb", () => ({
  MB: "http://mb.test",
  mbFetch: (url: string, urgent?: boolean) => mbFetch(url, urgent),
}));
const {
  coverGroups,
  keptAnswer,
  leadArtist,
  looseKey,
  MISS_LIFE_MS,
  songGroups,
  wantedRadioCover,
  withoutVersion,
} = await import("./radioCover");
type Rec = Parameters<typeof coverGroups>[0][number];

const rec = (
  title: string,
  artist: string,
  releases: Array<
    [id: string, type: string, date: string, extra?: string[], status?: string, by?: string]
  >,
  score = 100,
): Rec => ({
  id: `${title}-${artist}`,
  title,
  score,
  "artist-credit": [{ name: artist }],
  releases: releases.map(([id, type, date, extra = [], status = "Official", by]) => ({
    status,
    date,
    ...(by ? { "artist-credit": [{ name: by }] } : {}),
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

  it("never stands another artist's record or a various-artists one for the song", () => {
    const got = coverGroups(
      [
        rec("Crazy in Love", "Beyoncé", [
          // a various-artists album never tagged a compilation, dated by its year alone
          ["divas", "Album", "2003", [], "Official", "Various Artists"],
          ["tribute", "Album", "2002", [], "Official", "Someone Else"],
          ["single", "Single", "2003-06-30", [], "Official", "Beyoncé"],
        ]),
      ],
      "Beyonce feat. Jay-Z",
      "Crazy in Love",
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

describe("the song's own single, when no recording led to a record", () => {
  type Group = Parameters<typeof songGroups>[0][number];
  const group = (
    id: string,
    title: string,
    type: string,
    by: string,
    score = 100,
    date = "2012",
    extra: string[] = [],
  ): Group => ({
    id,
    title,
    score,
    "primary-type": type,
    "secondary-types": extra,
    "first-release-date": date,
    "artist-credit": [{ name: by }],
  });

  it("is the album of the song's name first, then its single", () => {
    const got = songGroups(
      [
        group("single", "Girl on Fire", "Single", "Alicia Keys", 100, "2012-09-04"),
        group("album", "Girl on Fire", "Album", "Alicia Keys", 100, "2012-11-23"),
      ],
      "Alicia Keys",
      "Girl on Fire",
    );
    expect(got).toEqual(["album", "single"]);
  });

  it("takes the single titled exactly as the station has it, never its remixes", () => {
    const got = songGroups(
      [
        group("single", "Bad Romance", "Single", "Lady Gaga", 100, "2009-10-26"),
        group("remixes", "Bad Romance (The Remixes)", "Single", "Lady Gaga", 89, "2009-12-21", [
          "Remix",
        ]),
      ],
      "Lady Gaga",
      "Bad Romance",
    );
    expect(got).toEqual(["single"]);
  });

  it("needs the lead artist, a sure match and no compilation", () => {
    expect(
      songGroups(
        [group("x", "Crazy in Love", "Single", "Someone Else")],
        "Beyonce feat. Jay-Z",
        "Crazy in Love",
      ),
    ).toEqual([]);
    expect(
      songGroups(
        [group("x", "Crazy in Love", "Single", "Beyoncé", 80)],
        "Beyonce feat. Jay-Z",
        "Crazy in Love",
      ),
    ).toEqual([]);
    expect(
      songGroups(
        [group("x", "Crazy in Love", "Album", "Beyoncé", 100, "2010", ["Compilation"])],
        "Beyonce feat. Jay-Z",
        "Crazy in Love",
      ),
    ).toEqual([]);
    expect(
      songGroups(
        [group("single", "Crazy in Love", "Single", "Beyoncé")],
        "Beyonce feat. Jay-Z",
        "Crazy in Love",
      ),
    ).toEqual(["single"]);
  });
});

describe("what the cache says of a song", () => {
  const now = 1_800_000_000_000;
  it("keeps a cover for good", () => {
    expect(keptAnswer("data:image/png;base64,AA==", now)).toBe("data:image/png;base64,AA==");
  });

  it("takes a song with no cover at its word for a few days, then asks again", () => {
    expect(keptAnswer({ none: now - 1000 }, now)).toBeNull();
    expect(keptAnswer({ none: now - MISS_LIFE_MS + 1000 }, now)).toBeNull();
    expect(keptAnswer({ none: now - MISS_LIFE_MS - 1000 }, now)).toBeUndefined();
  });

  it("asks again for a none kept before a miss had a date, or for nothing kept", () => {
    expect(keptAnswer(null, now)).toBeUndefined();
    expect(keptAnswer(undefined, now)).toBeUndefined();
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
