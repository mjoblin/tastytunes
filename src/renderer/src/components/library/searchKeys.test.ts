import { describe, expect, it } from "vitest";
import { searchStep, type SearchSpot } from "./searchKeys";

// Albums as cards in lines of 3 (lines 1 to 3: 0 1 2 / 3 4 5 / 6), then two track rows (lines 5
// and 6), each kind under its label line (0 and 4)
const spots: SearchSpot[] = [
  ...[0, 1, 2, 3, 4, 5, 6].map((i) => ({
    line: 1 + Math.floor(i / 3),
    col: i % 3,
    card: true,
    section: 0,
  })),
  { line: 5, col: 0, card: false, section: 1 },
  { line: 6, col: 0, card: false, section: 1 },
];

describe("the Library's search results from the keyboard", () => {
  it("move in all four directions among cards, a line at a time up and down", () => {
    expect(searchStep("ArrowRight", 0, spots)).toBe(1);
    expect(searchStep("ArrowRight", 2, spots)).toBe(3);
    expect(searchStep("ArrowLeft", 3, spots)).toBe(2);
    expect(searchStep("ArrowDown", 1, spots)).toBe(4);
    expect(searchStep("ArrowUp", 4, spots)).toBe(1);
    // a shorter last line: its last card
    expect(searchStep("ArrowDown", 5, spots)).toBe(6);
  });

  it("keep the arrows at a grid's edge, and leave left and right to the app on a row", () => {
    expect(searchStep("ArrowRight", 6, spots)).toBe(6);
    expect(searchStep("ArrowLeft", 0, spots)).toBe(0);
    expect(searchStep("ArrowUp", 0, spots)).toBe(0);
    expect(searchStep("ArrowRight", 7, spots)).toBeNull();
    expect(searchStep("ArrowLeft", 8, spots)).toBeNull();
  });

  it("cross between kinds up and down, and reach both ends", () => {
    expect(searchStep("ArrowDown", 6, spots)).toBe(7);
    expect(searchStep("ArrowDown", 7, spots)).toBe(8);
    expect(searchStep("ArrowDown", 8, spots)).toBe(8);
    // up from a row into the grid's last line, its first card
    expect(searchStep("ArrowUp", 7, spots)).toBe(6);
    expect(searchStep("Home", 5, spots)).toBe(0);
    expect(searchStep("End", 1, spots)).toBe(8);
    expect(searchStep("a", 1, spots)).toBeNull();
    expect(searchStep("ArrowDown", 9, spots)).toBeNull();
  });
});
