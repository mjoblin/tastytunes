/**
 * The landing's row: by id, then by title and length, then by title, so of two tracks with one
 * title (a user's same-titled tracks, the mock's reprise) the landing washes the one asked for.
 */
import { describe, expect, it } from "vitest";
import { landingRowIndex, type LandingRow } from "./landing";

const rows: LandingRow[] = [
  { title: "Opening", id: "i1", secs: 200 },
  { title: "Close Your Eyes", id: "i2425", secs: 345 },
  { title: "Interlude", id: "i3", secs: 90 },
  { title: "Close Your Eyes", id: "i2426", secs: 275 },
];

describe("the landing's row", () => {
  it("takes the row with the track's id", () => {
    expect(landingRowIndex(rows, { title: "Close Your Eyes", id: "i2426", secs: 345 })).toBe(3);
  });

  it("without the id on the listing, takes the twin whose length matches", () => {
    expect(landingRowIndex(rows, { title: "Close Your Eyes", id: "0$:items$*i9", secs: 276 })).toBe(
      3,
    );
    expect(landingRowIndex(rows, { title: "Close Your Eyes", secs: 344 })).toBe(1);
  });

  it("falls back to the first of the title when no length helps, and -1 when no row has it", () => {
    expect(landingRowIndex(rows, { title: "Close Your Eyes" })).toBe(1);
    expect(landingRowIndex(rows, { title: "Close Your Eyes", secs: 600 })).toBe(1);
    expect(landingRowIndex(rows, { title: "Missing", secs: 100 })).toBe(-1);
  });

  it("takes the nearer length when both twins fall within the slack", () => {
    const close: LandingRow[] = [
      { title: "Reprise", id: null, secs: 120 },
      { title: "Reprise", id: null, secs: 121 },
    ];
    expect(landingRowIndex(close, { title: "Reprise", secs: 121 })).toBe(1);
  });
});
