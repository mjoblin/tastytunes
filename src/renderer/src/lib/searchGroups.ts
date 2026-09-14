import { sanitizeNavHidden, sanitizeNavOrder } from "@/lib/screens";
import type { Screen } from "@/store";

// The Search screen's GROUPING as rules with no React in them (2026-09-13,
// the tail of the hygiene rounds; the screen had carried them between its
// rows): which categories there are and what each owns, the caps, how the
// hidden set is seeded from the nav and toggled, the user's nav order applied
// live, isolation (one category showing owns the screen), the two sorts that
// generalize across five heterogeneous groups, and the "more" arithmetic. The
// screen builds each group's rows (they are JSX with its handlers) and
// renders; every chip, count, cap and sort reads from here.

export type SearchCategoryId = "library" | "favorites" | "playlists" | "presets" | "radio";

/** Every category id is also a nav screen id — that 1:1 is what lets the nav
 *  seed the rail's default hidden set (seedHidden) AND order it (orderByNav).
 *  MEMBERSHIP ONLY: this list's own order carries no meaning — the rendered
 *  order is the user's nav order. */
export const SEARCH_CATEGORY_IDS: SearchCategoryId[] = [
  "library",
  "favorites",
  "playlists",
  "presets",
  "radio",
];

/** Where the whole set lives, once the Search screen can't show more of it. */
export interface SearchGroupOwner {
  screen: Screen;
  filterKey: "favorites" | "playlists" | "presets";
}

/** What each category is called and where its whole set lives. The Library
 *  has no owner here: its deeper tool is its own search (the screen hands the
 *  query over), and radio's rest is unreachable by design. */
export const SEARCH_CATEGORIES: Record<
  SearchCategoryId,
  { label: string; owner?: SearchGroupOwner }
> = {
  library: { label: "Library" },
  presets: { label: "Presets", owner: { screen: "presets", filterKey: "presets" } },
  playlists: { label: "Playlists", owner: { screen: "playlists", filterKey: "playlists" } },
  favorites: { label: "Favorites", owner: { screen: "favorites", filterKey: "favorites" } },
  radio: { label: "Internet radio" },
};

/** Per group while several are showing — five groups of everything is a wall. */
export const GROUP_CAP = 6;
/** Narrowed to ONE category, it owns the screen and can show far more. */
export const ISOLATED_CAP = 50;

/** One category as the screen builds it: the count, the flags and its rows. */
export interface SearchGroup<R extends { sortKey: string }> {
  id: SearchCategoryId;
  label: string;
  /** What the count MEANS: matches found, which may exceed what's listed. */
  total: number;
  pending?: boolean;
  /** Not asked (a hidden lookup) — show no count rather than a false zero. */
  unknown?: boolean;
  rows: R[];
  owner?: SearchGroupOwner;
}

/** The hidden set's seed: the stored set when there is one, else the nav's
 *  own hidden screens — either way only category ids survive. */
export function seedHidden(
  stored: readonly string[] | null | undefined,
  navHidden: readonly string[] | null | undefined,
): Set<SearchCategoryId> {
  const ids = new Set<string>(SEARCH_CATEGORY_IDS);
  const src = stored ?? sanitizeNavHidden(navHidden);
  return new Set(src.filter((id): id is SearchCategoryId => ids.has(id)));
}

/** Toggle one category. Hiding the last visible one would leave a blank
 *  screen saying nothing — that reads as "show everything again". */
export function toggleHidden(
  hidden: ReadonlySet<SearchCategoryId>,
  id: SearchCategoryId,
  groupCount: number,
): Set<SearchCategoryId> {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next.size >= groupCount ? new Set<SearchCategoryId>() : next;
}

/** THE USER'S NAV ORDER, applied live as a sorted copy: every count, cap and
 *  row exactly where it was, only the sequence moves; ids the rail doesn't
 *  know go last. */
export function orderByNav<G extends { id: SearchCategoryId }>(
  groups: readonly G[],
  navOrder: readonly string[] | null | undefined,
): G[] {
  const rank = new Map(sanitizeNavOrder(navOrder).map((id, i) => [id as string, i]));
  return [...groups].sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
}

/** What shows and how much of it. An empty category is never "shown" — it has
 *  nothing to show, and counting it would make the isolation arithmetic wrong
 *  (chips vs one result set); a pending one shows, it is still arriving.
 *  ISOLATED = narrowed to one category, so it owns the screen and can show far
 *  more of itself than it could as one group among five. */
export function layoutGroups<R extends { sortKey: string }>(
  groups: readonly SearchGroup<R>[],
  hidden: ReadonlySet<SearchCategoryId>,
): {
  shown: SearchGroup<R>[];
  isolated: boolean;
  cap: number;
  anyResults: boolean;
  anyPending: boolean;
} {
  const shown = groups.filter((c) => !hidden.has(c.id) && (c.total > 0 || c.pending));
  const isolated = shown.length === 1;
  return {
    shown,
    isolated,
    cap: isolated ? ISOLATED_CAP : GROUP_CAP,
    anyResults: shown.some((c) => c.rows.length > 0),
    anyPending: shown.some((c) => c.pending),
  };
}

export type SearchSort = "relevance" | "name";
export const byName = (a: { sortKey: string }, b: { sortKey: string }): number =>
  a.sortKey.localeCompare(b.sortKey);

/** A group's rows in the chosen order: relevance is each source's own ranking
 *  (the rows as built), name is byName; reversed flips either. A copy. */
export function orderRows<R extends { sortKey: string }>(
  rows: readonly R[],
  sort: SearchSort,
  reversed: boolean,
): R[] {
  const ordered = sort === "name" ? [...rows].sort(byName) : [...rows];
  return reversed ? ordered.reverse() : ordered;
}

/** How many matches the cap leaves unlisted. */
export const moreCount = (total: number, listed: number, cap: number): number =>
  total - Math.min(listed, cap);
