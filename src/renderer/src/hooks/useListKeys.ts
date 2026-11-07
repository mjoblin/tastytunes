import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { KEYBOARD_NAV_ATTR } from "@/lib/inputModality";
import { scrollToVisible } from "@/lib/scroll";

/**
 * A LIST FROM THE KEYBOARD (0.14.0, his K1 to K9 on the design page "TastyTunes 0.14.0 Design").
 *
 * K1 one Tab stop per list: the list itself is the stop, its rows and their buttons leave the
 * Tab order (ListKeysContext tells a row's controls they are inside one). K2 a list that has
 * focus FROM THE KEYBOARD takes the arrows it uses: up and down in rows, all four in a card grid;
 * left and right in rows stay the track skips unless the list has a neighbour (the Artists
 * columns). Escape gives the arrows back. A list clicked into never takes them, so the arrows
 * keep the volume and the skips for anyone using a pointer. K3 Enter does what a click does;
 * Space stays play and pause. K4 "." (and the menu key, Shift+F10 on Windows) opens the item's
 * More menu. K5 the app's focus ring, drawn on the item. K6 no type to find: letters stay the
 * app's. K8 Option with up or down moves an item, dropped on Option's release as ONE change.
 * K9 Delete removes the item (or the selection) where the list offers it.
 *
 * THE LIST HOLDS THE FOCUS, NOT THE ROW (aria-activedescendant): the lists are windowed, and a
 * focused row that scrolled out of the window would take the focus with it; the list keeps it
 * and names its current item. The keys are handled on the list and stopped there, so the app's
 * shortcuts (hooks/useShortcuts) never hear a key a list used.
 */

/** Inside a keyed list: a row's own controls stay out of the Tab order (K1). */
export const ListKeysContext = createContext(false);

/** True inside a keyed list, for a row's buttons (tabIndex -1). */
export function useInListKeys(): boolean {
  return useContext(ListKeysContext);
}

export interface ListKeysMove {
  /** Show item `from` at `to` while Option is held (no change sent yet). */
  preview(from: number, to: number): void;
  /** Option let go: the one change. */
  commit(from: number, to: number): void;
  /** Escape while moving: put it back. */
  cancel(): void;
}

/** What a keyed list puts on each item's root (a card's, a row's). */
export interface ListItemAttrs {
  id: string;
  "data-list-item": number;
  "data-list-current": "" | undefined;
}

export interface ListKeysOptions {
  count: number;
  /** A card grid's columns: all four arrows move. Omit for rows; a function is asked at the key
   *  press (a grid that lays itself out with auto-fill). */
  columns?: number | (() => number);
  /** A list whose items aren't one grid or one column (the Library's search results, card rows
   *  between plain rows): the item an arrow, Home or End goes to from `at`, or null to leave the
   *  key to the app. In place of `columns`. */
  step?(key: string, at: number): number | null;
  /** Enter: what a click on the item does. */
  onEnter?(i: number, el: HTMLElement | null): void;
  /** ".", the menu key or Shift+F10: the item's More menu, anchored on it. */
  onMenu?(i: number, el: HTMLElement | null): void;
  /** Option with up or down (K8). */
  move?: ListKeysMove;
  /** Delete (K9): the item, or the selection. */
  onDelete?(i: number): void;
  /** A windowed list: brings item i into the rendered window (scroll it near). */
  reveal?(i: number): void;
  /** Left and right in rows, to a neighbouring list (the Artists columns). */
  onLeft?(): void;
  onRight?(): void;
  /** The item the list starts on when it first takes focus (the playing row, the open one). */
  initial?: () => number;
}

export interface ListKeys {
  /** The current item, -1 before the list is first entered. */
  current: number;
  /** The list has the keyboard: focused from it, not given back with Escape. */
  active: boolean;
  setCurrent(i: number): void;
  /** Focus the list from the keyboard (a neighbour's Right). */
  focus(): void;
  container: {
    ref: (el: HTMLElement | null) => void;
    tabIndex: number;
    role: "group";
    "aria-activedescendant": string | undefined;
    "data-list-keys": "";
    "data-list-active": "" | undefined;
    onKeyDown(e: React.KeyboardEvent): void;
    onKeyUp(e: React.KeyboardEvent): void;
    onFocus(e: React.FocusEvent): void;
    onBlur(e: React.FocusEvent): void;
  };
  /** An item's attributes: its id for the list to name, its index, whether it is current. */
  item(i: number): ListItemAttrs;
}

