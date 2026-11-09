// THE SEARCH SCREEN'S HEADER AND BOX (moved out of SearchScreen.tsx as it was, 0.16.0's tidy): the
// title, the box with its ⌘← after a pivot and its Escape, and the clear button.
import { Search, X } from "lucide-react";
import { historyKeyOnArrival } from "@/lib/historyKeys";
import { ScreenTitle } from "@/components/chrome/Chrome";

export function SearchBox({
  query,
  setQuery,
  inputRef,
}: {
  query: string;
  setQuery(query: string): void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}): React.JSX.Element {
  return (
    <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
      <ScreenTitle>Search</ScreenTitle>
      <div className="relative flex-1 max-w-xl">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Just-landed after a pivot (the seeded query arrives selected): ⌘← navigates back
            // to where the pivot left, while there is somewhere to go (lib/historyKeys)
            if (historyKeyOnArrival(e, { forward: false, needsBackStack: true })) return;
            if (e.key !== "Escape") return;
            // Escape RELEASES FOCUS and keeps the query (2026-08-23, the
            // app-wide rule — see FilterInput). The box takes focus on
            // arrival and screen keys are suppressed while an input has it,
            // so the blur is what gives the keyboard back; the query and its
            // results are remembered for the return anyway.
            e.stopPropagation(); // ...before it closes anything else
            e.currentTarget.blur();
          }}
          placeholder="Search everything"
          aria-label="Search everything"
          data-search-input
          className="no-drag w-full bg-bg rounded-lg ring-1 ring-edge focus:ring-edge2 outline-none pl-9 pr-8 py-2 text-[13.5px] placeholder:text-faint"
        />
        {query && (
          <button
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="no-drag absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-faint hover:text-ink transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </header>
  );
}
