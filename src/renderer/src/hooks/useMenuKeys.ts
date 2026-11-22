import { useEffect, type RefObject } from "react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { holdKeyboard } from "@/lib/keyboardOwner";

/**
 * A MENU'S KEYBOARD, ONE HOME (0.16.0-rc.8: the facet pickers and the sort list were built beside
 * the ⋯ menus and had none of it, so with a picker open the arrows changed the volume behind it).
 * While a menu is open, focus is in it and goes back where it was when it closes (useDialogFocus),
 * and nothing behind it hears a key (keyboardOwner). Its surface takes tabIndex -1 and passes
 * moveAmongItems as its onKeyDown, so the arrows move between its items.
 */
export function useMenuKeys(open: boolean, ref: RefObject<HTMLElement | null>): void {
  useDialogFocus(open, ref);
  useEffect(() => (open ? holdKeyboard() : undefined), [open]);
}

/** Up and down (Home, End) through a menu's enabled buttons, round at the ends. The first arrow
 *  from the menu itself lands on its current choice (aria-current) where it has one, so a long
 *  list opens where its choice is. A text box or a slider inside keeps its own arrows. */
export function moveAmongItems(e: React.KeyboardEvent<HTMLElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  if ((e.target as HTMLElement).matches('input, textarea, [contenteditable], [role="slider"]'))
    return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])")].filter(
    (b) => b.offsetParent !== null,
  );
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const current = items.findIndex((b) => b.getAttribute("aria-current") === "true");
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? items.length - 1
        : at < 0 && current >= 0
          ? current
          : e.key === "ArrowDown"
            ? (at + 1) % items.length
            : at <= 0
              ? items.length - 1
              : at - 1;
  items[next].focus();
}
