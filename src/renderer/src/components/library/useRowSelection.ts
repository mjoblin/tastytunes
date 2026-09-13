import { useEffect, useRef, useState } from "react";

// The row-selection grammar every listing surface speaks, in ONE home
// (2026-09-13, step two of the lenses round; the Library's track rows, the
// Albums lens's tiles and the Artists and Tracks lenses' track columns each
// carried a copy): ⌘/Ctrl-click toggles, ⇧-click extends from the anchor row,
// a bare click in selection mode exits it and must not play or open (the
// queue's rule, one grammar), Esc clears, ⌘A gathers the rows shown, a blank
// click on the nav rail or the play bar clears, and when the rows change under
// a selection the picks still shown SURVIVE (the Albums lens's rule, now
// everywhere: a narrowing filter keeps a pick that is still on screen; a new
// listing has no survivors and so clears). Keyed by the caller's row keys —
// the caller renders its rows and its bar.
export function useRowSelection(d: {
  /** The rows shown, in order — the anchor's range, ⌘A's gather and the
   *  survivors all read it (memoize it: the effects key on it). */
  keys: readonly string[];
  /** ⌘A gathers only while this holds (the Library's listing yields to an
   *  open lens, the root and a listing not ready). */
  canSelectAll?: boolean;
}) {
  const { keys, canSelectAll = true } = d;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);

  // the survivors: prune to the rows shown whenever they change
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const keep = new Set(keys);
      const next = new Set([...prev].filter((k) => keep.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [keys]);

  /** True = the click was a selection chord; the caller must not play or open. */
  const rowClick = (key: string, e: React.MouseEvent): boolean => {
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      anchor.current = key;
      return true;
    }
    if (e.shiftKey && anchor.current != null) {
      const a = keys.indexOf(anchor.current);
      const b = keys.indexOf(key);
      if (a >= 0 && b >= 0) {
        setSelected(new Set(keys.slice(Math.min(a, b), Math.max(a, b) + 1)));
        return true;
      }
    }
    // selection mode suspends playback (the queue's rule, one grammar): the
    // first bare click exits the selection, the next plays
    if (selected.size > 0) {
      setSelected(new Set());
      return true;
    }
    return false;
  };

  // The selection's keyboard: ⌘A gathers the rows shown; with a selection,
  // Esc exits. Never in a text box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target;
      if (t instanceof HTMLElement && t.matches("input, textarea, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        if (!canSelectAll || keys.length === 0) return;
        e.preventDefault();
        setSelected(new Set(keys));
        return;
      }
      if (selected.size === 0) return;
      if (e.key === "Escape") setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, canSelectAll, selected.size]);
  // nav-rail and play-bar blank clicks clear too (the queue's rule; top
  // strips are drag-region and never deliver clicks)
  useEffect(() => {
    if (selected.size === 0) return;
    const onWin = (e: MouseEvent): void => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (!t.closest("[data-app-nav], [data-app-playbar]")) return;
      if (t.closest("button, input, a, [aria-valuenow]")) return;
      setSelected(new Set());
    };
    window.addEventListener("click", onWin);
    return () => window.removeEventListener("click", onWin);
  }, [selected.size]);

  return { selected, setSelected, rowClick };
}
