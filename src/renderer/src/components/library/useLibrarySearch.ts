import { useEffect, useRef, useState } from "react";
import {
  nameSortKey,
  type MediaNode,
  type MediaSearchAllGroup,
  type MediaServerInfo,
} from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { mediaKind } from "@/lib/media";
import { useOneShotAsk } from "@/hooks/useOneShotAsk";
import type { Crumb } from "@/screens/LibraryScreen";

// The Library's whole-library SEARCH MODE, lifted out of LibraryScreen
// (2026-09-13, the first lift of the screen's hygiene round; the lens
// navigation went first, 2026-09-10): the mode's state, the find-recall memory,
// the ways in and out, the searches themselves with their as-you-type answers,
// and the ⌘F ask. The screen keeps the browse, the history spots and the
// results' rendering. It hands this hook the little that search moves (the
// server and trail, the level filter) and takes the state back under the same
// names, so nothing downstream changed in the lift.

export type SearchKind = "all" | "albums" | "artists" | "tracks";
export type SearchSort = "relevance" | "title" | "artist" | "year";

export const matchesKind = (n: MediaNode, kind: SearchKind): boolean =>
  kind === "all" ? true : `${mediaKind(n.upnpClass, n.isContainer)}s` === kind;

// Shared result sort — single-server results and every cross-server group
// order the same way. 'relevance' keeps the index's artists→albums→tracks
// order (the hierarchy: artists make albums, albums contain tracks).
export const sortSearch = (list: MediaNode[], sort: SearchSort, reversed: boolean): MediaNode[] => {
  let out = list;
  if (sort !== "relevance") {
    out = [...list].sort((a, b) => {
      if (sort === "artist")
        return (
          nameSortKey(a.artist ?? "￿").localeCompare(nameSortKey(b.artist ?? "￿")) ||
          a.title.localeCompare(b.title)
        );
      if (sort === "year")
        return (b.year ?? "").localeCompare(a.year ?? "") || a.title.localeCompare(b.title);
      return a.title.localeCompare(b.title);
    });
  }
  return reversed ? [...out].reverse() : out;
};

// Find-recall memory: the session's last search — scope, query, controls,
// and a results snapshot for scopes that would cost a live round-trip to
// re-run (index-backed scopes re-execute instead: free and always fresh).
// ⌘F and the gold search buttons restore it with the query text selected,
// browser-find style. Session-only, like the memories above — never a
// setting. The nav's "Library" front door is unaffected.
let searchMemory: {
  udn: string | null; // null = the root cross-server search
  query: string;
  kind: SearchKind;
  sort: SearchSort;
  sortReversed: boolean;
  serverFilter: string | null;
  scoped: { query: string; items: MediaNode[]; total: number } | null;
} | null = null;

/** What search MOVES, declared by the screen below the hook (they read the
 *  search state the hook returns) and reached late-bound: called at event
 *  time, never captured at render. */
export interface SearchLate {
  /** Record the spot being left (skipped while restoring). */
  pushSpot(): void;
  moveTo(udn: string | null, path: Crumb[]): void;
  rememberScroll(): void;
  showNotice(msg: string): void;
}

