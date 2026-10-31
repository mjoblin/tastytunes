import { useCallback, useEffect, useRef, useState } from "react";

/** How many cards a row holds: the count `repeat(auto-fill, …)` fits, from the
 *  width the grid actually has — its own box, since the room a hovered card
 *  needs sits on the SCROLLPORT. Re-read on resize, so the cut holds at any width.
 *  A CALLBACK REF, not an effect over a ref: on a first visit every section
 *  mounts empty, before the record has loaded, so an effect that looked for the
 *  grid once found nothing and the count stayed at one — a section then showed
 *  two albums side by side and offered the rest as "more" (user, 2026-09-11:
 *  "why did I have to click that? there was already room to show those"). The
 *  ref runs whenever the grid comes or goes, so a grid that arrives with the
 *  data is measured the moment it exists. (History's Rediscover shelves, moved here
 *  in 0.13.0 when the Library's Recently added shelf became its second reader.) */
export function useColumns(
  cardSize: number,
  gap: number,
): [attach: (node: HTMLElement | null) => void, columns: number] {
  const [cols, setCols] = useState(1);
  const obs = useRef<ResizeObserver | null>(null);
  const attach = useCallback(
    (node: HTMLElement | null): void => {
      obs.current?.disconnect();
      obs.current = null;
      if (!node) return;
      const read = (w: number): void =>
        setCols(Math.max(1, Math.floor((w + gap) / (cardSize + gap))));
      read(node.clientWidth);
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) read(e.contentRect.width);
      });
      ro.observe(node);
      obs.current = ro;
    },
    [cardSize, gap],
  );
  useEffect(() => () => obs.current?.disconnect(), []);
  return [attach, cols];
}
