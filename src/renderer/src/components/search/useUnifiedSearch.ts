// ONE SEARCH'S RESULTS (0.16.0): the unified search for a query and a scope, lifted from the Search
// screen so the Library's search can widen to Everything in place with the same results. The
// scope decides what is asked (a category left out is never asked, radio's network call above
// all), the user's nav order orders the groups, and lib/searchGroups lays them out. The results,
// the click's action, the ⋯ menus and the groups are the Search screen's own parts.
import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/store";
import {
  hiddenFor,
  layoutGroups,
  orderByNav,
  type SearchCategoryId,
  type SearchGroup,
  type SearchScope,
} from "@/lib/searchGroups";
import { nodeKind, searchMemory, type LibKind, type SearchRow } from "./searchKit";
import { useSearchResults } from "./useSearchResults";
import { useSearchActions } from "./useSearchActions";
import { useSearchMenus } from "./useSearchMenus";
import { useSearchGroups } from "./useSearchGroups";

export interface UnifiedSearch {
  /** Every category in the nav's order, offered or not, with its count. */
  cats: Array<SearchGroup<SearchRow>>;
  shownCats: Array<SearchGroup<SearchRow>>;
  isolated: boolean;
  cap: number;
  anyResults: boolean;
  anyPending: boolean;
  hidden: Set<SearchCategoryId>;
  libKind: LibKind;
  setLibKind(kind: LibKind): void;
  radioFailed: boolean;
  /** The ⋯ menus and confirms the results open, rendered beside them. */
  overlays: React.ReactNode;
}

export function useUnifiedSearch(q: string, scope: SearchScope): UnifiedSearch {
  const navOrder = useStore((s) => s.settings.navOrder);
  // OFF is absolute: the radio category isn't offered at all
  const radioDirectory = useStore((s) => s.settings.radioDirectory);
  const hidden = useMemo(() => hiddenFor(scope), [scope]);
  const [libKind, setLibKind] = useState<LibKind>(searchMemory.libKind);
  useEffect(() => {
    searchMemory.libKind = libKind;
  }, [libKind]);

  const {
    favResults,
    playlistResults,
    presetResults,
    libResults,
    libTotal,
    radio,
    radioPending,
    radioFailed,
  } = useSearchResults(q, hidden, radioDirectory);
  const { playNode, openFavorite } = useSearchActions();

  // the library's partition, offered once the library is the scope
  const libShown = useMemo(
    () =>
      libKind === "all" ? libResults : libResults.filter((n) => `${nodeKind(n)}s` === libKind),
    [libResults, libKind],
  );

  const { openNodeMenu, openFavMenu, setRowMenu, overlays } = useSearchMenus(
    libShown,
    playNode,
    openFavorite,
  );

  const built = useSearchGroups({
    libShown,
    libTotal,
    presetResults,
    playlistResults,
    favResults,
    radio,
    radioPending,
    hidden,
    radioDirectory,
    playNode,
    openFavorite,
    openNodeMenu,
    openFavMenu,
    setRowMenu,
  });

  // the nav's order applied live, then what shows and how much of it (lib/searchGroups)
  const cats = orderByNav(built, navOrder);
  const layout = layoutGroups(cats, hidden);
  return {
    cats,
    shownCats: layout.shown,
    isolated: layout.isolated,
    cap: layout.cap,
    anyResults: layout.anyResults,
    anyPending: layout.anyPending,
    hidden,
    libKind,
    setLibKind,
    radioFailed,
    overlays,
  };
}
