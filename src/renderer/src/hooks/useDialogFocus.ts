import { useEffect, type RefObject } from "react";

/**
 * FOCUS FOR THE OVERLAY SHELLS (0.10.0, the accessibility floor). While a modal or a popover
 * is open, keyboard focus is in it: it moves to the surface on open (the surface itself, not
 * its first control, so a click never lands a ring and a text box that focuses itself keeps
 * doing so), and goes back to where it was on close, but only when nothing else has taken it
 * meanwhile (a menu's Rename focuses its field and must keep it). A modal also keeps Tab
 * inside itself; a popover lets Tab leave, as a menu does.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogFocus(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  { trap = false }: { trap?: boolean } = {},
): void {
  useEffect(() => {
    if (!open) return;
    const surface = ref.current;
    if (!surface) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // a control inside that took focus on mount (a text box) keeps it
    if (!surface.contains(document.activeElement)) surface.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent): void => {
      if (!trap || e.key !== "Tab") return;
      const items = [...surface.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === firstItem || at === surface)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && at === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const now = document.activeElement;
      const lost = now == null || now === document.body || surface.contains(now);
      if (lost && before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [open, ref, trap]);
}
