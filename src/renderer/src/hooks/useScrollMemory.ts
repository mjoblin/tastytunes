import { useCallback, useRef } from "react";

// Session-scoped scroll positions per screen. Screens unmount when you switch
// pages, so their scrollTop is remembered here and restored on return.
const scrollMemory = new Map<string, number>();

/**
 * Attach to a scrollable container: `<div ref={useScrollMemory('queue')}>`.
 * Restores the remembered position on mount (unless `restoreOnMount` is false —
 * e.g. the queue when follow-current is on, which does its own scrolling) and
 * records the position as the user scrolls.
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
      if (restore.current) node.scrollTop = scrollMemory.get(key) ?? 0;
      const onScroll = (): void => {
        scrollMemory.set(key, node.scrollTop);
      };
      node.addEventListener("scroll", onScroll, { passive: true });
      detach.current = () => node.removeEventListener("scroll", onScroll);
    },
    [key],
  );
}
