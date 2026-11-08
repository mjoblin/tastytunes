// THE SEARCH SCREEN'S RESULTS LIST (moved out of SearchScreen.tsx as it was, 0.16.0's tidy): every
// result one keyed list, each category's section with its "more", the library sectioned by kind,
// and the coverage confession for servers the index doesn't hold.
import { useMemo } from "react";
import { Search } from "lucide-react";
import { useStore } from "@/store";
import { EmptyState } from "@/components/chrome/EmptyState";
import { KeyedList } from "@/components/controls/KeyedList";
import { openMenuOn } from "@/lib/menuAt";
import { moreCount, orderRows, type SearchCategoryId, type SearchGroup } from "@/lib/searchGroups";
import type { SearchRow } from "./searchKit";

export function SearchResults({
  q,
  shownCats,
  cats,
  cap,
  isolated,
  anyResults,
  anyPending,
  hidden,
  setHidden,
  radioFailed,
}: {
  q: string;
  shownCats: Array<SearchGroup<SearchRow>>;
  cats: Array<SearchGroup<SearchRow>>;
  cap: number;
  isolated: boolean;
  anyResults: boolean;
  anyPending: boolean;
  hidden: Set<SearchCategoryId>;
  setHidden(hidden: Set<SearchCategoryId>): void;
  radioFailed: boolean;
}): React.JSX.Element {
  const sort = useStore((s) => s.settings.searchSort);
  const sortReversed = useStore((s) => s.settings.searchSortReversed);
  const requestLibrarySearch = useStore((s) => s.requestLibrarySearch);
  const mediaIndex = useStore((s) => s.mediaIndex);
  const setScreen = useStore((s) => s.setScreen);
  const setScreenFilter = useStore((s) => s.setScreenFilter);

  // The library group answers from the INDEXES only; a server that isn't
  // indexed (yet, or ever) is invisible here. What the Library can do about it
  // depends on the server: one that answers UPnP Search itself is asked directly
  // by the Library's search box; a Browse-only one (the streamer's USB stick)
  // has no search until its index is built, from its card in the Library.
  // Silent disagreement between the two searches is what erodes trust — so when
  // that gap exists, this screen says so, and says which (user, 2026-09-17).
  const libUnindexed = useMemo(() => mediaIndex.filter((x) => x.state !== "ready"), [mediaIndex]);
  const libLive = useMemo(() => libUnindexed.filter((x) => x.searchable !== false), [libUnindexed]);
  const libBrowseOnly = useMemo(
    () => libUnindexed.filter((x) => x.searchable === false),
    [libUnindexed],
  );

  // FROM THE KEYBOARD (0.14.0, his K1 to K6): every result one list, one Tab stop, up and down
  // through the categories in their order; Enter does what a result's click does, "." its menu
  const LIB_KINDS = new Set<string | undefined>(["artist", "album", "track"]);
  const resultLines = shownCats.reduce((n, c) => {
    const rows = c.rows.slice(0, cap);
    return (
      n + (c.id === "library" ? rows.filter((r) => LIB_KINDS.has(r.kind)).length : rows.length)
    );
  }, 0);
  const rowOf = (el: HTMLElement | null): HTMLElement | null =>
    el?.firstElementChild instanceof HTMLElement ? el.firstElementChild : null;

  return (
    <KeyedList
      label="Results"
      count={resultLines}
      onEnter={(_i, el) => rowOf(el)?.click()}
      onMenu={(_i, el) => openMenuOn(rowOf(el))}
      className="max-w-2xl space-y-6"
    >
      {(item) => {
        let line = 0;
        return (
          <>
            {!anyResults && !anyPending && (
              <EmptyState
                icon={Search}
                title={`Nothing found for “${q}”`}
                caption={
                  hidden.size > 0
                    ? "Some categories are hidden. Try showing them again."
                    : "Try fewer words."
                }
              />
            )}

            {shownCats.map((c) => {
              if (c.rows.length === 0 && !c.pending && !(c.id === "radio" && radioFailed))
                return null;
              const ordered = orderRows(c.rows, sort, sortReversed);
              const more = moreCount(c.total, ordered.length, cap);
              return (
                <section key={c.id} className="space-y-1.5">
                  <div className="flex items-baseline gap-2 px-1">
                    {/* the CATEGORY heading — tagged so it can't be confused
                        with the kind sub-headings below it, which share the
                        microlabel look */}
                    <span data-search-group={c.id} className="microlabel">
                      {c.label}
                    </span>
                    <span className="text-[11px] text-faint tabular-nums">{c.total}</span>
                    {c.pending && (
                      <span className="text-[11px] text-faint motion-safe:animate-pulse">
                        searching…
                      </span>
                    )}
                    <div className="flex-1" />
                    {more > 0 &&
                      (isolated ? (
                        // Already the whole screen and STILL more — the rest
                        // lives on the owning screen, which has the room and
                        // the sorting for it.
                        c.owner ? (
                          <button
                            data-search-more={c.id}
                            onClick={() => {
                              setScreenFilter(c.owner!.filterKey, q);
                              setScreen(c.owner!.screen);
                            }}
                            className="text-[11.5px] text-amber hover:brightness-110 transition-all"
                          >
                            See all {c.total} in {c.label} →
                          </button>
                        ) : c.id === "library" ? (
                          // The library's deeper tool IS its own search —
                          // complete results, four sorts, live reach into
                          // unindexed servers. Handing the query over (rather
                          // than dead-ending at "narrow the search") is what
                          // teaches the two-tier model: Search skims, the
                          // Library digs.
                          <button
                            data-search-more={c.id}
                            onClick={() => requestLibrarySearch(q)}
                            className="text-[11.5px] text-amber hover:brightness-110 transition-all"
                          >
                            See all {c.total} in the Library →
                          </button>
                        ) : (
                          <span className="text-[11.5px] text-faint">
                            +{more} more. Narrow the search to see them.
                          </span>
                        )
                      ) : (
                        // Not isolated: showing more of THIS is the obvious
                        // meaning of the click, and it keeps you on the screen.
                        <button
                          data-search-more={c.id}
                          onClick={() =>
                            setHidden(new Set(cats.filter((x) => x.id !== c.id).map((x) => x.id)))
                          }
                          className="text-[11.5px] text-amber hover:brightness-110 transition-all"
                        >
                          +{more} more →
                        </button>
                      ))}
                  </div>
                  {c.id === "radio" && radioFailed && (
                    <div className="text-[12.5px] text-faint">
                      Couldn&rsquo;t reach the station directory. Everything above is local and
                      unaffected.
                    </div>
                  )}
                  {/* SECTIONED BY KIND once the library owns the screen. The
                      taxonomy is closed at three (lib/media), and the Library's
                      own results already read artists → albums → tracks — the
                      hierarchy order, artists make albums, albums contain
                      tracks. Mixed into one list it read as an unsorted jumble:
                      the order was always artists→albums→tracks, but nothing
                      said so. Headings ALWAYS (user, 2026-07-25) — six rows
                      split three ways still beats six rows that look shuffled. */}
                  {c.id === "library"
                    ? (["artist", "album", "track"] as const).map((k) => {
                        const inKind = ordered.slice(0, cap).filter((r) => r.kind === k);
                        if (inKind.length === 0) return null;
                        return (
                          <div key={k} className="space-y-1.5">
                            <div className="microlabel pt-2 px-1 fade-dark">
                              {k === "artist" ? "Artists" : k === "album" ? "Albums" : "Tracks"}{" "}
                              <span className="tabular-nums">{inKind.length}</span>
                            </div>
                            {inKind.map((r) => (
                              <div key={r.key} {...item(line++)} className="rounded-xl">
                                {r.node}
                              </div>
                            ))}
                          </div>
                        );
                      })
                    : ordered.slice(0, cap).map((r) => (
                        <div key={r.key} {...item(line++)} className="rounded-xl">
                          {r.node}
                        </div>
                      ))}
                </section>
              );
            })}

            {/* The coverage confession — deliberately OUTSIDE the sections, so
                it still shows when the library group found nothing precisely
                BECAUSE the content lives on an unindexed server. */}
            {libLive.length > 0 && !hidden.has("library") && (
              <div
                data-search-unindexed="live"
                className="flex items-baseline gap-2 text-[12px] text-faint"
              >
                <span className="min-w-0">
                  {libLive.length === 1
                    ? `${libLive[0].serverName} isn't in the search index. Search in the Library asks it directly.`
                    : `${libLive.length} media servers aren't in the search index. Search in the Library asks them directly.`}
                </span>
                <button
                  onClick={() => requestLibrarySearch(q)}
                  className="shrink-0 text-amber hover:brightness-110 transition-all"
                >
                  Search the Library →
                </button>
              </div>
            )}
            {libBrowseOnly.length > 0 && !hidden.has("library") && (
              <div
                data-search-unindexed="browse"
                className="flex items-baseline gap-2 text-[12px] text-faint"
              >
                <span className="min-w-0">
                  {libBrowseOnly.length === 1
                    ? `${libBrowseOnly[0].serverName} can't be searched until its index is built, from its card in the Library.`
                    : `${libBrowseOnly.length} media servers can't be searched until their indexes are built, from their cards in the Library.`}
                </span>
                <button
                  onClick={() => setScreen("library")}
                  className="shrink-0 text-amber hover:brightness-110 transition-all"
                >
                  Open the Library →
                </button>
              </div>
            )}
          </>
        );
      }}
    </KeyedList>
  );
}
