import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * WHERE A MENU OPENS for the event that asked (0.13.0): at the pointer for a click or a
 * right-click, and under the control for a key press (Space or Enter on a ⋯, the context-menu
 * key), which has no pointer: the browser reports 0, 0, and every menu opened in the window's
 * top-left corner once round 4 let the keyboard reach the ⋯ (his try, 2026-10-25, a Queue row's ⋯
 * opened over the sidebar). One home for every menu's anchor, so no caller remembers the rule.
 */
export function menuAt(e: {
  clientX: number;
  clientY: number;
  detail?: number;
  type?: string;
  currentTarget: EventTarget | null;
}): { x: number; y: number } {
  const keyed = (e.type === "click" && e.detail === 0) || (e.clientX === 0 && e.clientY === 0);
  if (keyed && e.currentTarget instanceof Element) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 4 };
  }
  return { x: e.clientX, y: e.clientY };
}

/**
 * A CLICK OR A MENU ASKED FOR FROM THE KEYBOARD (0.14.0, hooks/useListKeys): the event an item's
 * own click or menu handler takes, with no pointer and no chord, so menuAt anchors the menu
 * under the item and a selection grammar reads a plain click. One home, so no list builds its
 * own stand-in.
 */
export function keyedEvent(el: HTMLElement | null): ReactMouseEvent<HTMLElement> {
  const e = {
    type: "click",
    detail: 0,
    clientX: 0,
    clientY: 0,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    currentTarget: el,
    target: el,
    defaultPrevented: false,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
  return e as unknown as ReactMouseEvent<HTMLElement>;
}

/**
 * An item's More menu from the keyboard (K4) through its own right-click: every row and card
 * opens its menu on a right-click (the app-wide rule), so a list whose rows keep their menu to
 * themselves asks that way, and menuAt anchors it under the item.
 */
export function openMenuOn(el: HTMLElement | null): void {
  el?.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }),
  );
}
