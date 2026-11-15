import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bareTitle,
  dayRange,
  decadeStart,
  genreKey,
  nearestNames,
  inDecade,
  localDayStart,
  localTime,
  localToday,
  nearestTitles,
  ok,
  strictInput,
  titleMatcher,
  type Titled,
} from "./toolkit";

describe("the history tools' days, read once", () => {
  it("reads a local day to its first millisecond", () => {
    expect(localDayStart("2026-11-14")).toBe(new Date(2026, 10, 14).getTime());
    expect(localDayStart(" 2026-01-01 ")).toBe(new Date(2026, 0, 1).getTime());
  });

  it("refuses what isn't a day, a day past the month's end included", () => {
    for (const v of ["last week", "2026-11", "14/11/2026", "2026-02-30", "2026-13-01", ""])
      expect(localDayStart(v)).toBeNull();
  });

  it("takes from and to inclusive, through the last millisecond of to's day", () => {
    const r = dayRange({ from: "2026-11-01", to: "2026-11-07" });
    expect(r).toEqual({
      from: new Date(2026, 10, 1).getTime(),
      to: new Date(2026, 10, 8).getTime() - 1,
    });
    expect(dayRange({})).toEqual({ from: null, to: null });
  });

  it("answers a bad day with the form and today's date, never an empty result", () => {
    const r = dayRange({ from: "last week" });
    expect(r).toEqual({
      error: `"last week" isn't a day: from takes a local date, YYYY-MM-DD (today is ${localToday()}).`,
    });
    expect("error" in dayRange({ to: "yesterday" })).toBe(true);
    expect(dayRange({ from: "2026-11-08", to: "2026-11-01" })).toEqual({
      error: "from (2026-11-08) is after to (2026-11-01).",
    });
  });

  it("reads a named period in local days", () => {
    const now = new Date();
    const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
    const day = (dd: number, mm = m, yy = y): number => new Date(yy, mm, dd).getTime();
    expect(dayRange({ period: "today" })).toEqual({ from: day(d), to: day(d + 1) - 1 });
    expect(dayRange({ period: "yesterday" })).toEqual({ from: day(d - 1), to: day(d) - 1 });
    expect(dayRange({ period: "last_7_days" })).toEqual({ from: day(d - 6), to: day(d + 1) - 1 });
    expect(dayRange({ period: "this_month" })).toEqual({ from: day(1), to: day(d + 1) - 1 });
    expect(dayRange({ period: "this_year" })).toEqual({ from: day(1, 0), to: day(d + 1) - 1 });
    expect(dayRange({ period: "today", from: "2026-01-01" })).toEqual({
      error: "Give period, or from and to, not both.",
    });
  });

  it("writes today as the tools take a day", () => {
    expect(localToday(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("a decade as an agent writes it", () => {
  it("reads the ways a decade is written, and a year inside one", () => {
    for (const v of ["1990s", "1990", "90s", "'90s", "’90s", "90", "1995", " 1990S "])
      expect(decadeStart(v)).toBe(1990);
    expect(decadeStart("00s")).toBe(2000);
    expect(decadeStart("20s")).toBe(2020);
    expect(decadeStart("60s")).toBe(1960);
  });

  it("names none for anything else", () => {
    for (const v of ["nineties", "95", "199", "1990s-2000s", ""]) expect(decadeStart(v)).toBeNull();
  });

  it("places a tag's year, a full date's too", () => {
    expect(inDecade("1994", 1990)).toBe(true);
    expect(inDecade("1994-05-01", 1990)).toBe(true);
    expect(inDecade("2000", 1990)).toBe(false);
    expect(inDecade(null, 1990)).toBe(false);
    expect(inDecade("unknown", 1990)).toBe(false);
  });
});

describe("one time format, local with its offset", () => {
  const at = Date.UTC(2026, 10, 15, 5, 55, 3);
  it("says a moment in the offset it was recorded at", () => {
    expect(localTime(at, 480)).toBe("2026-11-14T21:55:03-08:00");
    expect(localTime(at, -780)).toBe("2026-11-15T18:55:03+13:00");
    expect(localTime(at, -330)).toBe("2026-11-15T11:25:03+05:30");
    expect(localTime(at, 0)).toBe("2026-11-15T05:55:03+00:00");
  });

  it("uses this machine's offset when none was kept", () => {
    expect(localTime(at)).toBe(localTime(at, new Date(at).getTimezoneOffset()));
  });
});

describe("strict arguments", () => {
  const input = strictInput("list_tracks", {
    artist: z.string().optional(),
    limit: z.number().optional(),
  });
  it("refuses an argument the tool does not take, naming the ones it does", () => {
    const r = input.safeParse({ query: "love" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe(
      "list_tracks doesn't take 'query'. It takes artist, limit.",
    );
  });

  it("takes the arguments it names, and a tool with none takes none", () => {
    expect(input.safeParse({ artist: "Keane", limit: 3 }).success).toBe(true);
    const none = strictInput("get_status").safeParse({ verbose: true });
    expect(none.error?.issues[0].message).toBe(
      "get_status doesn't take 'verbose'. It takes no arguments.",
    );
  });
});

describe("answers", () => {
  it("are compact JSON, and a sentence stays a sentence", () => {
    expect(ok({ a: 1, b: [2] }).content[0]).toEqual({ type: "text", text: '{"a":1,"b":[2]}' });
    expect(ok("Skipped.").content[0]).toEqual({ type: "text", text: "Skipped." });
  });
});

describe("the library's shape for an agent", () => {
  it("joins a genre's spellings", () => {
    expect(genreKey("Hip-Hop")).toBe(genreKey("Hip Hop"));
    expect(genreKey("hiphop")).toBe(genreKey("HIP HOP"));
    expect(genreKey("Électronique")).toBe("electronique");
    expect(genreKey("Rock")).not.toBe(genreKey("Rock & Roll"));
  });

  it("offers the names closest to a miss, closest first", () => {
    const artists = ["The Beatles", "Beat Happening", "Massive Attack", "Motörhead", "Keane"];
    // the closer first: one edit to "Beatles", two to "Beat"
    expect(nearestNames("beatls", artists)).toEqual(["The Beatles", "Beat Happening"]);
    expect(nearestNames("massiv atack", artists)).toEqual(["Massive Attack"]);
    expect(nearestNames("motorhed", artists)).toEqual(["Motörhead"]);
    expect(nearestNames("keane", artists)).toEqual(["Keane"]);
    expect(nearestNames("zzzz", artists)).toEqual([]);
    expect(nearestNames("", artists)).toEqual([]);
  });

  it("puts a genre that contains the word first", () => {
    expect(nearestNames("electro", ["Electronic", "Electro Swing", "Rock", "Metal"])).toEqual([
      "Electro Swing",
      "Electronic",
    ]);
  });
});

describe("one title match for an agent's reference", () => {
  const library: Titled[] = [
    { title: "Don't Look Back", credits: ["The Night Ferries"] },
    { title: "Harbour Lights (feat. June Vale)", credits: ["Dusk Parade", "June Vale"] },
    { title: "Paper Moons [Demo]", credits: ["Glass Orchard"] },
    { title: "Paper Moons [Live Demo]", credits: ["Glass Orchard"] },
    { title: "Ace of Spades", credits: ["Motörhead"] },
    { title: "Intro", credits: [] },
  ];
  const read = (t: Titled): Titled => t;
  const find = titleMatcher(library, read);
  const titles = (ref: { title: string; artist?: string }): string[] =>
    find(ref).map((t) => t.title ?? "");

  it("folds the title as search does", () => {
    expect(titles({ title: "dont look back" })).toEqual(["Don't Look Back"]);
    expect(titles({ title: "DON'T  LOOK BACK", artist: "night ferries" })).toEqual([
      "Don't Look Back",
    ]);
    expect(titles({ title: "ace of spades", artist: "motorhead" })).toEqual(["Ace of Spades"]);
  });

  it("sets a trailing part aside only with an artist named", () => {
    expect(titles({ title: "Harbour Lights", artist: "Dusk Parade" })).toEqual([
      "Harbour Lights (feat. June Vale)",
    ]);
    expect(titles({ title: "Harbour Lights" })).toEqual([]);
    // two songs once their parts are set aside: both, for the caller to offer
    expect(titles({ title: "Paper Moons", artist: "Glass Orchard" })).toEqual([
      "Paper Moons [Demo]",
      "Paper Moons [Live Demo]",
    ]);
  });

  it("holds a named artist to the credits, but not against an item crediting no one", () => {
    expect(titles({ title: "dont look back", artist: "Glass Orchard" })).toEqual([]);
    expect(titles({ title: "Harbour Lights", artist: "The Night Ferries" })).toEqual([]);
    expect(titles({ title: "intro", artist: "Anyone" })).toEqual(["Intro"]);
  });

  it("sets aside every trailing part, and keeps a title that is only one", () => {
    expect(bareTitle("Song (feat. X) [Remastered 2011]")).toBe("Song");
    expect(bareTitle("Harbour Lights (feat. June Vale)")).toBe("Harbour Lights");
    expect(bareTitle("(Untitled)")).toBe("(Untitled)");
    expect(bareTitle("Song (Part 1) Reprise")).toBe("Song (Part 1) Reprise");
  });

  it("offers the nearest titles for a miss, the named artist's first", () => {
    expect(nearestTitles({ title: "ace of spadez", artist: "Motorhead" }, library, read)).toEqual([
      "Ace of Spades",
    ]);
    // a wrong artist still finds the title among them all
    expect(
      nearestTitles({ title: "dont look bak", artist: "Glass Orchard" }, library, read),
    ).toEqual(["Don't Look Back"]);
    expect(nearestTitles({ title: "zzzz qqqq" }, library, read)).toEqual([]);
  });
});
