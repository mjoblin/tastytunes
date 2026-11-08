// THE SEARCH SCREEN'S CATEGORY RAIL (moved out of SearchScreen.tsx as it was, 0.16.0's tidy): the
// library's partition once it is the screen, a chip per category with its count, and the sort.
import { useStore } from "@/store";
import { SortChip } from "@/components/controls/SortChip";
import { Segmented } from "@/components/controls/Segmented";
import { Chip, GAP_BETWEEN, GAP_WITHIN } from "@/components/chrome/Chrome";
import { cx } from "@/lib/format";
import type { SearchCategoryId, SearchGroup } from "@/lib/searchGroups";
import { SEARCH_SORTS, type LibKind, type SearchRow } from "./searchKit";

export function SearchRail({
  isolated,
  shownCats,
  libKind,
  setLibKind,
  cats,
  hidden,
  toggleCat,
}: {
  isolated: boolean;
  shownCats: Array<SearchGroup<SearchRow>>;
  libKind: LibKind;
  setLibKind(kind: LibKind): void;
  cats: Array<SearchGroup<SearchRow>>;
  hidden: Set<SearchCategoryId>;
  toggleCat(id: SearchCategoryId): void;
}): React.JSX.Element {
  const saveSettings = useStore((s) => s.saveSettings);
  const sort = useStore((s) => s.settings.searchSort);
  const sortReversed = useStore((s) => s.settings.searchSortReversed);
  return (
    <div className={`no-drag flex items-center ${GAP_BETWEEN} flex-wrap px-8 pb-3`}>
      {/* The library is the only category with KINDS inside it (the index
          answers artists, albums and tracks). Its partition appears once
          the library is the screen — same All/Artists/Albums/Tracks
          Segmented its own results use, and a partition is single-select
          by the app's rule, unlike the multi-select category chips. */}
      {isolated && shownCats[0]?.id === "library" && (
        <Segmented<"all" | "artists" | "albums" | "tracks">
          value={libKind}
          onChange={setLibKind}
          options={[
            { value: "all", label: "All" },
            { value: "artists", label: "Artists" },
            { value: "albums", label: "Albums" },
            { value: "tracks", label: "Tracks" },
          ]}
        />
      )}
      <div className={`flex flex-wrap items-center ${GAP_WITHIN}`}>
        {cats.map((c) => {
          // THREE states, not two: matched-and-showing, matched-and-hidden,
          // and NOTHING TO SHOW. The third is disabled rather than merely
          // unlit — a chip you can toggle to no effect is a lie about what
          // is behind it. It still renders, because "we looked here and
          // found nothing" is the answer it exists to give.
          const empty = c.total === 0 && !c.pending && !c.unknown;
          const on = !hidden.has(c.id) && !empty;
          return (
            <Chip
              key={c.id}
              state={empty ? "disabled" : on ? "active" : "idle"}
              data-search-chip={c.id}
              data-on={on}
              data-empty={empty || undefined}
              onClick={() => !empty && toggleCat(c.id)}
              disabled={empty}
              aria-pressed={on}
              title={empty ? `No ${c.label.toLowerCase()} matches` : undefined}
              // the Chip is a flex box (one toolbar height), so a bare space
              // between label and count would collapse — the gap is explicit
              className={cx("gap-1.5", !empty && "motion-safe:active:scale-95")}
            >
              {c.label}
              <span className="tabular-nums fade-dark">
                {c.pending ? "…" : c.unknown ? "—" : c.total}
              </span>
            </Chip>
          );
        })}
      </div>
      <div className="flex-1" />
      {/* Only two sorts generalize across five heterogeneous groups: each
          source's own ranking, and A–Z. Artist/year are library-shaped and
          date-added is favorites-shaped — those live on the owning screens,
          which already sort by them. */}
      <SortChip
        sorts={SEARCH_SORTS}
        neutral="relevance"
        value={sort}
        reversed={sortReversed}
        onChange={(v) => {
          void saveSettings({ searchSort: v, searchSortReversed: false });
        }}
        onToggleReverse={() => void saveSettings({ searchSortReversed: !sortReversed })}
      />
    </div>
  );
}
