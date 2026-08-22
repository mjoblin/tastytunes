import { useCallback, useRef } from "react";

// Session-scoped scroll positions per screen. Screens unmount when you switch
// pages, so their scrollTop is remembered here and restored on return.
const scrollMemory = new Map<string, number>();

/** How long a mount keeps re-applying a remembered spot while content lands. */
const SETTLE_MS = 4000;

/**
 * Attach to a scrollable container: `<div ref={useScrollMemory('queue')}>`.
 * Restores the remembered position on mount (unless `restoreOnMount` is false —
 * e.g. the queue when follow-current is on, which does its own scrolling) and
 * records the position as the user scrolls.
 *
 * ASYNC LISTS (2026-08-22): a search's results or a browse's rows render after
 * the scroller mounts, so a one-shot restore met an empty list and clamped to
 * 0 — the spot was remembered and still lost. The restore now RE-APPLIES as
 * the content grows (resize + childList observers, SETTLE_MS at most) until
 * the remembered spot is reachable, and a real scroll by the user ends it:
 * while settling, a scroll event that lands exactly where we put it is ours
 * and is not recorded, anything else is the user's and wins.
 */
export function useScrollMemory(
  key: string,
  restoreOnMount = true,
): (node: HTMLDivElement | null) => void {
  const detach = useRef<(() => void) | null>(null);
  const restore = useRef(restoreOnMount);
  restore.current = restoreOnMount;

  return useCallback(
    (node: HTMLDivElement | null) => {
      if (detach.current) {
        detach.current();
        detach.current = null;
      }
      if (!node) return;
      const wanted = restore.current ? (scrollMemory.get(key) ?? 0) : 0;
      let settling = false;
      let lastSet = -1;
      let stop: (() => void) | null = null;
      const apply = (): boolean => {
        node.scrollTop = wanted;
        lastSet = node.scrollTop;
        return Math.abs(lastSet - wanted) <= 1;
      };
      if (restore.current && wanted > 0 && !apply() && typeof ResizeObserver !== "undefined") {
        settling = true;
        const ro = new ResizeObserver(() => {
          if (apply()) stop?.();
        });
        const watch = (): void => {
          for (const child of node.children) ro.observe(child);
        };
        watch();
        const mo = new MutationObserver(() => {
          watch();
          if (apply()) stop?.();
        });
        mo.observe(node, { childList: true });
        const timer = setTimeout(() => stop?.(), SETTLE_MS);
        stop = () => {
          settling = false;
          ro.disconnect();
          mo.disconnect();
          clearTimeout(timer);
          stop = null;
        };
      }
      const onScroll = (): void => {
        if (settling) {
          if (node.scrollTop === lastSet) return; // our own restore, not a spot to record
          stop?.(); // the user scrolled: their spot wins from here
        }
        scrollMemory.set(key, node.scrollTop);
      };
      node.addEventListener("scroll", onScroll, { passive: true });
      detach.current = () => {
        stop?.();
        node.removeEventListener("scroll", onScroll);
      };
    },
    [key],
  );
}
