import { describe, expect, it } from "vitest";
import { isMenuKey, stepFor } from "./useListKeys";

describe("a list's arrows (K2)", () => {
  it("move up and down in rows, and leave left and right to the app", () => {
    expect(stepFor("ArrowDown", 0, 5, undefined)).toBe(1);
    expect(stepFor("ArrowUp", 0, 5, undefined)).toBe(0);
    expect(stepFor("ArrowDown", 4, 5, undefined)).toBe(4);
    expect(stepFor("ArrowLeft", 2, 5, undefined)).toBeNull();
    expect(stepFor("ArrowRight", 2, 5, undefined)).toBeNull();
    expect(stepFor("Home", 3, 5, undefined)).toBe(0);
    expect(stepFor("End", 1, 5, undefined)).toBe(4);
  });

  it("move in all four directions in a grid, a row at a time up and down", () => {
    // 10 cards in rows of 4: 0 1 2 3 / 4 5 6 7 / 8 9
    expect(stepFor("ArrowRight", 3, 10, 4)).toBe(4);
    expect(stepFor("ArrowLeft", 4, 10, 4)).toBe(3);
    expect(stepFor("ArrowDown", 1, 10, 4)).toBe(5);
    expect(stepFor("ArrowDown", 6, 10, 4)).toBe(9);
    expect(stepFor("ArrowUp", 9, 10, 4)).toBe(5);
    expect(stepFor("ArrowUp", 2, 10, 4)).toBe(0);
  });

  it("start from the first item before any is current, and take nothing from an empty list", () => {
    expect(stepFor("ArrowDown", -1, 3, undefined)).toBe(1);
    expect(stepFor("ArrowDown", 0, 0, undefined)).toBeNull();
    expect(stepFor("a", 0, 3, undefined)).toBeNull();
  });
});

describe("the More menu's keys (K4)", () => {
  it("are the full stop, the menu key and Shift+F10", () => {
    expect(isMenuKey({ key: ".", shiftKey: false })).toBe(true);
    expect(isMenuKey({ key: "ContextMenu", shiftKey: false })).toBe(true);
    expect(isMenuKey({ key: "F10", shiftKey: true })).toBe(true);
    expect(isMenuKey({ key: "F10", shiftKey: false })).toBe(false);
    expect(isMenuKey({ key: "Enter", shiftKey: false })).toBe(false);
  });
});
