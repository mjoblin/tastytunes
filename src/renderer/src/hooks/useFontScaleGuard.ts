/// <reference types="vite/client" />
import { useEffect } from "react";

/**
 * Dev-only tripwire for the one hazard in the per-face optical sizing.
 *
 * `.font-display` carries `zoom: var(--font-display-scale)`, and zoom
 * MULTIPLIES down the tree — so a `.font-display` element inside another
 * silently squares the scale (Unbounded at 0.82 becomes 0.67, and the inner
 * text just looks a bit small rather than obviously broken). Nothing nests
 * today; every display-face site is a leaf. This shouts if that ever stops
 * being true, instead of leaving it to be caught by eye months later.
 *
 * The fix when it fires is `.no-optical` on the inner element (keeps the face,
 * drops the scaling), or hoisting `.font-display` off the wrapper.
 *
 * Keyed on the screen so each one is checked as it's visited; the whole body
 * is dropped from production builds by the DEV constant.
 */
export function useFontScaleGuard(screen: string): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // after paint — the screen's own transitions/portals have landed by then
    const t = setTimeout(() => {
      const nested = document.querySelectorAll(".font-display .font-display");
      if (nested.length > 0) {
        console.error(
          `[tastytunes] ${nested.length} nested .font-display element(s) on "${screen}" — ` +
            "the optical zoom compounds (0.82 × 0.82 = 0.67). Add .no-optical to the inner " +
            "element, or move .font-display off the wrapper.",
          nested,
        );
      }
    }, 250);
    return () => clearTimeout(t);
  }, [screen]);
}
