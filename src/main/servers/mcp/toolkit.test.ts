import { describe, expect, it } from "vitest";
import { dayRange, decadeStart, inDecade, localDayStart, localToday } from "./toolkit";

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
