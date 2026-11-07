/**
 * THE FOCUS RING WAITS FOR THE KEYBOARD (0.11.0, user 2026-10-10: "the accessibility borders
 * often seem to turn on when i don't want them"). Chromium's :focus-visible lights after ANY
 * key, so a clicked chip rang at the next hotkey (space, the arrows, J/K/L) and a menu closed
 * with Escape rang the trigger useDialogFocus handed focus back to. The usual remedy is to
 * track how the person is getting around: Tab or Shift+Tab marks the root
 * `data-keyboard-nav`, a pointer press clears it, and the stylesheet draws the ring (and the
 * `focus-kbd:` variant reveals) only under the mark. Someone navigating by keyboard starts
 * with Tab and keeps every ring; a pointer user sees none. Tab is the only key that
 * marks: the arrows in a menu or a keyed list (0.14.0, hooks/useListKeys) only move within what
 * Tab already reached.
 */
export const KEYBOARD_NAV_ATTR = "data-keyboard-nav";

/**
 * Escape with nothing left to close lets go of the keyboard as a pointer press does
 * (hooks/useShortcuts; his look, 2026-10-30: the ring stayed on a nav item Tab had reached
 * after Escape, and a click took it away). Focus leaves the control, so Space and the arrows are
 * the app's again rather than the hidden control's, and the mark goes. The next Tab carries on
 * from where focus was (Chromium keeps the place), as Escape in a text box already releases it
 * (FilterInput).
 */
export function releaseKeyboard(win: Window = window): void {
  const doc = win.document;
  if (doc.activeElement !== doc.body) (doc.activeElement as HTMLElement | null)?.blur?.();
  doc.documentElement.removeAttribute(KEYBOARD_NAV_ATTR);
}

/** Installs the two listeners on this window; returns their removal. */
export function trackInputModality(win: Window = window): () => void {
  const root = win.document.documentElement;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey)
      root.setAttribute(KEYBOARD_NAV_ATTR, "");
  };
  const onPointer = (): void => root.removeAttribute(KEYBOARD_NAV_ATTR);
  // capture: a handler that stops propagation must not hide the key or the press
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("pointerdown", onPointer, true);
  return () => {
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("pointerdown", onPointer, true);
  };
}
