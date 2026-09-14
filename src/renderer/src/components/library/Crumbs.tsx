import { useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { cx } from "@/lib/format";
import { PopoverCard } from "@/components/chrome/Overlay";

/** One crumb of the trail: what it says and where it leads. */
export interface CrumbItem {
  key: string;
  label: string;
  /** Absent = not a way anywhere (the lens label). */
  onClick?: () => void;
  /** Where you are: ink, not a hover target. */
  current?: boolean;
  /** The way back to search results: gold with the glyph (the search bar's identity). */
  search?: boolean;
}

/** The trail keeps this many from the start (Library, the source, the volume)
 *  and this many from the end (the parent folder, the album) when it folds. */
const HEAD = 3;
const TAIL = 2;

/**
 * The Library's breadcrumb trail (2026-09-14, with the folder-path landing:
 * a USB drive's album can sit six folders deep). The row measures itself: a
 * new trail renders whole first and its crumbs' widths are summed before
 * paint; when that natural width would not fit the row, the middle folds
 * into an ellipsis crumb, keeping the first three and the last two, with the
 * folded crumbs one click away in a popover. The natural width is remembered
 * while folded, so a wider window unfolds it and a narrower one cannot
 * flicker. A crumb never grows past a fixed width; a long name truncates and
 * carries its full text as the tip. A folded trail that still does not fit
 * wraps, as the row always could.
 */
export function Crumbs({ items }: { items: CrumbItem[] }): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [folded, setFolded] = useState(false);
  const [fold, setFold] = useState<{ x: number; y: number } | null>(null);
  const canFold = items.length > HEAD + TAIL;
  // the trail's natural width: its crumbs side by side on one line, summed
  // while it is unfolded and remembered while it is folded
  const natural = useRef(0);
  const trailKey = items.map((it) => `${it.key}|${it.label}`).join("\n");
  useLayoutEffect(() => {
    // a new trail is measured whole before it may fold (before paint, so no flicker)
    setFolded(false);
  }, [trailKey]);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const decide = (): void => {
      if (!folded) {
        const kids = [...row.children].filter((el) => !el.hasAttribute("data-popover"));
        const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
        natural.current =
          kids.reduce((w, el) => w + (el as HTMLElement).offsetWidth, 0) +
          gap * Math.max(0, kids.length - 1);
      }
      setFolded(canFold && natural.current > row.clientWidth + 1);
    };
    decide();
    const ro = new ResizeObserver(decide);
    ro.observe(row);
    return () => ro.disconnect();
  }, [canFold, folded, trailKey]);
  const hidden = folded ? items.slice(HEAD, items.length - TAIL) : [];
  const shown: Array<CrumbItem | "fold"> = folded
    ? [...items.slice(0, HEAD), "fold", ...items.slice(items.length - TAIL)]
    : items;
  const crumb = (it: CrumbItem): React.JSX.Element => {
    const long = it.label.length > 28;
    const label = <span className="block max-w-[14rem] truncate">{it.label}</span>;
    if (!it.onClick)
      return (
        <span className="px-1.5 py-0.5 text-ink" data-tip={long ? it.label : undefined}>
          {label}
        </span>
      );
    if (it.search)
      return (
        // the way back to the results this branch was entered from —
        // gold, matching the search bar's identity
        <button
          data-library-search-crumb
          onClick={it.onClick}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-gold/90 hover:text-gold hover:bg-golddim transition-colors"
        >
          <Search size={11} />
          {label}
        </button>
      );
    return (
      <button
        onClick={it.onClick}
        data-tip={long ? it.label : undefined}
        className={cx(
          "px-1.5 py-0.5 rounded transition-colors",
          it.current ? "text-ink" : "text-dim hover:text-ink hover:bg-veil",
        )}
      >
        {label}
      </button>
    );
  };
  return (
    <div ref={rowRef} className="flex items-center gap-1 flex-wrap">
      {shown.map((it, i) => (
        <span key={it === "fold" ? "fold" : it.key} className="flex items-center gap-1 shrink-0">
          {i > 0 && <ChevronRight size={12} className="text-faint" />}
          {it === "fold" ? (
            <button
              data-library-crumbs-fold={hidden.length}
              data-tip={`${hidden.length} more`}
              onClick={(e) => setFold({ x: e.clientX, y: e.clientY })}
              className="px-1.5 py-0.5 rounded text-dim hover:text-ink hover:bg-veil transition-colors"
            >
              …
            </button>
          ) : (
            crumb(it)
          )}
        </span>
      ))}
      {fold && (
        <PopoverCard
          at={fold}
          width="w-56"
          onClose={() => setFold(null)}
          className="p-1.5 space-y-0.5"
        >
          {hidden.map((it) => (
            <button
              key={it.key}
              data-library-crumb-folded
              onClick={() => {
                setFold(null);
                it.onClick?.();
              }}
              className="w-full px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim hover:text-ink hover:bg-veil transition-colors truncate"
            >
              {it.label}
            </button>
          ))}
        </PopoverCard>
      )}
    </div>
  );
}
