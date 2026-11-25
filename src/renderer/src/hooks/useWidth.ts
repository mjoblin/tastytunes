import { useCallback, useEffect, useRef, useState } from "react";

/**
 * An element's width as it changes, by a callback ref (useColumns' pattern: measured the moment
 * the element exists, re-read on every resize). Infinity until it is measured, so a layout that
 * narrows below some width starts wide.
 */
export function useWidth(): [attach: (node: HTMLElement | null) => void, width: number] {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  const obs = useRef<ResizeObserver | null>(null);
  const attach = useCallback((node: HTMLElement | null): void => {
    obs.current?.disconnect();
    obs.current = null;
    if (!node) return;
    setWidth(node.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(node);
    obs.current = ro;
  }, []);
  useEffect(() => () => obs.current?.disconnect(), []);
  return [attach, width];
}
