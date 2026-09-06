import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

/**
 * ONE home for windowing a long list (2026-09-05, 0.8.0): render only the
 * items near the viewport, hold the scroll height with two spacers, keep every
 * item's ABSOLUTE index (selection edges, dnd ids, follow-by-index untouched).
 * Born from two hand-rolled copies — the Tracks lens (measured row height,
 * snapped scroll) and the Queue's lean rows (pitch from two rendered rows, an
 * offset for content above the list) — and the History Timeline, whose rows
 * come in three heights (a day header, a session head, a play row).
 *
 * Geometry is MEASURED, never assumed: each kind's height comes from the first
 * rendered element of that kind (the roots the consumer renders, found by
 * `itemSelector`, carry data-win-kind when there is more than one kind), the
 * gap between items from two consecutive rendered elements, and the offset of
 * item 0 within the scroller from where the first rendered element sits. A
 * prefix sum over the kinds turns a scroll position into an index range and an
 * index into a scroll position (offsetOf, the land-by-index helper).
 *
 * Below the consumer's threshold, `enabled: false` renders everything with no
 * listeners and no spacers — an ordinary list is byte-for-byte as before.
 */
export interface WindowedListOptions {
  /** The scroll container. */
  scrollRef: RefObject<HTMLElement | null>;
  /** How many items the list has. */
  count: number;
  /** Finds a rendered item's ROOT inside the scroller, for measurement. */
  itemSelector: string;
  /** Per-item kind when rows differ in height (memoize the array); items of
   *  one kind share a height. Omit for a single-kind list. */
  kinds?: readonly string[];
  /** Height guesses until measured: one number, or one per kind. */
  estimate: number | Record<string, number>;
  /** Items rendered beyond each edge of the viewport. */
  overscan?: number;
  /** false = render everything (the ordinary case below a threshold). */
  enabled?: boolean;
}

export interface WindowedList {
  /** The inclusive index range to render (0..count-1 when disabled). */
  first: number;
  last: number;
  /** The first item actually in view (no overscan) — a floating header or a
   *  rail highlight reads it; 0 while disabled. */
  firstVisible: number;
  /** Spacer heights holding the scroll height above and below the slice. */
  padTop: number;
  padBottom: number;
  /** The scrollTop that puts item `index` at the scroller's top edge. */
  offsetOf(index: number): number;
}

const ONE = "row";

/** The largest i in [0, n-1] with prefix[i] <= y (0 when y is above the list). */
function indexAt(prefix: Float64Array, count: number, y: number): number {
  if (count === 0 || y <= 0) return 0;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function useWindowedList({
  scrollRef,
  count,
  itemSelector,
  kinds,
  estimate,
  overscan = 8,
  enabled = true,
}: WindowedListOptions): WindowedList {
  const [heights, setHeights] = useState<Record<string, number>>(() =>
    typeof estimate === "number" ? { [ONE]: estimate } : { ...estimate },
  );
  const [gap, setGap] = useState(0);
  const [range, setRange] = useState<[number, number, number]>([
    0,
    Math.min(count, overscan * 3) - 1,
    0,
  ]);
  const offsetRef = useRef(0);
  const fallback = typeof estimate === "number" ? estimate : (Object.values(estimate)[0] ?? 48);

  // the prefix sum: prefix[i] = content height above item i (gaps included)
  const prefix = useMemo(() => {
    const p = new Float64Array(count + 1);
    let acc = 0;
    for (let i = 0; i < count; i++) {
      const k = kinds ? kinds[i] : ONE;
      acc += (heights[k] ?? fallback) + gap;
      p[i + 1] = acc;
    }
    return p;
  }, [count, kinds, heights, gap, fallback]);

  // refs for the measurer (it runs from scroll frames, outside render)
  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;
  const heightsRef = useRef(heights);
  heightsRef.current = heights;
  const gapRef = useRef(gap);
  gapRef.current = gap;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const measureRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    const sc = scrollRef.current;
    if (!sc) return;
    let raf = 0;
    const measure = (): void => {
      raf = 0;
      const els = sc.querySelectorAll<HTMLElement>(itemSelector);
      if (els.length > 0) {
        const r0 = els[0].getBoundingClientRect();
        // heights: the first rendered element of each kind speaks for the kind
        let nextHeights: Record<string, number> | null = null;
        const seen = new Set<string>();
        for (const el of els) {
          const k = el.dataset.winKind ?? ONE;
          if (seen.has(k)) continue;
          seen.add(k);
          const h = el.getBoundingClientRect().height;
          if (h > 0 && Math.abs((heightsRef.current[k] ?? -1) - h) > 0.5)
            nextHeights = { ...(nextHeights ?? heightsRef.current), [k]: h };
        }
        if (nextHeights) setHeights(nextHeights);
        // the gap between items, from two neighbours (space-y / flex gap)
        if (els.length > 1) {
          const r1 = els[1].getBoundingClientRect();
          const g = r1.top - r0.bottom;
          if (g >= 0 && g < 64 && Math.abs(g - gapRef.current) > 0.5) setGap(g);
        }
        // where item 0 would sit in the scroll content: the first rendered
        // element's position, less the content the prefix says is above it
        offsetRef.current =
          r0.top -
          sc.getBoundingClientRect().top +
          sc.scrollTop -
          prefixRef.current[rangeRef.current[0]];
      }
      const p = prefixRef.current;
      const y0 = sc.scrollTop - offsetRef.current;
      const visible = indexAt(p, count, y0);
      const first = Math.max(0, visible - overscan);
      const last = Math.min(count - 1, indexAt(p, count, y0 + sc.clientHeight) + overscan);
      const next: [number, number, number] = [first, Math.max(first, last), visible];
      setRange((r) => (r[0] === next[0] && r[1] === next[1] && r[2] === next[2] ? r : next));
    };
    measureRef.current = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    const onScroll = (): void => measureRef.current();
    sc.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(sc);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      measureRef.current = () => {};
    };
  }, [enabled, count, itemSelector, overscan, scrollRef]);

  // after every render of a new slice, measure what just appeared (a kind seen
  // for the first time, a height that changed with the window's width)
  useEffect(() => {
    if (enabled) measureRef.current();
  }, [enabled, range, heights, gap, count]);

  if (!enabled) {
    return {
      first: 0,
      last: count - 1,
      firstVisible: 0,
      padTop: 0,
      padBottom: 0,
      offsetOf: (i) => prefix[Math.max(0, Math.min(count, i))],
    };
  }
  const first = Math.min(range[0], Math.max(0, count - 1));
  const last = Math.min(range[1], count - 1);
  return {
    first,
    last,
    firstVisible: Math.min(range[2], Math.max(0, count - 1)),
    padTop: count === 0 ? 0 : prefix[first],
    padBottom: count === 0 || last < first ? 0 : Math.max(0, prefix[count] - prefix[last + 1]),
    offsetOf: (i) => offsetRef.current + prefix[Math.max(0, Math.min(count, i))],
  };
}
