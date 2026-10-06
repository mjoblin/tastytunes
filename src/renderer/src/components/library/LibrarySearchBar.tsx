import { ArrowLeft, Search, X } from "lucide-react";
import { useStore } from "@/store";
import { GAP_BETWEEN } from "@/components/chrome/Chrome";
import { Segmented } from "@/components/controls/Segmented";
import { SortChip } from "@/components/controls/SortChip";
import type { useLibrarySearch } from "@/components/library/useLibrarySearch";

// The Library's SEARCH BAR and its result controls, lifted out of
// LibraryScreen's render (2026-09-13, the fifth lift's third part): the gold
// bar that replaces the breadcrumbs in search mode, with the input, the count,
// the clear and the way back to browsing, and under it the kind filter, the
// server slice and the sort. Everything it shows is the search hook's own
// state; the screen hands the rest in (the ready indexes, the server's name,
// the cross totals) and owns leaving, which is a navigation.

type Search = ReturnType<typeof useLibrarySearch>;
type Store = ReturnType<typeof useStore.getState>;

const SEARCH_SORTS: Array<{
  value: "relevance" | "title" | "artist" | "year";
  label: string;
  noReverse?: boolean;
}> = [
  // reversing relevance is meaningless — "least relevant first" isn't a thing
  { value: "relevance", label: "Relevance", noReverse: true },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "year", label: "Year (newest first)" },
];

