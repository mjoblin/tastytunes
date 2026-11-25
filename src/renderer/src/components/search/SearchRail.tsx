// THE SEARCH SCREEN'S SCOPE RAIL (moved out of SearchScreen.tsx as it was, 0.16.0's tidy; one scope
// at a time since one Search): the library's partition once it is the scope, Everything first and
// then a chip per category with its count, one chosen, and the sort.
import { useStore } from "@/store";
import { SortChip } from "@/components/controls/SortChip";
import { Segmented } from "@/components/controls/Segmented";
import { Chip, GAP_BETWEEN, GAP_WITHIN } from "@/components/chrome/Chrome";
import { cx } from "@/lib/format";
import type { SearchScope } from "@/lib/searchGroups";
import { SEARCH_SORTS } from "./searchKit";
import type { UnifiedSearch } from "./useUnifiedSearch";

export function SearchRail({
  search,
  scope,
  setScope,
}: {
  search: UnifiedSearch;
  scope: SearchScope;
  setScope(scope: SearchScope): void;
}): React.JSX.Element {
  const { cats, shownCats, isolated, libKind, setLibKind } = search;
  const saveSettings = useStore((s) => s.saveSettings);
  const sort = useStore((s) => s.settings.searchSort);
  const sortReversed = useStore((s) => s.settings.searchSortReversed);
  // Everything's count is every category's, known only when every one was asked: with one
  // category the scope, radio's directory is not asked, and a partial sum would be a false count
  const everythingCount = cats.some((c) => c.unknown)
    ? null
    : cats.some((c) => c.pending)
      ? "…"
      : cats.reduce((n, c) => n + c.total, 0);
  return (
    <div className={`no-drag flex items-center ${GAP_BETWEEN} flex-wrap px-8 pb-3`}>
      {/* The library is the only category with KINDS inside it (the index
          answers artists, albums and tracks). Its partition appears once
          the library is the scope — same All/Artists/Albums/Tracks
          Segmented its own results use. */}
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
        <Chip
          state={scope === "everything" ? "active" : "idle"}
          data-search-chip="everything"
          data-on={scope === "everything"}
          onClick={() => setScope("everything")}
          aria-pressed={scope === "everything"}
          className="gap-1.5 motion-safe:active:scale-95"
        >
          Everything
          {everythingCount != null && (
            <span className="tabular-nums fade-dark">{everythingCount}</span>
          )}
        </Chip>
        {cats.map((c) => {
          // THREE states, not two: chosen, offered, and NOTHING TO SHOW. The third is disabled
          // rather than merely unlit (a chip that leads nowhere is a lie about what is behind
          // it), unless it is the chosen one, so the scope always shows where it stands. It still
          // renders, because "we looked here and found nothing" is the answer it exists to give.
          const on = scope === c.id;
          const empty = c.total === 0 && !c.pending && !c.unknown && !on;
          return (
            <Chip
              key={c.id}
              state={empty ? "disabled" : on ? "active" : "idle"}
              data-search-chip={c.id}
              data-on={on}
              data-empty={empty || undefined}
              onClick={() => !empty && setScope(c.id)}
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
