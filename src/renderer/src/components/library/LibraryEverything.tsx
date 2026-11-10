// THE LIBRARY'S SEARCH, WIDENED (0.16.0, one Search): Everything chosen under the Library's search
// box shows the Search screen's Everything for the same query, in place, without leaving the
// Library. Nothing beyond the library is asked until it is chosen (radio's directory above all).
// A group's "+N more" narrows: the library's back to the Library's own search, any other category
// to the Search screen at that scope, the query with it.
import { useStore } from "@/store";
import type { SearchScope } from "@/lib/searchGroups";
import { SearchResults } from "@/components/search/SearchResults";
import { useUnifiedSearch } from "@/components/search/useUnifiedSearch";

export function LibraryEverything({
  q,
  toLibrary,
}: {
  q: string;
  /** Back to the Library's own results for the query. */
  toLibrary(): void;
}): React.JSX.Element {
  const search = useUnifiedSearch(q, "everything");
  const requestSearch = useStore((s) => s.requestSearch);
  const narrow = (scope: SearchScope): void => {
    if (scope === "everything") return;
    if (scope === "library") {
      toLibrary();
      return;
    }
    // the Search screen narrowed to that category for now, the remembered scope kept
    requestSearch(q, scope);
  };
  return (
    // the Library's scroller already gives the page its side padding
    <div data-library-everything className="pb-10 pt-1">
      {search.overlays}
      <SearchResults q={q} search={search} scope="everything" setScope={narrow} />
    </div>
  );
}
