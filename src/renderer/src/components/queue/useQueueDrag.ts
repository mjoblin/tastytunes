import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { QueueListItem } from "@shared/smoip";
import { favoriteKey, type Favorite } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { toggleFavorite } from "@/lib/favorites";
import { fromQueueItem, refToFavorite } from "@/lib/mediaRef";
import { flashNavTarget, navDropTargetAt } from "@/lib/navDrop";

// The Queue's DRAG AND DROP, lifted out of QueueScreen (2026-09-13, the first
// lift of the screen's hygiene round, the Library's pattern): the batch and
// single drags with the Finder rule at drag start, the insertion line from
// live geometry driven by the pointer, the drag-to-rail handoff, the block
// move with its sequenced device commands and undo, the drop, the cancel and
// the Favorites drop's heart. The screen keeps the rows, the drag overlay and
// the FLIP landing, and takes the state back under the old names.

type Store = ReturnType<typeof useStore.getState>;

export function useQueueDrag(d: {
  /** The visible list (drags only run unfiltered, so this is the whole queue then). */
  items: QueueListItem[];
  allItems: QueueListItem[];
  cards: boolean;
  selected: ReadonlySet<number>;
  setSelected(next: ReadonlySet<number>): void;
  selAnchor: { current: number | null };
  scrollElRef: { current: HTMLDivElement | null };
  /** The screen's: true through a drag and the event that ends it, read by the selection's Escape. */
  dragLiveRef: { current: boolean };
  setQueueItems: Store["setQueueItems"];
  favorites: Store["favorites"];
  setPlaylistBatch(batch: { x: number; y: number; ids?: number[] } | null): void;
  /** Snapshot the rows' rects for the FLIP landing (the screen's). */
  snapQueueRows(): void;
  restoreQueueOrder(prev: number[]): Promise<void>;
}) {
  const {
    items,
    allItems,
    cards,
    selected,
    setSelected,
    selAnchor,
    scrollElRef,
    dragLiveRef,
    setQueueItems,
    favorites,
    setPlaylistBatch,
    snapQueueRows,
    restoreQueueOrder,
  } = d;
  // A drag that starts on a SELECTED row moves the whole selection as a block
  // (the Finder contract — the first thing reached for once selection exists);
  // starting on an unselected row concerns that row alone and drops the
  // selection. Captured at drag start so the drop knows which grammar it is.
  // Drags only run unfiltered, so ids here are in full queue order.
  const [dragBatch, setDragBatch] = useState<{ ids: number[]; active: number } | null>(null);
  /** A single-row drag in flight (grip or body) — tracked so the rail
   *  handoff can freeze the list and put the chip on the cursor. */
  const [dragSingle, setDragSingle] = useState<{ id: number } | null>(null);
  /** The rail target under the pointer mid-drag (drag-to-rail). While set,
   *  the insertion line hides and a single drag hands off to the chip. */
  const [navHover, setNavHover] = useState<ReturnType<typeof navDropTargetAt>>(null);
  const navHoverRef = useRef<ReturnType<typeof navDropTargetAt>>(null);
  const lastPtRef = useRef<{ x: number; y: number } | null>(null);
  /** Pointer anywhere over the rail: the line hides and a release without a
   *  real target does NOTHING — no line, no move (the line-is-the-promise
   *  rule; user, 2026-08-30: releasing on Radio performed the queue move). */
  const overRailRef = useRef(false);
  /** The pointer while over the rail — anchors the cursor-fixed ghost. */
  const [railPt, setRailPt] = useState<{ x: number; y: number } | null>(null);
  // THE INSERTION-LINE MODEL for batch drags (the Spotify/Music/Finder
  // contract, chosen with the user 2026-08-27 after the lift felt
  // unpredictable with gapped selections): the rows hold still — no lift,
  // no make-room — a stacked chip rides the cursor via DragOverlay, and a
  // gold line between rows is the one truth about where the block lands.
  // Single-row drags keep the make-room feel the app has always had.
  const [insertAt, setInsertAt] = useState<{ id: number; after: boolean } | null>(null);
  const insertRef = useRef<typeof insertAt>(null);
  const updateInsert = useCallback((v: { id: number; after: boolean } | null): void => {
    insertRef.current = v;
    setInsertAt((prev) => (prev?.id === v?.id && prev?.after === v?.after ? prev : v));
  }, []);
  // The line is computed from LIVE geometry, never from dnd-kit's cached
  // collision rects: row bands are measured once at drag start in
  // scroll-content coordinates (the rows are planted, so they stay true for
  // the whole drag), the overlay's centre is re-read on every move AND every
  // scroll (auto-scroll moves the list under a stationary pointer), and the
  // drop re-derives the line at the instant of release — so the landing IS
  // the line, by construction (the first cut trusted over.rect and landed
  // wrong after scrolls and over members; user, 2026-08-27).
  const dragGeom = useRef<{
    bands: Array<{ id: number; x: number; y: number; w: number; h: number }>;
    scrollerTop: number;
    scrollerLeft: number;
    lastX: number | null;
    lastY: number | null;
    /** a real pointermove was seen — the delta fallback must stay out */
    pointerSeen: boolean;
  } | null>(null);
  // The POINTER drives the line, not the drag chip: the chip is a 320px card
  // anchored at the grab point, so its centre can sit far from the cursor
  // (in the card grid it pushed the line a half-card right — user,
  // 2026-08-28). Start position + dnd-kit's delta = the live pointer.
  const dragStartPt = useRef<{ x: number; y: number } | null>(null);
  // nearest NON-member band to the pointer, in scroll-content coordinates;
  // the edge follows reading order (beyond a band's row decides vertically;
  // within one, the card grid decides horizontally and list rows vertically)
  const computeInsert = useCallback(
    (
      px: number | null,
      py: number | null,
      grid: boolean,
    ): { id: number; after: boolean } | null => {
      const g = dragGeom.current;
      const sc = scrollElRef.current;
      if (g == null || sc == null || px == null || py == null || g.bands.length === 0) return null;
      const x = px - g.scrollerLeft + sc.scrollLeft;
      const y = py - g.scrollerTop + sc.scrollTop;
      let best = g.bands[0];
      let bd = Infinity;
      for (const b of g.bands) {
        const d = (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      const dy = y - best.y;
      const dx = x - best.x;
      const after = Math.abs(dy) > best.h / 2 ? dy > 0 : grid ? dx > 0 : dy > 0;
      return { id: best.id, after };
    },
    [scrollElRef],
  );
  const onDragStart = (event: DragStartEvent): void => {
    dragLiveRef.current = true;
    useStore.getState().setNavDragActive(true);
    updateInsert(null);
    dragGeom.current = null;
    const ae = event.activatorEvent;
    dragStartPt.current = ae instanceof MouseEvent ? { x: ae.clientX, y: ae.clientY } : null;
    const id = event.active.id as number;
    // THE FLUENT GESTURE (live-reproduced, user 2026-08-28): the last ⌘-click
    // often flows straight into the drag, and selection lands on mouse-UP —
    // which the drag swallows — so at drag start the pressed row is not yet
    // selected. A held chord on an unselected row therefore means "this one
    // too", never "drop everything": the row is ADOPTED into the selection
    // and the batch drags. A plain body-press on an unselected row keeps the
    // Finder rule (drop the selection, drag that row alone).
    const chord = ae instanceof MouseEvent && (ae.metaKey || ae.ctrlKey || ae.shiftKey);
    const adopt = chord && selected.size > 0 && !selected.has(id);
    if ((selected.has(id) && selected.size > 1) || adopt) {
      const sel = adopt ? new Set([...selected, id]) : selected;
      if (adopt) {
        setSelected(sel);
        selAnchor.current = items.findIndex((it) => it.id === id);
      }
      const ids = items.flatMap((it) => (it.id != null && sel.has(it.id) ? [it.id] : []));
      setDragBatch({ ids, active: id });
      const sc = scrollElRef.current;
      if (sc) {
        const scRect = sc.getBoundingClientRect();
        const bset = new Set(ids);
        const bands: Array<{ id: number; x: number; y: number; w: number; h: number }> = [];
        sc.querySelectorAll<HTMLElement>("[data-queue-id]").forEach((el) => {
          const bandId = Number(el.dataset.queueId);
          if (bset.has(bandId)) return;
          const r = el.getBoundingClientRect();
          bands.push({
            id: bandId,
            x: r.left + r.width / 2 - scRect.left + sc.scrollLeft,
            y: r.top + r.height / 2 - scRect.top + sc.scrollTop,
            w: r.width,
            h: r.height,
          });
        });
        dragGeom.current = {
          bands,
          scrollerTop: scRect.top,
          scrollerLeft: scRect.left,
          lastX: dragStartPt.current?.x ?? null,
          lastY: dragStartPt.current?.y ?? null,
          pointerSeen: false,
        };
      }
    } else {
      // a chord-held drag never destroys a selection it did not consume —
      // and neither does dragging the ONE selected row (a selection survives
      // its own drop, single like plural); clearing is for a bare press on
      // an UNSELECTED row, the Finder rule
      if (selected.size > 0 && !chord && !selected.has(id)) setSelected(new Set());
      setDragBatch(null);
      setDragSingle({ id });
    }
  };
  // The REAL pointer drives the line (a window pointermove listener while a
  // batch drag runs — see the effect below): dnd-kit's delta compensates for
  // container scroll, so start+delta drifts from the cursor by the
  // auto-scrolled distance and pinned the line to the list top after an
  // auto-scroll up (user, 2026-08-28). onDragMove remains only as the
  // keyboard-sensor fallback, where the moving overlay IS the position.
  const onDragMove = (event: DragMoveEvent): void => {
    if (!dragBatch) return;
    const g = dragGeom.current;
    if (!g || g.pointerSeen) return;
    const a = event.active.rect.current.translated;
    if (!a) return;
    const px = a.left + a.width / 2;
    const py = a.top + a.height / 2;
    g.lastX = px;
    g.lastY = py;
    updateInsert(computeInsert(px, py, cards));
  };
  // Auto-scroll moves the rows' viewport positions while the pointer (and so
  // dnd-kit's move events) can stay still — the line follows the scroll too.
  useEffect(() => {
    if (!dragBatch && !dragSingle) return;
    const sc = scrollElRef.current;
    if (!sc) return;
    const onPointerMove = (e: PointerEvent): void => {
      lastPtRef.current = { x: e.clientX, y: e.clientY };
      // drag-to-rail: the rail target under the pointer, batch or single.
      // Over a target the insertion line hides — the drop leaves the list.
      const nav = navDropTargetAt(e.clientX, e.clientY, ["playlists", "favorites"]);
      const railRect = document.querySelector("[data-app-nav]")?.getBoundingClientRect();
      overRailRef.current =
        railRect != null &&
        e.clientX >= railRect.left &&
        e.clientX <= railRect.right &&
        e.clientY >= railRect.top &&
        e.clientY <= railRect.bottom;
      if (nav !== navHoverRef.current) {
        navHoverRef.current = nav;
        setNavHover(nav);
        useStore.getState().setNavDropTarget(nav);
      }
      if (nav != null) setRailPt({ x: e.clientX, y: e.clientY });
      const g = dragGeom.current;
      if (!g) return;
      g.pointerSeen = true;
      g.lastX = e.clientX;
      g.lastY = e.clientY;
      updateInsert(overRailRef.current ? null : computeInsert(e.clientX, e.clientY, cards));
    };
    const onScroll = (): void => {
      const g = dragGeom.current;
      if (g?.lastX != null && !overRailRef.current)
        updateInsert(computeInsert(g.lastX, g.lastY, cards));
    };
    window.addEventListener("pointermove", onPointerMove);
    sc.addEventListener("scroll", onScroll);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      sc.removeEventListener("scroll", onScroll);
    };
  }, [dragBatch, dragSingle, cards, computeInsert, updateInsert, scrollElRef]);

  /** Move the BLOCK to `at` (its index in the queue WITHOUT the block):
   *  optimistic locally, then ONE device command per member — each step
   *  simulated with the firmware's remove-then-insert semantics and anchored
   *  to live neighbor identity. The old whole-queue diff emitted up to N
   *  moves (22 for a 3-track move-to-bottom of 25) and long command runs
   *  scrambled on the real streamer; the mock swallowed them, which is why
   *  the suite stayed green (user, 2026-08-28). */
  const applyBlockMove = (blockIds: number[], at: number, undoLabel: string): boolean => {
    const byId = new Map(allItems.map((it) => [it.id as number, it]));
    const order = allItems.map((it) => it.id as number);
    const bset = new Set(blockIds);
    const rest = order.filter((id) => !bset.has(id));
    const final = [...rest.slice(0, at), ...blockIds, ...rest.slice(at)];
    if (final.join() === order.join()) return false;
    snapQueueRows();
    setQueueItems(final.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
    const work = [...order];
    const moves: Array<{ id: number; from: number; to: number }> = [];
    for (let k = 0; k < blockIds.length; k++) {
      const id = blockIds[k];
      const from = work.indexOf(id);
      work.splice(from, 1);
      const to =
        k === 0
          ? at === 0
            ? 0
            : work.indexOf(rest[at - 1]) + 1
          : work.indexOf(blockIds[k - 1]) + 1;
      work.splice(to, 0, id);
      if (from !== to) moves.push({ id, from, to });
    }
    // SEQUENCED, never parallel: each move's positions assume the one before
    // it has already applied, and the renderer's unawaited commands become
    // concurrent HTTP posts in main — the device can apply them out of order
    // and split the block (live-observed on a gapped drop into the block's
    // own span; user, 2026-08-28)
    void (async () => {
      for (const m of moves)
        await tt.command({ type: "queueMove", id: m.id, from: m.from, to: m.to });
    })();
    useStore.getState().pushUndo(undoLabel, () => restoreQueueOrder(order));
    return true;
  };

  const onDragEnd = (event: DragEndEvent): void => {
    const batch = dragBatch;
    const single = dragSingle;
    const nav = navHoverRef.current;
    const overRail = overRailRef.current;
    const releasePt = lastPtRef.current;
    useStore.getState().setNavDragActive(false);
    overRailRef.current = false;
    setTimeout(() => {
      dragLiveRef.current = false;
    }, 0);
    // the line one final time, from the release position itself — never a
    // stale earlier value, on either layout
    const gEnd = dragGeom.current;
    const ins = computeInsert(gEnd?.lastX ?? null, gEnd?.lastY ?? null, cards) ?? insertRef.current;
    setDragBatch(null);
    setDragSingle(null);
    dragGeom.current = null;
    dragStartPt.current = null;
    navHoverRef.current = null;
    setNavHover(null);
    setRailPt(null);
    useStore.getState().setNavDropTarget(null);
    updateInsert(null);
    // Released on the rail: the drop leaves the list — route it and never
    // reorder. The release point decides, single and batch alike.
    if (nav != null) {
      const ids = batch ? batch.ids : single ? [single.id] : [];
      if (ids.length === 0) return;
      if (nav === "favorites") {
        heartQueueIds(ids);
        flashNavTarget("favorites");
      } else if (nav === "playlists") {
        setPlaylistBatch({
          x: releasePt?.x ?? window.innerWidth / 2,
          y: releasePt?.y ?? window.innerHeight / 2,
          ids,
        });
      }
      return;
    }
    // Released over the rail but not on a target: the line was hidden, so
    // nothing was promised — the drop is inert.
    if (overRail) return;
    const { active, over } = event;
    if (batch && batch.ids.length > 1) {
      // The block gathers AT THE LINE, in queue order — the line was the
      // whole promise, so the drop reads it and nothing else (a release
      // past the list edge or over the floating bar still lands: the line
      // was visible, dnd-kit's over is irrelevant).
      if (!ins) return;
      const bset = new Set(batch.ids);
      const rest = items.flatMap((it) => (it.id != null && !bset.has(it.id) ? [it.id] : []));
      const k = rest.indexOf(ins.id);
      if (k < 0) return;
      applyBlockMove(batch.ids, k + (ins.after ? 1 : 0), `Move ${batch.ids.length} Tracks`);
      return;
    }
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const from = items[oldIndex].position ?? oldIndex;
    const to = items[newIndex].position ?? newIndex;
    const prevOrder = allItems.flatMap((i) => (i.id != null ? [i.id] : []));
    // Optimistic reorder; the streamer re-announces the authoritative queue.
    setQueueItems(arrayMove(items, oldIndex, newIndex));
    void tt.command({ type: "queueMove", id: active.id as number, from, to });
    const movedTitle = items[oldIndex].metadata?.title;
    useStore
      .getState()
      .pushUndo(movedTitle ? `Move “${movedTitle}”` : "Move Track", () =>
        restoreQueueOrder(prevOrder),
      );
  };

  /** A rail drop on Favorites: ADD what's missing, never remove (a drop is
   *  additive intent, unlike the toggle verb), as ONE aggregate undo entry. */
  const heartQueueIds = (ids: number[]): void => {
    const idSet = new Set(ids);
    const favs = allItems.flatMap((it) => {
      if (it.id == null || !idSet.has(it.id)) return [];
      const ref = fromQueueItem(it);
      const fav = ref ? refToFavorite(ref) : null;
      return fav ? [fav] : [];
    });
    const missing = favs.filter(
      (f) => !favorites.some((x) => favoriteKey(x) === favoriteKey(f as Favorite)),
    );
    for (const f of missing) void toggleFavorite(f, { silent: true });
    if (missing.length === 0) return;
    const n = missing.length;
    useStore.getState().pushUndo(`Add ${n} ${n === 1 ? "Track" : "Tracks"} to Favorites`, () => {
      for (const f of missing) void toggleFavorite(f, { silent: true });
    });
  };

  const onDragCancel = (): void => {
    setDragBatch(null);
    setDragSingle(null);
    dragGeom.current = null;
    dragStartPt.current = null;
    navHoverRef.current = null;
    setNavHover(null);
    setRailPt(null);
    overRailRef.current = false;
    setTimeout(() => {
      dragLiveRef.current = false;
    }, 0);
    useStore.getState().setNavDropTarget(null);
    useStore.getState().setNavDragActive(false);
    updateInsert(null);
    // An Esc-cancelled drag ends with the button still held, and the
    // eventual RELEASE lands as a row click — which plays a track, or
    // exits selection mode via the bare-click rule (user: Esc then
    // release deselected). The abort's release is exactly the next
    // pointerup, whenever it comes: swallow the click that follows
    // it, and only that one.
    const swallow = (ce: MouseEvent): void => {
      ce.stopPropagation();
      ce.preventDefault();
    };
    const onAbortRelease = (): void => {
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 200);
    };
    window.addEventListener("pointerup", onAbortRelease, { capture: true, once: true });
  };

  return {
    dragBatch,
    dragSingle,
    navHover,
    railPt,
    insertAt,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
    applyBlockMove,
  };
}