export function LibrarySearchBar(
  p: Pick<
    Search,
    | "searchMode"
    | "searchQuery"
    | "setSearchQuery"
    | "runSearch"
    | "searchInputRef"
    | "searching"
    | "crossMode"
    | "crossState"
    | "setCrossState"
    | "searchState"
    | "setSearchState"
    | "searchKind"
    | "setSearchKind"
    | "crossServerUdn"
    | "setSearchServerUdn"
    | "searchSort"
    | "setSearchSort"
    | "searchSortReversed"
    | "setSearchSortReversed"
  > & {
    readyIndexes: Store["mediaIndex"];
    serverName: string | null;
    crossTotal: number;
    crossItemCount: number;
    atRoot: boolean;
    /** Back to browsing: the screen records the spot being left, then exits. */
    leaveSearch(): void;
  },
): React.JSX.Element {
  const {
    searchMode,
    searchQuery,
    setSearchQuery,
    runSearch,
    searchInputRef,
    searching,
    crossMode,
    crossState,
    setCrossState,
    searchState,
    setSearchState,
    searchKind,
    setSearchKind,
    crossServerUdn,
    setSearchServerUdn,
    searchSort,
    setSearchSort,
    searchSortReversed,
    setSearchSortReversed,
    readyIndexes,
    serverName,
    crossTotal,
    crossItemCount,
    atRoot,
    leaveSearch,
  } = p;
  return (
    <>
      {/* search mode: an unmistakable gold bar replaces the breadcrumbs */}
      {searchMode && (
        <div
          data-library-search-bar
          className="no-drag mx-8 mb-3 flex items-center gap-3 px-4 py-2 rounded-xl ring-1 ring-gold/40 bg-golddim"
        >
          <Search size={15} className="text-gold shrink-0" />
          <input
            ref={searchInputRef}
            data-filter-input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              // Just-landed state (⌘F recall selects the text): the history
              // keys NAVIGATE — pressing ⌘← to leave is the reflex this
              // serves. Once the selection collapses (typing, clicking),
              // ⌘-arrows are ordinary text-editing keys again.
              if (
                (e.metaKey || e.altKey) &&
                !e.ctrlKey &&
                (e.key === "ArrowLeft" || e.key === "ArrowRight")
              ) {
                const el = e.currentTarget;
                if (
                  el.selectionStart === 0 &&
                  el.selectionEnd === el.value.length &&
                  el.value.length > 0
                ) {
                  e.preventDefault();
                  if (e.key === "ArrowLeft") useStore.getState().goBack();
                  else useStore.getState().goForward();
                  return;
                }
              }
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch();
              }
              if (e.key === "Escape") {
                // releases focus, keeps the query AND the results view (the
                // app-wide rule, 2026-08-23); "Back to browsing" and ⌘← leave
                // search mode
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
            onFocus={() => document.documentElement.classList.add("filter-focused")}
            onBlur={() => document.documentElement.classList.remove("filter-focused")}
            placeholder={
              crossMode
                ? `Search ${readyIndexes.map((x) => x.serverName).join(", ")}…`
                : `Search all of ${serverName ?? "this library"}…`
            }
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[13.5px] text-ink placeholder:text-gold/50"
          />
          {searching ? (
            <span className="shrink-0 text-[12px] text-gold/80 motion-safe:animate-pulse">
              searching…
            </span>
          ) : crossMode && crossState ? (
            <span className="shrink-0 font-mono text-[11px] text-gold/80 tabular-nums">
              {crossTotal} result{crossTotal === 1 ? "" : "s"}
              {crossTotal > crossItemCount && ` · first ${crossItemCount}`}
            </span>
          ) : searchState ? (
            <span className="shrink-0 font-mono text-[11px] text-gold/80 tabular-nums">
              {searchState.total} result{searchState.total === 1 ? "" : "s"}
              {searchState.total > searchState.items.length &&
                ` · first ${searchState.items.length}`}
            </span>
          ) : null}
          {/* right of the count: the count's width changes as results come in,
              so the x anchors against the stable exit button instead */}
          {searchQuery.length > 0 && (
            <button
              aria-label="Clear search"
              onClick={() => {
                setSearchQuery("");
                setSearchState(null);
                setCrossState(null);
                searchInputRef.current?.focus();
              }}
              className="shrink-0 p-1 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
            >
              <X size={13} />
            </button>
          )}
          <button
            data-library-search-exit
            onClick={leaveSearch}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber text-bg text-[12.5px] font-medium motion-safe:active:scale-95 transition-all"
          >
            <ArrowLeft size={13} /> Back to browsing
          </button>
        </div>
      )}

      {/* search result controls: kind filter + sort, the shared header idioms.
          Kind options follow the hierarchy — artists make albums, albums
          contain tracks — and the sections below render in the same order. */}
      {searchMode && (atRoot ? crossState != null : searchState != null) && (
        <div
          data-library-search-controls
          className={`no-drag mx-8 mb-3 flex items-center ${GAP_BETWEEN}`}
        >
          <Segmented<"all" | "albums" | "artists" | "tracks">
            value={searchKind}
            onChange={setSearchKind}
            options={[
              { value: "all", label: "All" },
              { value: "artists", label: "Artists" },
              { value: "albums", label: "Albums" },
              { value: "tracks", label: "Tracks" },
            ]}
          />
          {/* which server's slice — a filter like its neighbor, so it lives
              in the left cluster; the sort chip keeps its lone right spot.
              Options come from the search's COVERAGE (every ready index),
              not from who matched: a server with no results stays visible
              but inert, so the control never vanishes mid-session and
              nobody wonders whether a server dropped off the network. */}
          {crossMode && crossState && readyIndexes.length > 1 && (
            <div data-library-server-filter>
              <Segmented<string>
                value={crossServerUdn ?? "__all__"}
                onChange={(v) => setSearchServerUdn(v === "__all__" ? null : v)}
                options={[
                  { value: "__all__", label: "All libraries" },
                  ...[...readyIndexes]
                    .sort((a, b) => a.serverName.localeCompare(b.serverName))
                    .map((x) => {
                      const hasMatches = crossState.groups.some((g) => g.udn === x.udn);
                      return {
                        value: x.udn,
                        label:
                          x.serverName.length > 18 ? `${x.serverName.slice(0, 17)}…` : x.serverName,
                        disabled: !hasMatches,
                        tip: hasMatches ? undefined : `No matches on ${x.serverName}`,
                      };
                    }),
                ]}
              />
            </div>
          )}
          <div className="flex-1" />
          <SortChip
            sorts={SEARCH_SORTS}
            neutral="relevance"
            value={searchSort}
            reversed={searchSortReversed}
            onChange={(v) => {
              setSearchSort(v);
              setSearchSortReversed(false);
            }}
            onToggleReverse={() => setSearchSortReversed((r) => !r)}
          />
        </div>
      )}
    </>
  );
}
