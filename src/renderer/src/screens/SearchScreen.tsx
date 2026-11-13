import { useEffect, useState } from "react";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { Search } from "lucide-react";
import { useStore } from "@/store";
import { EmptyState } from "@/components/chrome/EmptyState";
import { pageEdges } from "@/components/chrome/Chrome";
import { sanitizeScope, type SearchScope } from "@/lib/searchGroups";
import { useSearchQuery } from "@/components/search/useSearchQuery";
import { useUnifiedSearch } from "@/components/search/useUnifiedSearch";
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
 * ONE SCOPE AT A TIME (0.16.0, one Search): Everything first, or one category,
 * each chip with its count; the scope is remembered as the hidden categories were.
 * The Library's own search widens to the same Everything in place.
 *
 * ITS PARTS (0.16.0's tidy, then one Search): components/search holds the query
 * and its focus (useSearchQuery), the results for a query and a scope
 * (useUnifiedSearch, over useSearchResults, useSearchActions, useSearchMenus and
 * useSearchGroups), and the box, the scope rail and the results list. This
 * screen holds the scope and lays them out.
 */
export function SearchScreen(): React.JSX.Element {
  const { query, setQuery, inputRef, narrowTo } = useSearchQuery();
  const saveSettings = useStore((s) => s.saveSettings);
  const stored = sanitizeScope(useStore((s) => s.settings.searchScope));
  // A CHIP CHOSEN IS REMEMBERED; a group's "+N more", or an ask that names a scope (a pivot's
  // Everything, a link's one category), narrows the view for now and leaves the remembered scope
  // as it was, as the "+N more" isolate always did
  const [narrowed, setNarrowed] = useState<SearchScope | null>(null);
  useEffect(() => {
    if (narrowTo) setNarrowed(narrowTo.scope);
  }, [narrowTo]);
  const scope = narrowed ?? stored;
  const choose = (next: SearchScope): void => {
    setNarrowed(null);
    void saveSettings({ searchScope: next });
  };
  // the results list keeps its spot across a trip to another screen
  const resultsScroll = useScrollMemory("search");
  const q = query.trim();
  const search = useUnifiedSearch(q, scope);

  return (
    <div className="h-full flex flex-col">
      <SearchBox query={query} setQuery={setQuery} inputRef={inputRef} />

      {search.overlays}

      {/* The scope rail: Everything first, then each category, one at a time. Counts are the
          POINT — a category with 0 still gets a chip, because "we looked and found nothing" is an
          answer and its absence would read as "we didn't look". */}
      {q && <SearchRail search={search} scope={scope} setScope={choose} />}

      <div ref={resultsScroll} className={`flex-1 overflow-y-auto px-8 ${pageEdges()}`}>
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
          <SearchResults q={q} search={search} scope={scope} setScope={setNarrowed} />
        )}
      </div>
    </div>
  );
}
