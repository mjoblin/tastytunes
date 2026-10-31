/**
 * The Search screen's grouping rules: the hidden set's seed and toggle, the
 * nav order, what shows and how much, the row order and the "more" count.
 */
import { describe, expect, it } from "vitest";
import {
  layoutGroups,
  moreCount,
  orderByNav,
  orderRows,
  seedHidden,
  toggleHidden,
  type SearchCategoryId,
  type SearchGroup,
} from "./searchGroups";

type Row = { key: string; sortKey: string };

const group = (
  id: SearchCategoryId,
  total: number,
  n = total,
  extra: Partial<SearchGroup<Row>> = {},
): SearchGroup<Row> => ({
  id,
  label: id,
  total,
  rows: Array.from({ length: n }, (_, i) => ({
    key: `${id}${i}`,
    sortKey: `${id} ${String(i).padStart(2, "0")}`,
  })),
  ...extra,
});

const five = (): SearchGroup<Row>[] => [
  group("library", 20),
  group("presets", 2),
  group("playlists", 0),
  group("favorites", 3),
  group("radio", 0, 0, { pending: true }),
];

describe("seedHidden", () => {
  it("takes the stored set, keeping category ids only", () => {
    expect([...seedHidden(["radio", "settings", "bogus"], ["favorites"])]).toEqual(["radio"]);
  });

  it("falls back to the nav's hidden screens, keeping category ids only", () => {
    expect([...seedHidden(null, ["favorites", "now-playing"])]).toEqual(["favorites"]);
  });

  it("is empty with neither", () => {
    expect(seedHidden(undefined, null).size).toBe(0);
  });
});

describe("toggleHidden", () => {
  it("hides and shows one category", () => {
    expect([...toggleHidden(new Set(), "radio", 5)]).toEqual(["radio"]);
    expect(toggleHidden(new Set(["radio"]), "radio", 5).size).toBe(0);
  });

  it("shows everything again when the last visible category is hidden", () => {
    const hidden = new Set<SearchCategoryId>(["library", "presets", "playlists", "favorites"]);
    expect(toggleHidden(hidden, "radio", 5).size).toBe(0);
  });
});

describe("orderByNav", () => {
  it("applies the user's nav order as a sorted copy, the input untouched", () => {
    const groups = five();
    const order = ["radio", "favorites", "library", "presets", "playlists"];
    expect(orderByNav(groups, order).map((g) => g.id)).toEqual([
      "radio",
      "favorites",
      "library",
      "presets",
      "playlists",
    ]);
    expect(groups[0].id).toBe("library");
  });

  it("reads no order and an empty order alike", () => {
    const groups = five();
    expect(orderByNav(groups, null).map((g) => g.id)).toEqual(
      orderByNav(groups, []).map((g) => g.id),
    );
  });
});

describe("layoutGroups", () => {
  it("never shows an empty category but shows a pending one, and caps several at six", () => {
    const lay = layoutGroups(five(), new Set());
    expect(lay.shown.map((g) => g.id)).toEqual(["library", "presets", "favorites", "radio"]);
    expect(lay.isolated).toBe(false);
    expect(lay.cap).toBe(6);
    expect(lay.anyResults).toBe(true);
    expect(lay.anyPending).toBe(true);
  });

  it("isolates one category showing and caps it at fifty", () => {
    const iso = layoutGroups(five(), new Set(["presets", "favorites", "radio"]));
    expect(iso.shown.map((g) => g.id)).toEqual(["library"]);
    expect(iso.isolated).toBe(true);
    expect(iso.cap).toBe(50);
    expect(iso.anyPending).toBe(false);
  });
});

describe("orderRows", () => {
  const rows = [{ sortKey: "b" }, { sortKey: "a" }, { sortKey: "c" }];
  const keys = (rs: { sortKey: string }[]) => rs.map((r) => r.sortKey).join("");

  it("keeps the rows as built for relevance and sorts them for name", () => {
    expect(keys(orderRows(rows, "relevance", false))).toBe("bac");
    expect(keys(orderRows(rows, "name", false))).toBe("abc");
  });

  it("flips either order when reversed, the input untouched", () => {
    expect(keys(orderRows(rows, "name", true))).toBe("cba");
    expect(keys(orderRows(rows, "relevance", true))).toBe("cab");
    expect(rows[0].sortKey).toBe("b");
  });
});

describe("moreCount", () => {
  it("is what the cap leaves unlisted, zero for a list under it", () => {
    expect(moreCount(20, 20, 6)).toBe(14);
    expect(moreCount(3, 3, 6)).toBe(0);
    expect(moreCount(60, 50, 50)).toBe(10);
  });
});