/** The next index for an arrow, or null when the arrow isn't the list's. */
export function stepFor(
  key: string,
  current: number,
  count: number,
  columns: number | undefined,
): number | null {
  if (count === 0) return null;
  const at = Math.max(0, Math.min(count - 1, current));
  const cols = columns && columns > 1 ? columns : 0;
  switch (key) {
    case "ArrowDown":
      return Math.min(count - 1, at + (cols || 1));
    case "ArrowUp":
      return Math.max(0, at - (cols || 1));
    case "ArrowRight":
      return cols ? Math.min(count - 1, at + 1) : null;
    case "ArrowLeft":
      return cols ? Math.max(0, at - 1) : null;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** The keys that open an item's More menu (K4). */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === "." || e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

export function useListKeys(o: ListKeysOptions): ListKeys {
  const base = useId();
  const [current, setCurrentState] = useState(-1);
  const [active, setActive] = useState(false);
  const el = useRef<HTMLElement | null>(null);
  const opts = useRef(o);
  opts.current = o;
  const cur = useRef(current);
  cur.current = current;
  // an Option move under way: where it started, where it is
  const moving = useRef<{ from: number; to: number } | null>(null);

  const itemEl = (i: number): HTMLElement | null =>
    el.current?.querySelector<HTMLElement>(`[data-list-item="${i}"]`) ?? null;

  // Content between the items is its own (Search's "+3 more" between its sections, an artist's
  // About links under its row in History's Elsewhere): a key there was pressing that button,
  // and taking Enter acted on the list's current item instead (found 2026-10-31), so the list
  // reads only its own focus and its items'
  const inItem = (n: Node | null): boolean => {
    const at = n instanceof Element ? n.closest("[data-list-item]") : null;
    return at != null && el.current?.contains(at) === true;
  };

  const setCurrent = useCallback((i: number) => setCurrentState(i), []);

  // the current item kept in view while the list has the keyboard, its ring clear of the edge; a
  // windowed list renders it first (reveal), then it is nudged in
  useEffect(() => {
    if (!active || current < 0) return;
    const found = itemEl(current);
    if (found) {
      scrollToVisible(found, 6);
      return;
    }
    opts.current.reveal?.(current);
    const raf = requestAnimationFrame(() => scrollToVisible(itemEl(current), 6));
    return () => cancelAnimationFrame(raf);
  }, [active, current]);

  // a shorter list keeps its current item inside it
  useEffect(() => {
    if (current >= o.count) setCurrentState(o.count - 1);
  }, [current, o.count]);

  const engage = (): void => {
    setActive(true);
    if (cur.current < 0 || cur.current >= opts.current.count)
      setCurrentState(Math.max(0, Math.min(opts.current.count - 1, opts.current.initial?.() ?? 0)));
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // a key from inside the list's own DOM (a menu portalled out of it bubbles here through
    // React, and is the menu's), never from a text box
    const t = e.target as HTMLElement;
    if (!el.current?.contains(t) || t.matches("input, textarea, [contenteditable]")) return;
    if (t !== el.current && !inItem(t)) return;
    const { count } = opts.current;
    const columns =
      typeof opts.current.columns === "function" ? opts.current.columns() : opts.current.columns;
    if (!active) {
      // the list was clicked into, or given back with Escape: Tab back to take the keys again
      return;
    }
    const take = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    const at = cur.current < 0 ? 0 : cur.current;
    if (e.key === "Escape") {
      take();
      if (moving.current) {
        moving.current = null;
        opts.current.move?.cancel();
        return;
      }
      setActive(false);
      return;
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const move = opts.current.move;
      if (!move) return;
      take();
      const m = moving.current ?? { from: at, to: at };
      const to = Math.max(0, Math.min(count - 1, m.to + (e.key === "ArrowUp" ? -1 : 1)));
      moving.current = { from: m.from, to };
      move.preview(m.from, to);
      setCurrentState(to);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Enter") {
      if (!opts.current.onEnter || count === 0) return;
      take();
      opts.current.onEnter(at, itemEl(at));
      return;
    }
    if (isMenuKey(e)) {
      if (!opts.current.onMenu || count === 0) return;
      take();
      opts.current.onMenu(at, itemEl(at));
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (!opts.current.onDelete || count === 0) return;
      take();
      opts.current.onDelete(at);
      return;
    }
    if (opts.current.step) {
      const next = opts.current.step(e.key, at);
      if (next == null) return;
      take();
      setCurrentState(next);
      return;
    }
    if (!columns && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const side = e.key === "ArrowLeft" ? opts.current.onLeft : opts.current.onRight;
      if (!side) return;
      take();
      side();
      return;
    }
    const next = stepFor(e.key, at, count, columns);
    if (next == null) return;
    take();
    setCurrentState(next);
  };

  const onKeyUp = (e: React.KeyboardEvent): void => {
    if (e.key !== "Alt" || !moving.current) return;
    const { from, to } = moving.current;
    moving.current = null;
    if (from !== to) opts.current.move?.commit(from, to);
    else opts.current.move?.cancel();
  };

  const onFocus = (e: React.FocusEvent): void => {
    // only the list's own focus from the keyboard engages it (a click on a row focuses the row)
    if (e.target !== e.currentTarget) return;
    if (document.documentElement.hasAttribute(KEYBOARD_NAV_ATTR)) engage();
  };

  const onBlur = (e: React.FocusEvent): void => {
    const next = e.relatedTarget as Node | null;
    // still on the list's own (a row clicked), not the content between its items
    if (next && e.currentTarget.contains(next) && inItem(next)) return;
    setActive(false);
    // Option let go elsewhere: the move still lands as one change
    if (moving.current) {
      const { from, to } = moving.current;
      moving.current = null;
      if (from !== to) opts.current.move?.commit(from, to);
      else opts.current.move?.cancel();
    }
  };

  const focus = useCallback(() => {
    el.current?.focus({ preventScroll: true });
    setActive(true);
    if (cur.current < 0) setCurrentState(Math.max(0, opts.current.initial?.() ?? 0));
  }, []);

  const ref = useCallback((node: HTMLElement | null) => {
    el.current = node;
  }, []);

  return {
    current,
    active,
    setCurrent,
    focus,
    container: {
      ref,
      tabIndex: 0,
      role: "group",
      "aria-activedescendant": active && current >= 0 ? `${base}-${current}` : undefined,
      "data-list-keys": "",
      "data-list-active": active && o.count > 0 ? "" : undefined,
      onKeyDown,
      onKeyUp,
      onFocus,
      onBlur,
    },
    item: (i: number) => ({
      id: `${base}-${i}`,
      "data-list-item": i,
      "data-list-current": i === current ? "" : undefined,
    }),
  };
}

/** How many columns a CSS grid lays out now (an auto-fill grid's, for its arrows). */
export function gridColumnsOf(el: HTMLElement | null): number {
  if (!el) return 1;
  const cols = getComputedStyle(el).gridTemplateColumns;
  return cols && cols !== "none" ? cols.split(" ").filter(Boolean).length : 1;
}
