import { useEffect, useMemo, useState } from "react";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { Search } from "lucide-react";
import { useStore } from "@/store";
import { EmptyState } from "@/components/chrome/EmptyState";
import {
  layoutGroups,
  orderByNav,
  seedHidden,
  toggleHidden,
  type SearchCategoryId,
} from "@/lib/searchGroups";
import { nodeKind, searchMemory, type LibKind } from "@/components/search/searchKit";
import { useSearchQuery } from "@/components/search/useSearchQuery";
import { useSearchResults } from "@/components/search/useSearchResults";
import { useSearchActions } from "@/components/search/useSearchActions";
import { useSearchMenus } from "@/components/search/useSearchMenus";
import { useSearchGroups } from "@/components/search/useSearchGroups";
import { SearchBox } from "@/components/search/SearchBox";
import { SearchRail } from "@/components/search/SearchRail";
import { SearchResults } from "@/components/search/SearchResults";

/**
 * Unified search: one box over library, favorites, playlists, presets and
 * internet radio.
 *
 * ADDITIVE — every per-screen search stays. Those answer "find within what I'm
 * doing"; this answers "find it when I don't know where it is". That's also why
 * ⌘F is contextual (see useShortcuts): inside the Library it still opens the
 * Library's own search, which has scoping and find-recall this screen doesn't
 * replicate.
 *
 * THE CLICK CONTRACT MATCHES THE REST OF THE APP: leaves play, containers open.
 * A track plays, an album opens in the Library, a playlist opens on the
 * Playlists screen, a station plays, and a preset recalls — a preset having no
 * inside, recall IS its open.
 *
 * LATENCY: the four local groups answer from memory and render on the
 * keystroke; radio is the only network call, so it streams in under its own
 * pending state and can fail on its own without touching the rest.
 *
 * NOT INCLUDED: queue, and recently-played. Recents was asked for and turned
 * down for a concrete reason — the Recently Played screen has no play action at
 * all (it's a read-only log), so its results would be the only ones you
 * couldn't act on. Revisit if that screen gains one.
 *
 * ITS PARTS (0.16.0's tidy, before the design pass's one Search with scopes):
 * components/search holds the query and its focus (useSearchQuery), the results
 * (useSearchResults), a click's action (useSearchActions), the ⋯ menus
 * (useSearchMenus), the five categories as data (useSearchGroups), and the box,
 * the category rail and the results list. This screen holds what they share:
 * the hidden categories, the library partition, and the layout of the groups.
 */
export function SearchScreen(): React.JSX.Element {
  const { query, setQuery, inputRef } = useSearchQuery();
  const navHidden = useStore((s) => s.settings.navHidden);
  const navOrder = useStore((s) => s.settings.navOrder);
  const storedHidden = useStore((s) => s.settings.searchHidden);
  const saveSettings = useStore((s) => s.saveSettings);
  const [hidden, setHidden] = useState<Set<SearchCategoryId>>(() =>
    seedHidden(storedHidden, navHidden),
  );
  const [libKind, setLibKind] = useState<LibKind>(searchMemory.libKind);
  useEffect(() => {
    searchMemory.libKind = libKind;
  }, [libKind]);
  // the results list keeps its spot across a trip to another screen
  const resultsScroll = useScrollMemory("search");
  // OFF is absolute — the category isn't offered at all, so there is no chip to
  // switch back on and no way to reach the directory from here. HIDDEN is the
  // softer state above it: offered, off by default, one click away.
  const radioDirectory = useStore((s) => s.settings.radioDirectory);

  const q = query.trim();

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

  // Library sub-filter, offered only when the library IS the screen — the same
  // All/Artists/Albums/Tracks partition its own results screen uses.
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

  // THE USER'S NAV ORDER, applied live (not seeded once like `hidden` — a
  // reorder should land on this screen immediately, whereas a hide is a
  // starting point the chips then own for the session), then what shows and
  // how much of it — the rules in lib/searchGroups, a sorted copy so every
  // count, cap and row stays exactly where it was built.
  const cats = orderByNav(built, navOrder);
  const { shown: shownCats, isolated, cap, anyResults, anyPending } = layoutGroups(cats, hidden);

  const toggleCat = (id: SearchCategoryId): void => {
    // hiding the last visible category shows everything again (the rule in lib/searchGroups)
    const final = toggleHidden(hidden, id, cats.length);
    setHidden(final);
    void saveSettings({ searchHidden: [...final] });
  };

  return (
    <div className="h-full flex flex-col">
      <SearchBox query={query} setQuery={setQuery} inputRef={inputRef} />

      {overlays}

      {/* The category rail: what was searched, how much each holds, and which
          are showing. Counts are the POINT — a category with 0 still gets a
          chip, because "we looked and found nothing" is an answer and its
          absence would read as "we didn't look". */}
      {q && (
        <SearchRail
          isolated={isolated}
          shownCats={shownCats}
          libKind={libKind}
          setLibKind={setLibKind}
          cats={cats}
          hidden={hidden}
          toggleCat={toggleCat}
        />
      )}

      <div ref={resultsScroll} className="flex-1 overflow-y-auto px-8 pb-10 pt-1">
        {!q ? (
          // Centered: with no query there is nothing else on the screen, and a
          // block hugging the top of an empty page reads as a loading state.
          <div className="h-full flex items-center justify-center">
            <EmptyState
              icon={Search}
              title="Search everything"
              caption="Your library, favorites, playlists, presets and internet radio, all at once. Press S from anywhere, or ⇧⌘F even inside the Library (whose own ⌘F search digs deeper there)."
            />
          </div>
        ) : (
          <SearchResults
            q={q}
            shownCats={shownCats}
            cats={cats}
            cap={cap}
            isolated={isolated}
            anyResults={anyResults}
            anyPending={anyPending}
            hidden={hidden}
            setHidden={setHidden}
            radioFailed={radioFailed}
          />
        )}
      </div>
    </div>
  );
}
