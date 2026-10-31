import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWindowedList, type WindowedList } from "@/hooks/useWindowedList";

// The lenses' card grid, moved out of the Albums lens (0.13.0 round 12) when the Artists lens
// took cards too: one home for how a lens's cards are laid out, windowed and brought back to
// the spot a trip away left.

/** Past this many cards a lens's grid windows its rows (0.11.0 sweep, for review). */
export const WINDOW_CARDS_ABOVE = 120;

/**
 * THE SCROLLBAR'S ROOM, HELD FROM THE START (his eye on 0.13.0, 2026-10-25: the Albums lens's grid
 * "seems to grow its cards" as it opens). A windowed grid counts its columns from its width before
 * any row exists, so before the rows overflow and the 10 px scrollbar arrives; where those 10 px
 * took a column away (a window just above a column boundary) the grid painted one more column,
 * then every card grew a fifth (160 to 202 px, S147). The lens's scroller keeps the scrollbar's
 * gutter whether it scrolls or not, so the width the grid measures is the width it keeps.
 */
export const CARD_GRID_SCROLLER: React.CSSProperties = { scrollbarGutter: "stable" };

/**
 * WINDOWED CARDS (0.11.0 sweep): past a lens's threshold the cards grid renders only the rows of
 * cards near the scroller's viewport, as many columns as auto-fill would give (from the measured
 * width inside the scroller, its scrollbar excluded), the rows' pitch measured by
 * useWindowedList. Until the width is measured (the layout effect, before the first paint) it
 * renders none: it rendered every tile, and at 5,000 albums that first pass, its pictures each
 * reading their ancestors' styles, took 1.5 of the lens's 1.9 s to open (0.13.0, the scale
 * fixture). Below the threshold every tile renders, in an auto-fill grid. `bodyRef` goes on the
 * element inside the scroller whose width the columns share.
 */
export function useCardGrid({
  scrollRef,
  count,
  cardSize,
  cardGap,
  fillRows,
  windowed,
  rowSelector,
  restoreTop,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** How many cards. */
  count: number;
  cardSize: number;
  cardGap: number;
  fillRows: boolean;
  /** Render only the rows near the viewport (the lens's threshold passed). */
  windowed: boolean;
  /** The windowed rows' selector, for their measured pitch. */
  rowSelector: string;
  /** The scroller's spot when the lens was last left, read once as it mounts. */
  restoreTop: number;
}): {
  bodyRef: React.RefObject<HTMLDivElement | null>;
  /** The measured width inside the scroller; 0 until the first layout. */
  width: number;
  cols: number;
  win: WindowedList;
  /** The grid's columns: `cols` for a windowed row, "auto-fill" for the whole grid. */
  gridColumns(n: number | "auto-fill"): string;
} {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = Math.max(1, Math.floor((width + cardGap) / (cardSize + cardGap)));
  const colWidth = fillRows ? (width - cardGap * (cols - 1)) / cols : cardSize;
  const win = useWindowedList({
    scrollRef,
    count: windowed ? Math.ceil(count / cols) : 0,
    itemSelector: rowSelector,
    // the art is square; the title and its second line below it
    estimate: Math.round(colWidth) + 52 + cardGap,
    overscan: 3,
    enabled: windowed && width > 0,
  });
  // A TRIP AWAY COMES BACK TO THE SPOT, once the grid can hold it: the windowed grid holds no
  // rows until it has measured its width, and a scrollTo then clamped the spot to 0 (the
  // useScrollMemory rule), so settle a few frames, and apply once more after the rows it lands
  // on have been measured (their height was an estimate until then)
  const target = useRef(restoreTop);
  useEffect(() => {
    const top = target.current;
    if (top <= 0) return;
    let frames = 0;
    let landed = 0;
    let raf = requestAnimationFrame(function apply() {
      const sc = scrollRef.current;
      if (!sc) return;
      if (landed > 0 || sc.scrollHeight - sc.clientHeight >= top || frames++ > 30) {
        sc.scrollTo({ top });
        if (++landed >= 3 || Math.abs(sc.scrollTop - top) < 1) return;
      }
      raf = requestAnimationFrame(apply);
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollRef]);
  const gridColumns = (n: number | "auto-fill"): string =>
    fillRows ? `repeat(${n}, minmax(${cardSize}px, 1fr))` : `repeat(${n}, ${cardSize}px)`;
  return { bodyRef, width, cols, win, gridColumns };
}
