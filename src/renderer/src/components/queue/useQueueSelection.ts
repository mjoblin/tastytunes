import { useCallback, useEffect, useMemo } from "react";
import { useRowSelection } from "@/components/library/useRowSelection";
import type { QueueListItem } from "@shared/smoip";
import { favoriteKey, type ContentRef, type Favorite } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { toggleFavorite } from "@/lib/favorites";
import { fromQueueItem, refToFavorite } from "@/lib/mediaRef";

// The Queue's SELECTION, lifted out of QueueScreen (2026-09-13, the second lift
// of the screen's hygiene round): the multi-select over the visible rows —
// the Finder chords, the bare-click rule, the pruning as the queue changes,
// ⌘A, Escape and the blank-click clearing are the one row grammar in
// useRowSelection (folded onto it the same evening, over the queue ids) —
// plus what is the Queue's own: the album header's chord, Delete as Remove
// with its one undo, the batch heart, and the bar's block moves. The screen
// keeps the rows and the bar and takes the state back under the old names;
// the block move belongs to the drag hook and reaches the selection late-bound.

/** What the selection reads that the screen declares after it (the drag hook's block move). */
export interface SelectionLate {
  applyBlockMove(blockIds: number[], at: number, undoLabel: string): boolean;
}

type Store = ReturnType<typeof useStore.getState>;

