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