export function useLibrarySearch(d: {
  serverUdn: string | null;
  setServerUdn(udn: string | null): void;
  path: Crumb[];
  setPath(path: Crumb[]): void;
  servers: MediaServerInfo[] | null;
  filter: string;
  setScreenFilter(screen: "library", value: string): void;
  filterMemory: Map<string, string>;
  nodeKey(serverUdn: string | null, path: Crumb[]): string;
  late: { current: SearchLate };
}) {
  const { serverUdn, path, servers, filter, filterMemory, nodeKey } = d;
  const atRoot = serverUdn == null;
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<{
    query: string;
    items: MediaNode[];
    total: number;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  // Where to come back to when a search result was entered: the results
  // themselves plus the folder the search ran over. udn null + cross set =
  // the root cross-server search.
  const [searchReturn, setSearchReturn] = useState<{
    udn: string | null;
    query: string;
    items: MediaNode[];
    total: number;
    cross: MediaSearchAllGroup[] | null;
    prevPath: Crumb[];
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** Set by restoreSpot: a search-results spot coming back through Back/Forward keeps its bar blurred (history restores, intent prepares — see SearchScreen). */
  const restoredSearch = useRef(false);
  useEffect(() => {
    if (searchMode) {
      if (restoredSearch.current) {
        restoredSearch.current = false;
        return;
      }
      searchInputRef.current?.focus();
      // find idiom: a recalled query arrives selected, so typing replaces it
      searchInputRef.current?.select();
    }
  }, [searchMode]);
  // Result controls: kind filter (the Favorites Segmented idiom) + sort.
  // Both reset when search exits — a fresh search starts neutral.
  const [searchKind, setSearchKind] = useState<"all" | "albums" | "artists" | "tracks">("all");
  const [searchSort, setSearchSort] = useState<"relevance" | "title" | "artist" | "year">(
    "relevance",
  );
  const [searchSortReversed, setSearchSortReversed] = useState(false);
  const [crossState, setCrossState] = useState<{
    query: string;
    groups: MediaSearchAllGroup[];
  } | null>(null);
  const crossMode = searchMode && atRoot;
  // Which server's slice to show (null = all) — the same transient-narrowing
  // semantics as the kind filter beside it: dies when search exits, and a
  // selection whose server has no results for the new query falls back to
  // all rather than presenting an empty screen.
  const [searchServerUdn, setSearchServerUdn] = useState<string | null>(null);
  const crossServerUdn =
    searchServerUdn && crossState?.groups.some((g) => g.udn === searchServerUdn)
      ? searchServerUdn
      : null;

  // Keep the find-recall memory current while searching (a module var write
  // per state change — the screen unmounts on any nav, so continuous saving
  // is what makes recall survive a trip to another screen).
  useEffect(() => {
    if (!searchMode || !searchQuery.trim()) return;
    searchMemory = {
      udn: atRoot ? null : serverUdn,
      query: searchQuery,
      kind: searchKind,
      sort: searchSort,
      sortReversed: searchSortReversed,
      serverFilter: searchServerUdn,
      scoped: !atRoot ? searchState : null,
    };
  }, [
    searchMode,
    searchQuery,
    searchKind,
    searchSort,
    searchSortReversed,
    searchServerUdn,
    searchState,
    atRoot,
    serverUdn,
  ]);

  /**
   * Restore the remembered search into the CURRENT scope (call after the
   * scope is set). Returns false when the memory belongs elsewhere or is
   * empty — the caller's fresh-search behavior then stands. Index-backed
   * scopes re-execute (instant + fresh); live-only scopes restore the
   * snapshot rather than re-firing SOAP at the server.
   */
  const restoreSearchMemory = (scope: string | null): boolean => {
    const mem = searchMemory;
    if (!mem || mem.udn !== scope || !mem.query.trim()) return false;
    setSearchQuery(mem.query);
    setSearchKind(mem.kind);
    setSearchSort(mem.sort);
    setSearchSortReversed(mem.sortReversed);
    if (scope === null) {
      setSearchServerUdn(mem.serverFilter);
      void tt
        .mediaSearchAll(mem.query)
        .then((groups) => setCrossState({ query: mem.query, groups }))
        .catch(() => {});
    } else if (useStore.getState().mediaIndex.some((x) => x.udn === scope && x.state === "ready")) {
      void tt
        .mediaSearch(scope, mem.query)
        .then((res) => setSearchState({ query: mem.query, ...res }))
        .catch(() => {});
    } else if (mem.scoped) {
      setSearchState(mem.scoped);
    }
    // the [searchMode] focus effect misses re-entry from within search mode
    // (true → true across the commit) — select the recalled text explicitly
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return true;
  };

  const exitSearch = (): void => {
    setSearchMode(false);
    setSearchState(null);
    setCrossState(null);
    setSearchServerUdn(null);
    setSearchQuery("");
    setSearchKind("all");
    setSearchSort("relevance");
    setSearchSortReversed(false);
    document.documentElement.classList.remove("filter-focused");
  };

  /** Entering search is a NAVIGATION: record the spot being left (lens
   *  included) so Back returns exactly there — found 2026-08-31 when Back
   *  after "Search libraries" dumped the Albums lens at the top level.
   *  The ⌘F flows that RELOCATE first go through moveTo, which already
   *  pushed (a second push here would cost two Backs); history restores
   *  (restoreSpot) call setSearchMode directly and must never push. */
  const enterSearch = (): void => {
    d.late.current.pushSpot();
    setSearchMode(true);
  };

  // Palette/global "search the library" ask, carrying its own id (it no longer
  // rides the reset nonce — ⌘F must not reset the browse tree underneath the
  // search, so it doesn't bump it, which left the nonce unable to tell two
  // consecutive ⌘F presses apart).
  //
  // Claimed at most once per id — so exiting search manually isn't fought by a
  // re-running effect — and CLEARED once claimed, which is what stops a stale
  // ask re-firing on a later mount. `ready` parks the ask until the server
  // listing lands rather than consuming it into nothing; see useOneShotAsk.
  const librarySearchTarget = useStore((s) => s.librarySearchTarget);
  const clearLibrarySearchTarget = useStore((s) => s.clearLibrarySearchTarget);
  useOneShotAsk(
    librarySearchTarget,
    (ask) => {
      if (!servers) return;
      // A SEEDED ask (the Search→Library handoff: "See all N in the Library")
      // brings the unified query along and skips find-recall below — restoring
      // yesterday's search over an explicit ask would answer a question nobody
      // asked.
      const seeded = ask.query?.trim() || null;
      const ready = new Set(
        useStore
          .getState()
          .mediaIndex.filter((x) => x.state === "ready")
          .map((x) => x.udn),
      );
      const eligible = (x: MediaServerInfo): boolean => x.searchable || ready.has(x.udn);
      // Find-recall first: ⌘F brings back the session's last search wholesale
      // (scope included) when that scope is still eligible; an ineligible or
      // absent memory falls through to the fresh-search picks below.
      const mem = seeded == null ? searchMemory : null;
      if (mem?.query.trim()) {
        const memServer = mem.udn ? servers.find((x) => x.udn === mem.udn) : undefined;
        const memEligible =
          mem.udn === null ? ready.size >= 2 : memServer != null && eligible(memServer);
        if (memEligible) {
          d.late.current.moveTo(mem.udn, []);
          setSearchMode(true);
          restoreSearchMemory(mem.udn);
          return;
        }
      }
      // Two or more ready indexes → the root cross-server search: no arbitrary
      // server pick (the reason a default-search-server setting was rejected).
      // With one, the scoped flow below keeps its live fallback.
      if (ready.size >= 2) {
        d.late.current.moveTo(null, []);
        setSearchMode(true);
        if (seeded != null) setSearchQuery(seeded);
        return;
      }
      const current = servers.find((x) => x.udn === serverUdn);
      if (current && eligible(current)) {
        // no relocation on this path — enterSearch records the spot itself
        enterSearch();
        if (seeded != null) setSearchQuery(seeded);
        return;
      }
      const target = servers.find(eligible);
      if (!target) return;
      d.late.current.moveTo(target.udn, []);
      setSearchMode(true);
      if (seeded != null) setSearchQuery(seeded);
    },
    {
      claim: librarySearchTarget?.id,
      clear: clearLibrarySearchTarget,
      ready: servers != null, // listing still loading; runs when it lands
    },
  );

  const returnToSearch = (): void => {
    if (!searchReturn) return;
    d.late.current.rememberScroll();
    filterMemory.set(nodeKey(serverUdn, path), filter);
    if (searchReturn.cross) {
      // the cross-server search lives at the root — leave the scoped server
      d.setScreenFilter("library", "");
      d.setServerUdn(null);
      d.setPath([]);
      setSearchMode(true);
      setSearchQuery(searchReturn.query);
      setCrossState({ query: searchReturn.query, groups: searchReturn.cross });
      return;
    }
    d.setScreenFilter("library", filterMemory.get(nodeKey(serverUdn, searchReturn.prevPath)) ?? "");
    d.setPath(searchReturn.prevPath);
    setSearchMode(true);
    setSearchQuery(searchReturn.query);
    setSearchState({
      query: searchReturn.query,
      items: searchReturn.items,
      total: searchReturn.total,
    });
  };

  const runSearch = (): void => {
    const query = searchQuery.trim();
    if (!query) return;
    // hand the keyboard back to navigation (Backspace = exit search)
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (atRoot) {
      // cross-server: all ready indexes at once, answered in-memory
      setSearching(true);
      void tt
        .mediaSearchAll(query)
        .then((groups) => setCrossState({ query, groups }))
        .catch(() => d.late.current.showNotice("Search failed."))
        .finally(() => setSearching(false));
      return;
    }
    if (!serverUdn) return;
    setSearching(true);
    void tt
      .mediaSearch(serverUdn, query)
      .then((res) => setSearchState({ query, ...res }))
      .catch(() => d.late.current.showNotice("Search failed. The server didn't answer."))
      .finally(() => setSearching(false));
  };

  // As-you-type search: with a READY local index the lookup is instant and
  // free (no server round-trip), so results update live while typing. Enter
  // still runs the full search everywhere — including index-less servers,
  // where per-keystroke SOAP against the server would be rude.
  const indexReady = useStore((s) =>
    s.mediaIndex.some((x) => x.udn === serverUdn && x.state === "ready"),
  );
  useEffect(() => {
    if (!searchMode || !indexReady || !serverUdn) return;
    const query = searchQuery.trim();
    if (query.length === 0) {
      setSearchState(null);
      return;
    }
    if (query.length < 2 || searchState?.query === query) return;
    const t = setTimeout(() => {
      void tt
        .mediaSearch(serverUdn, query)
        .then((res) => {
          // only land results for what's still in the box (fast typing races)
          if (searchInputRef.current?.value.trim() === query) setSearchState({ query, ...res });
        })
        .catch(() => {});
    }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchMode, indexReady, serverUdn]);

  // Cross-server as-you-type: always index-backed (that's the whole design),
  // so live results while typing come for free.
  useEffect(() => {
    if (!searchMode || !atRoot) return;
    const query = searchQuery.trim();
    if (query.length === 0) {
      setCrossState(null);
      return;
    }
    if (query.length < 2 || crossState?.query === query) return;
    const t = setTimeout(() => {
      void tt
        .mediaSearchAll(query)
        .then((groups) => {
          // only land results for what's still in the box (fast typing races)
          if (searchInputRef.current?.value.trim() === query) setCrossState({ query, groups });
        })
        .catch(() => {});
    }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchMode, atRoot]);

  return {
    searchMode,
    setSearchMode,
    searchQuery,
    setSearchQuery,
    searchState,
    setSearchState,
    searching,
    searchReturn,
    setSearchReturn,
    searchKind,
    setSearchKind,
    searchSort,
    setSearchSort,
    searchSortReversed,
    setSearchSortReversed,
    crossState,
    setCrossState,
    searchServerUdn,
    setSearchServerUdn,
    crossMode,
    crossServerUdn,
    searchInputRef,
    restoredSearch,
    restoreSearchMemory,
    exitSearch,
    enterSearch,
    returnToSearch,
    runSearch,
  };
}