export function useQueueSelection(d: {
  /** The visible rows (a filter narrows them). */
  items: QueueListItem[];
  allItems: QueueListItem[];
  favorites: Store["favorites"];
  scrollElRef: { current: HTMLDivElement | null };
  /** The drag hook's live flag: an Escape that cancels a drag must not also clear the selection. */
  dragLiveRef: { current: boolean };
  snapQueueRows(): void;
  restoreToQueue(ref: ContentRef, position: number): Promise<void>;
  late: { current: SelectionLate };
}) {
  const {
    items,
    allItems,
    favorites,
    scrollElRef,
    dragLiveRef,
    snapQueueRows,
    restoreToQueue,
    late,
  } = d;
  // the row grammar over the visible queue ids (a row without an id is not a
  // row you can pick); the drag's live flag holds Escape for the drag
  const keys = useMemo(() => items.flatMap((it) => (it.id != null ? [it.id] : [])), [items]);
  const {
    selected,
    setSelected,
    rowClick: keyClick,
    anchor: selAnchor,
  } = useRowSelection<number>({ keys, holdEscape: dragLiveRef });
  /** True = the click was a selection chord; the caller must not play. */
  const rowClick = (item: QueueListItem, e: React.MouseEvent): boolean =>
    item.id == null ? false : keyClick(item.id, e);
  /** ⌘-click on an album header toggles its whole run. */
  const groupModClick = (ids: number[], e: React.MouseEvent): boolean => {
    if (!(e.metaKey || e.ctrlKey)) {
      // a bare header click in selection mode exits it too (jump suspended)
      if (selected.size > 0) {
        setSelected(new Set());
        return true;
      }
      return false;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = ids.every((id) => next.has(id));
      for (const id of ids) if (allIn) next.delete(id);
      if (!allIn) for (const id of ids) next.add(id);
      return next;
    });
    return true;
  };
  const removeSelected = useCallback((): void => {
    const chosen = items.filter((it) => it.id != null && selected.has(it.id));
    const saved = chosen.flatMap((i) => {
      const title = i.metadata?.title;
      return title
        ? [
            {
              content: {
                title,
                artist: i.metadata?.artist ?? null,
                album: i.metadata?.album ?? null,
              },
              position: i.position ?? 0,
            },
          ]
        : [];
    });
    snapQueueRows();
    for (const i of chosen) void tt.command({ type: "queueDelete", id: i.id as number });
    setSelected(new Set());
    // ONE closure, two entry points (the toast button and Cmd-Z consume the
    // same stack entry, so they can never double-restore). Sequential,
    // ascending positions — parallel restores raced each other's inserts
    // and resolves; each restore arms the FLIP so neighbors part with
    // motion (user, 2026-08-28).
    const undoId = useStore.getState().pushUndo(`Remove ${chosen.length} Tracks`, async () => {
      for (const s of saved) {
        snapQueueRows();
        await restoreToQueue(s.content, s.position);
      }
    });
    useStore.getState().showToast({
      kind: "success",
      text: `Removed ${chosen.length} tracks`,
      action: { label: "Undo", undo: () => useStore.getState().runUndo(undoId) },
    });
    // the two helpers are the screen's module functions, stable, named for the linter
  }, [items, selected, setSelected, restoreToQueue, snapQueueRows]);
  // Delete/Backspace is Remove from queue while a selection stands — the
  // Finder/Spotify key (⌘A and Escape are the grammar's, in useRowSelection).
  // Never inside a text box.
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target;
      if (t instanceof HTMLElement && t.matches("input, textarea, [contenteditable]")) return;
      if (e.key === "Delete" || e.key === "Backspace") removeSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size, removeSelected]);

  // The selection's favorites as ONE verb with the album-header rule: adds
  // what's missing, and only reads "Remove" when every member is already
  // there. The hearts light up on the rows themselves, so no toast.
  const selFavs = items.flatMap((it) => {
    if (it.id == null || !selected.has(it.id)) return [];
    const ref = fromQueueItem(it);
    const fav = ref ? refToFavorite(ref) : null;
    return fav ? [fav] : [];
  });
  const selAllHearted =
    selFavs.length > 0 &&
    selFavs.every((f) => favorites.some((x) => favoriteKey(x) === favoriteKey(f as Favorite)));
  const heartSelected = (): void => {
    const touched = selFavs.filter((f) => {
      const has = favorites.some((x) => favoriteKey(x) === favoriteKey(f as Favorite));
      return selAllHearted ? has : !has;
    });
    for (const f of touched) void toggleFavorite(f, { silent: true });
    if (touched.length === 0) return;
    // One aggregate undo entry for the batch (per-item pushes would flood
    // the stack with entries no one asked for).
    const n = touched.length;
    useStore
      .getState()
      .pushUndo(
        selAllHearted
          ? `Remove ${n} ${n === 1 ? "Track" : "Tracks"} from Favorites`
          : `Add ${n} ${n === 1 ? "Track" : "Tracks"} to Favorites`,
        () => {
          for (const f of touched) void toggleFavorite(f, { silent: true });
        },
      );
  };

  /** The bar's block moves — unambiguous even under a filter (the visible
   *  selection goes to the very top or bottom of the FULL queue, keeping its
   *  relative order), so unlike drags these stay live while filtering. */
  const moveSelected = (where: "top" | "bottom"): void => {
    const ids = items.flatMap((it) => (it.id != null && selected.has(it.id) ? [it.id] : []));
    if (ids.length === 0) return;
    if (
      !late.current.applyBlockMove(
        ids,
        where === "top" ? 0 : allItems.length - ids.length,
        `Move ${ids.length} ${ids.length === 1 ? "Track" : "Tracks"} to ${where === "top" ? "Top" : "Bottom"}`,
      )
    )
      return;
    // the landing must be SEEN: follow the block to its end of the list, or
    // "Move to bottom" reads as nothing happening (user, 2026-08-28). An
    // INSTANT jump — a smooth scroll dies with the reorder's re-render —
    // and the FLIP supplies the motion: the rows fly in from off-screen
    // (under reduced motion both are skipped and it is a clean jump).
    const sc = scrollElRef.current;
    if (sc) sc.scrollTo({ top: where === "top" ? 0 : sc.scrollHeight });
  };

  return {
    selected,
    setSelected,
    selAnchor,
    rowClick,
    groupModClick,
    removeSelected,
    selFavs,
    selAllHearted,
    heartSelected,
    moveSelected,
  };
}
