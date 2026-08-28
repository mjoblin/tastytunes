import { useEffect, useRef, useState } from "react";
import { useQueuePerformer } from "@/hooks/useQueuePerformer";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BookmarkPlus,
  Crosshair,
  Disc3,
  Footprints,
  LayoutGrid,
  ListMusic,
  ListOrdered,
  ListX,
  MoreHorizontal,
  Play,
  Rows3,
  X,
} from "lucide-react";
import { queueContentHash, type QueueListItem } from "@shared/smoip";
import { presetVolumeKey, type QueueLayout } from "@shared/model";
import {
  favoriteKey,
  type ContentRef,
  type Favorite,
  type QueueRestoreResult,
} from "@shared/model";
import { tt } from "@/api";
import { useConfirmPopover } from "@/components/chrome/Confirm";
import { useStore } from "@/store";
import { Eqbars } from "@/components/media/Eqbars";
import { EmptyState } from "@/components/chrome/EmptyState";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { flashTarget, scrollToWithContext } from "@/lib/scroll";
import { lockVertical } from "@/lib/dnd";
import { activeSourceId, cx, fmtTime, matchesFilter } from "@/lib/format";
import { toggleFavorite } from "@/lib/favorites";
import { fromQueueItem, refToFavorite, refToPlaylistItem } from "@/lib/mediaRef";
import { saveRefToPreset, openRefInLibrary } from "@/lib/mediaActions";
import { trackMenuItems, type MediaMenuItem } from "@/lib/mediaMenus";
import { AddToPlaylistPanel } from "@/components/overlays/AddToPlaylistPanel";
import { RowMenu } from "@/components/media/RowMenu";
import { RowAction } from "@/components/media/RowAction";
import { RowHeart } from "@/components/media/RowHeart";
import { OrderHandle } from "@/components/controls/OrderHandle";
import { ArtImage } from "@/components/media/ArtImage";
import { MediaArt } from "@/components/media/MediaArt";
import { DurationCell } from "@/components/media/DurationCell";
import { FilterInput } from "@/components/controls/FilterInput";
import { ModalShell } from "@/components/chrome/Overlay";
import { PresetSavePanel, PresetPicker } from "@/components/library/LibraryMenus";
import { HeaderChip, ScreenTitle } from "@/components/chrome/Chrome";
import { artUrlAt } from "@shared/artUrl";

/**
 * Queue → preset: the shared PresetSavePanel in a centered modal. The device
 * stores the whole queue as a MediaQueue preset (recallable anywhere); we also
 * record its exact track signature so the Presets screen can recognize it.
 */
function SaveQueueDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose(): void;
}): React.JSX.Element | null {
  const trackCount = useStore((s) => s.queue?.items?.length ?? 0);
  const showToast = useStore((s) => s.showToast);

  const saveSettings = useStore((s) => s.saveSettings);

  const onSave = async (slot: number, name: string | null): Promise<void> => {
    // throws on failure (already toasted by the api layer) → panel stays open
    await tt.command({ type: "queueSavePreset", slot, name });
    // Remember exactly what this slot holds (all tracks, in order) so the
    // Presets screen recognizes this queue coming back from any controller.
    const { queue, systemInfo, settings } = useStore.getState();
    if (queue?.items?.length) {
      void saveSettings({
        queueSignatures: {
          ...settings.queueSignatures,
          [presetVolumeKey(systemInfo?.udn, slot)]: queueContentHash(queue.items),
        },
      });
    }
    showToast({
      kind: "success",
      text: `Saved “${name ?? `Queue Preset ${slot}`}” to preset ${slot}`,
      action: { label: "View", screen: "presets" },
    });
    onClose();
  };

  return (
    <ModalShell open={open} onClose={onClose} escapeCloses className="w-[360px] p-5">
      <div className="font-display font-bold text-[17px] tracking-tight mb-3">
        Save queue as preset
      </div>
      <PresetSavePanel
        title="Current queue"
        subtitle={`${trackCount} tracks — stored on the streamer`}
        nameAutoFocus
        onSave={onSave}
      />
    </ModalShell>
  );
}

export function QueueScreen(): React.JSX.Element {
  const queue = useStore((s) => s.queue);
  const saveSettings = useStore((s) => s.saveSettings);
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const zoneState = useStore((s) => s.zoneState);
  const { followQueue, queueLayout, presetCardSize, presetGap, presetFillRows } = useStore(
    (s) => s.settings,
  );
  const setQueueItems = useStore((s) => s.setQueueItems);
  const filter = useStore((s) => s.screenFilters.queue);
  const setScreenFilter = useStore((s) => s.setScreenFilter);
  const cards = queueLayout === "cards";
  const albums = queueLayout === "albums";
  const [saveOpen, setSaveOpen] = useState(false);
  const clearConfirm = useConfirmPopover();
  // Follow-current does its own scrolling on entry; otherwise restore the
  // previous position.
  const scrollRef = useScrollMemory("queue", !followQueue);

  const setFollowQueue = async (follow: boolean): Promise<void> => {
    await saveSettings({ followQueue: follow });
  };
  const setLayout = async (queueLayout: QueueLayout): Promise<void> => {
    await saveSettings({ queueLayout });
  };
  // Cards get half a card of context above the target; rows get a full row.
  const scrollToCurrent = (): void => {
    scrollToWithContext(currentRef.current, cards ? presetGap : 8, cards ? 0.5 : 1);
    flashTarget(currentRef.current);
  };

  const showToast = useStore((s) => s.showToast);
  // Right-click rather than a third hover button: the row already carries
  // remove and a grip, and Favorites established right-click for exactly this
  // (a local list of tracks whose rows are already busy).
  // Multi-select (2026-08-24): ⌘/Ctrl-click toggles, ⇧-click extends from the
  // anchor, a bare click clears and PLAYS as it always has, Esc clears. Held
  // as ids so it survives reorders; pruned when entries leave the queue.
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const selAnchor = useRef<number | null>(null);
  const [rowMenu, setRowMenu] = useState<{ item: QueueListItem; x: number; y: number } | null>(
    null,
  );
  const [playlistFor, setPlaylistFor] = useState<{
    item: QueueListItem;
    x: number;
    y: number;
  } | null>(null);
  const [presetFor, setPresetFor] = useState<{ item: QueueListItem; x: number; y: number } | null>(
    null,
  );
  /** The selection bar's Add to playlist… — the same batch-shaped panel the
   *  Library bar uses (its New playlist… path is how a selection becomes a
   *  stored playlist of its own). */
  const [playlistBatch, setPlaylistBatch] = useState<{ x: number; y: number } | null>(null);
  const favorites = useStore((s) => s.favorites);
  const allItems = (queue?.items ?? []).filter((i) => i.id != null);

  /**
   * Snapshot the queue as a stored playlist. Entries carry CONTENT (the durable
   * key) plus the server/object id as a fast path — the id is a hint that heals
   * on activation, never the identity. Named for when it was taken, because the
   * alternative is a modal in the way of a one-click action; rename is one
   * click away on the Playlists screen.
   */
  const saveAsPlaylist = async (): Promise<void> => {
    const items = allItems
      .map((i) => i.metadata)
      .filter((m): m is NonNullable<typeof m> => m != null)
      .map((m) => ({
        title: m.title ?? "Unknown track",
        artist: m.artist ?? null,
        album: m.album ?? null,
        artUrl: m.art_url ?? null,
        serverUdn: null,
        serverName: null,
        objectId: null,
        durationSecs: m.duration ?? null,
      }));
    if (items.length === 0) return;
    // Date alone collides the second time you save in a day — and two rows
    // reading "Queue — Jul 24" are indistinguishable. The time makes it unique
    // in practice AND tells you which session it was.
    const name = `Queue — ${new Date().toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
    // Toast the STORED name (two saves in the same minute uniquify to "… (2)").
    const created = await tt.playlistCreate(name, items);
    showToast({
      kind: "success",
      text: `Saved ${items.length} tracks as “${created.name}”`,
      action: { label: "Open Playlists", screen: "playlists" },
    });
  };
  const performerOf = useQueuePerformer();

  // Filter over everything we hold, displayed or not (genre, class, source).
  const items = filter
    ? allItems.filter((i) =>
        matchesFilter(filter, [
          i.metadata?.title,
          i.metadata?.name,
          i.metadata?.artist,
          performerOf(i.metadata),
          i.metadata?.album,
          i.metadata?.genre,
          i.metadata?.class,
          i.metadata?.source,
        ]),
      )
    : allItems;
  const playId = queue?.play_id ?? playState?.queue_id ?? null;
  // The queue belongs to the MEDIA_PLAYER source. When another source is
  // active (AirPlay, radio, …) the device still reports a play_id — that row
  // is just where the queue is parked, and must not claim to be playing.
  const queueSourceActive = activeSourceId(zoneState, nowPlaying) === "MEDIA_PLAYER";

  const totalSecs = allItems.reduce((acc, i) => acc + (i.metadata?.duration ?? 0), 0);

  // Pointer AND keyboard (the playlists pattern): reordering a list you can't
  // drag is otherwise impossible for anyone without a mouse. The focused
  // handle owns space and the arrows — useShortcuts yields to it globally.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const currentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(items.map((it) => it.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target;
      if (t instanceof HTMLElement && t.matches("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape") setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size]);
  /** True = the click was a selection chord; the caller must not play. */
  const rowClick = (item: QueueListItem, e: React.MouseEvent): boolean => {
    const id = item.id;
    if (id == null) return false;
    const idx = items.findIndex((it) => it.id === id);
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      selAnchor.current = idx;
      return true;
    }
    if (e.shiftKey && selAnchor.current != null && idx >= 0) {
      const [a, b] = [Math.min(selAnchor.current, idx), Math.max(selAnchor.current, idx)];
      setSelected(new Set(items.slice(a, b + 1).flatMap((it) => (it.id == null ? [] : [it.id]))));
      return true;
    }
    if (selected.size > 0) setSelected(new Set());
    return false;
  };
  /** ⌘-click on an album header toggles its whole run. */
  const groupModClick = (ids: number[], e: React.MouseEvent): boolean => {
    if (!(e.metaKey || e.ctrlKey)) return false;
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = ids.every((id) => next.has(id));
      for (const id of ids) if (allIn) next.delete(id);
      if (!allIn) for (const id of ids) next.add(id);
      return next;
    });
    return true;
  };
  const removeSelected = (): void => {
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
    for (const i of chosen) void tt.command({ type: "queueDelete", id: i.id as number });
    setSelected(new Set());
    useStore.getState().showToast({
      kind: "success",
      text: `Removed ${chosen.length} tracks`,
      action: {
        label: "Undo",
        undo: () => {
          for (const s of saved) void restoreToQueue(s.content, s.position);
        },
      },
    });
  };
  // First follow after mount positions INSTANTLY — re-entering the screen
  // shouldn't replay a glide to a place you already were. The animation is
  // reserved for track changes while you're watching.
  const firstFollow = useRef(true);
  useEffect(() => {
    // Follow pauses while a filter is active — the current row may be hidden.
    if (followQueue && !filter && currentRef.current) {
      scrollToWithContext(
        currentRef.current,
        cards ? presetGap : 8,
        cards ? 0.5 : 1,
        firstFollow.current ? "auto" : undefined,
      );
    }
    firstFollow.current = false;
  }, [playId, followQueue, cards, presetGap, filter]);

  // A drag that starts on a SELECTED row moves the whole selection as a block
  // (the Finder contract — the first thing reached for once selection exists);
  // starting on an unselected row concerns that row alone and drops the
  // selection. Captured at drag start so the drop knows which grammar it is.
  // Drags only run unfiltered, so ids here are in full queue order.
  const [dragBatch, setDragBatch] = useState<{ ids: number[]; active: number } | null>(null);
  const onDragStart = (event: DragStartEvent): void => {
    const id = event.active.id as number;
    if (selected.has(id) && selected.size > 1) {
      setDragBatch({
        ids: items.flatMap((it) => (it.id != null && selected.has(it.id) ? [it.id] : [])),
        active: id,
      });
    } else {
      if (selected.size > 0) setSelected(new Set());
      setDragBatch(null);
    }
  };

  /** Reorder to `final` (full queue order): optimistic locally, then the
   *  simulated per-item moves to the device (see movesToTransform). */
  const applyOrder = (final: number[]): void => {
    const byId = new Map(allItems.map((it) => [it.id as number, it]));
    const order = allItems.map((it) => it.id as number);
    const moves = movesToTransform(order, final);
    if (moves.length === 0) return;
    setQueueItems(final.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
    for (const m of moves) void tt.command({ type: "queueMove", id: m.id, from: m.from, to: m.to });
  };

  const onDragEnd = (event: DragEndEvent): void => {
    const batch = dragBatch;
    setDragBatch(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (batch && batch.ids.length > 1) {
      // The drop matches the preview exactly: the drag ran over the LIFTED
      // list (members hidden), so land the active row there and expand it
      // into the whole block, in queue order.
      const bset = new Set(batch.ids);
      const vis = items.flatMap((it) =>
        it.id != null && (it.id === batch.active || !bset.has(it.id)) ? [it.id] : [],
      );
      const oldI = vis.indexOf(active.id as number);
      const newI = vis.indexOf(over.id as number);
      if (oldI < 0 || newI < 0) return;
      const landed = arrayMove(vis, oldI, newI);
      const final = landed.flatMap((id) => (id === batch.active ? batch.ids : [id]));
      applyOrder(final);
      return;
    }
    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const from = items[oldIndex].position ?? oldIndex;
    const to = items[newIndex].position ?? newIndex;
    // Optimistic reorder; the streamer re-announces the authoritative queue.
    setQueueItems(arrayMove(items, oldIndex, newIndex));
    void tt.command({ type: "queueMove", id: active.id as number, from, to });
  };

  // A batch drag LIFTS the block: the non-dragged members leave the list for
  // the drag's duration, so the make-room preview shows exactly the shape the
  // drop will produce and the count badge is the one thing in flight. Planted
  // ghosts read as faded selected rows, not movement (user, 2026-08-27).
  const batchSet = dragBatch ? new Set(dragBatch.ids) : null;
  const shownItems =
    dragBatch && batchSet
      ? items.filter((it) => it.id === dragBatch.active || !batchSet.has(it.id as number))
      : items;

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
    for (const f of selFavs) {
      const has = favorites.some((x) => favoriteKey(x) === favoriteKey(f as Favorite));
      if (selAllHearted ? has : !has) void toggleFavorite(f);
    }
  };

  /** The bar's block moves — unambiguous even under a filter (the visible
   *  selection goes to the very top or bottom of the FULL queue, keeping its
   *  relative order), so unlike drags these stay live while filtering. */
  const moveSelected = (where: "top" | "bottom"): void => {
    const ids = items.flatMap((it) => (it.id != null && selected.has(it.id) ? [it.id] : []));
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const rest = allItems.flatMap((it) => (it.id != null && !idSet.has(it.id) ? [it.id] : []));
    applyOrder(where === "top" ? [...ids, ...rest] : [...rest, ...ids]);
  };

  if (allItems.length === 0) {
    return (
      <EmptyState
        className="h-full"
        icon={ListMusic}
        title="Queue is empty"
        caption="Queue tracks from the StreamMagic app or another controller — they'll show up here."
      />
    );
  }

  return (
    <div className="relative h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <ScreenTitle>Queue</ScreenTitle>
        <span className="font-mono text-[11px] text-faint">
          {allItems.length} tracks · {fmtTime(totalSecs)}
        </span>
        <div className="flex-1" />
        {/* Same split as the Now Playing header: the two SAVE verbs create
            stored things, the three after them only change what you're looking
            at. Told apart by the wider gap-4 BETWEEN groups against the gap-1.5
            within one. The filter needs no group of its own — it's an input,
            already a different shape from the chips. */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <FilterInput
              value={filter}
              onChange={(t) => setScreenFilter("queue", t)}
              shown={items.length}
              total={allItems.length}
            />
            <HeaderChip
              data-tip="Save queue as a playlist"
              aria-label="Save queue as a playlist"
              onClick={() => void saveAsPlaylist()}
              disabled={allItems.length === 0}
              className="no-drag tip-bottom p-2 disabled:opacity-40 motion-safe:active:scale-90"
            >
              <ListOrdered size={16} />
            </HeaderChip>
            <HeaderChip
              data-tip="Save queue as preset"
              aria-label="Save queue as preset"
              onClick={() => setSaveOpen(true)}
              className="no-drag tip-bottom p-2 motion-safe:active:scale-90"
            >
              <BookmarkPlus size={16} />
            </HeaderChip>
            {/* Destructive and not undoable (device state) → the confirm-popover
                law. Clearing empties the visible list, so no toast (feedback
                keys on invocation context; the effect is its own feedback). */}
            <HeaderChip
              data-tip="Clear queue"
              aria-label="Clear queue"
              disabled={allItems.length === 0}
              onClick={(e) =>
                clearConfirm.ask(e, {
                  question: "Clear the queue?",
                  verb: "Clear",
                  onConfirm: () => void tt.command({ type: "queueClear" }),
                })
              }
              className="no-drag tip-bottom p-2 disabled:opacity-40 motion-safe:active:scale-90"
            >
              <ListX size={16} />
            </HeaderChip>
            {clearConfirm.popover}
          </div>
          <div className="flex items-center gap-1.5">
            <HeaderChip
              data-tip={cards ? "View as rows" : albums ? "View as cards" : "View as albums"}
              aria-label={cards ? "View as rows" : albums ? "View as cards" : "View as albums"}
              onClick={() => void setLayout(cards ? "rows" : albums ? "cards" : "albums")}
              className="no-drag tip-bottom p-2 motion-safe:active:scale-90"
            >
              {cards ? (
                <Rows3 size={16} />
              ) : albums ? (
                <LayoutGrid size={16} />
              ) : (
                <ListMusic size={16} />
              )}
            </HeaderChip>
            <HeaderChip
              data-tip="Scroll to the current track"
              aria-label="Scroll to the current track"
              onClick={scrollToCurrent}
              className="no-drag tip-bottom p-2 motion-safe:active:scale-90"
            >
              <Crosshair size={16} />
            </HeaderChip>
            <HeaderChip
              active={followQueue}
              data-tip={followQueue ? "Auto-follow: on" : "Auto-follow: off"}
              aria-label={followQueue ? "Auto-follow: on" : "Auto-follow: off"}
              onClick={() => void setFollowQueue(!followQueue)}
              className="no-drag tip-bottom p-2"
            >
              <Footprints size={16} />
            </HeaderChip>
          </div>
        </div>
      </header>

      {rowMenu && (
        <RowMenu
          title={rowMenu.item.metadata?.title ?? "Track"}
          at={{ x: rowMenu.x, y: rowMenu.y }}
          onClose={() => setRowMenu(null)}
          items={queueRowActions(rowMenu.item, {
            addToPlaylist: () => setPlaylistFor({ item: rowMenu.item, x: rowMenu.x, y: rowMenu.y }),
            saveToPreset: () => setPresetFor({ item: rowMenu.item, x: rowMenu.x, y: rowMenu.y }),
          })}
        />
      )}
      {playlistFor && (
        <AddToPlaylistPanel
          label={playlistFor.item.metadata?.title ?? "this track"}
          at={{ x: playlistFor.x, y: playlistFor.y }}
          onClose={() => setPlaylistFor(null)}
          resolve={() => {
            // a queue id belongs to THIS queue, not to the library — content
            // is the identity, resolved fresh on activation
            const ref = fromQueueItem(playlistFor.item);
            return Promise.resolve(ref ? [refToPlaylistItem(ref)] : []);
          }}
        />
      )}
      {playlistBatch && (
        <AddToPlaylistPanel
          label={`${selected.size} tracks`}
          at={playlistBatch}
          onClose={() => setPlaylistBatch(null)}
          resolve={() => {
            // content identity, resolved fresh on activation (the per-row rule)
            const refs = items.flatMap((it) =>
              it.id != null && selected.has(it.id) ? [fromQueueItem(it)] : [],
            );
            setSelected(new Set());
            return Promise.resolve(
              refs.flatMap((r) => (r != null ? [refToPlaylistItem(r)] : [])),
            );
          }}
        />
      )}
      {presetFor && (
        <PresetPicker
          picker={{
            node: { title: presetFor.item.metadata?.title ?? "Track" },
            x: presetFor.x,
            y: presetFor.y,
          }}
          onClose={() => setPresetFor(null)}
          onSave={async (slot, name) => {
            const ref = fromQueueItem(presetFor.item);
            if (!ref) throw new Error("no content identity");
            await saveRefToPreset(ref, slot, name);
            setPresetFor(null);
          }}
        />
      )}
      <SaveQueueDialog open={saveOpen} onClose={() => setSaveOpen(false)} />

      {/* the selection bar FLOATS over the list (toast entrance, popover
          surface) — in flow it pushed every row down the moment a chord
          landed, a re-layout of the exact rows being picked (user,
          2026-08-27); the list scrolls beneath it instead */}
      {selected.size > 0 && (
        <div className="toast-in absolute bottom-4 inset-x-6 z-30 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl ring-1 ring-edge2 bg-raised shadow-xl px-3 py-2 text-[12.5px]">
          <span className="text-dim tabular-nums">{selected.size} selected</span>
          <button
            onClick={() => moveSelected("top")}
            className="text-dim hover:text-ink transition-colors"
          >
            Move to top
          </button>
          <button
            onClick={() => moveSelected("bottom")}
            className="text-dim hover:text-ink transition-colors"
          >
            Move to bottom
          </button>
          <button
            onClick={(e) => setPlaylistBatch({ x: e.clientX, y: e.clientY })}
            className="text-dim hover:text-ink transition-colors"
          >
            Add to playlist…
          </button>
          {selFavs.length > 0 && (
            <button onClick={heartSelected} className="text-dim hover:text-ink transition-colors">
              {selAllHearted ? "Remove from favorites" : "Add to favorites"}
            </button>
          )}
          <button onClick={removeSelected} className="text-dim hover:text-alert transition-colors">
            Remove from queue
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setSelected(new Set())}
            className="text-faint hover:text-ink transition-colors"
            title="Esc"
          >
            Clear
          </button>
        </div>
      )}

      {/* rows: pt-1 keeps the current ring unclipped; cards: pt-2 gives the
          hover grow + glow ring headroom on the top row */}
      <div
        ref={scrollRef}
        className={cx(
          "flex-1 overflow-y-auto",
          // the albums view separates by its header surface, not by rules —
          // dividers would double the boundary the veil bar already draws
          cards
            ? "px-8 pb-8 pt-2"
            : albums
              ? "px-6 pb-6 pt-1"
              : "px-6 pb-6 pt-1 divide-y divide-edge/50",
        )}
      >
        {items.length === 0 && (
          <div className="text-[15px] text-faint pt-6 px-2">No matches for “{filter}”</div>
        )}
        {/* Reordering a partial list is ambiguous — drags are inert while filtered. */}
        <DndContext
          sensors={filter || albums ? [] : sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragCancel={() => setDragBatch(null)}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={shownItems.map((i) => i.id as number)}
            strategy={cards ? rectSortingStrategy : verticalListSortingStrategy}
          >
            {albums ? (
              <QueueAlbumGroups
                items={items}
                playId={playId}
                sourceActive={queueSourceActive}
                currentRef={currentRef}
                selectedIds={selected}
                onRowClick={rowClick}
                onGroupModClick={groupModClick}
                onMenu={(item, e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setRowMenu({ item, x: e.clientX, y: e.clientY });
                }}
              />
            ) : cards ? (
              <div
                className="grid"
                style={{
                  gridTemplateColumns: presetFillRows
                    ? `repeat(auto-fill, minmax(${presetCardSize}px, 1fr))`
                    : `repeat(auto-fill, ${presetCardSize}px)`,
                  gap: presetGap,
                }}
              >
                {shownItems.map((item) => (
                  <QueueCard
                    key={item.id}
                    onMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setRowMenu({ item, x: e.clientX, y: e.clientY });
                    }}
                    item={item}
                    isCurrent={item.id === playId}
                    sourceActive={queueSourceActive}
                    currentRef={item.id === playId ? currentRef : undefined}
                    selected={item.id != null && selected.has(item.id)}
                    onRowClick={(e) => rowClick(item, e)}
                    batchCount={dragBatch?.ids.length}
                  />
                ))}
              </div>
            ) : (
              shownItems.map((item) => (
                <QueueRow
                  key={item.id}
                  onMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setRowMenu({ item, x: e.clientX, y: e.clientY });
                  }}
                  item={item}
                  isCurrent={item.id === playId}
                  sourceActive={queueSourceActive}
                  currentRef={item.id === playId ? currentRef : undefined}
                  selected={item.id != null && selected.has(item.id)}
                  onRowClick={(e) => rowClick(item, e)}
                  batchCount={dragBatch?.ids.length}
                />
              ))
            )}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

/**
 * The album-grouped queue view (2026-08-24, a repeated forum ask: "cover
 * once, tracks beneath, remove the album by its cover"). Groups are
 * CONTIGUOUS runs of one album — queue order stays authoritative, so the
 * same album queued twice shows twice. Albumless entries render as plain
 * ungrouped rows. A reading-and-pruning view: drag reorder stays with the
 * rows and cards layouts.
 */
function QueueAlbumGroups({
  items,
  playId,
  sourceActive,
  currentRef,
  onMenu,
  selectedIds,
  onRowClick,
  onGroupModClick,
}: {
  items: QueueListItem[];
  playId: number | null;
  sourceActive: boolean;
  currentRef: React.MutableRefObject<HTMLDivElement | null>;
  onMenu(item: QueueListItem, e: React.MouseEvent): void;
  selectedIds: ReadonlySet<number>;
  onRowClick(item: QueueListItem, e: React.MouseEvent): boolean;
  onGroupModClick(ids: number[], e: React.MouseEvent): boolean;
}): React.JSX.Element {
  const performerFor = useQueuePerformer();
  const groups: Array<{ album: string | null; items: QueueListItem[] }> = [];
  for (const item of items) {
    const album = item.metadata?.album ?? null;
    const last = groups.at(-1);
    if (album != null && last && last.album === album) last.items.push(item);
    else groups.push({ album, items: [item] });
  }
  const removeAlbum = (g: { album: string | null; items: QueueListItem[] }): void => {
    // Only titled entries can be found again — the same rule the single-row
    // remove applies to its own undo offer.
    const saved = g.items.flatMap((i) => {
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
    for (const i of g.items) if (i.id != null) void tt.command({ type: "queueDelete", id: i.id });
    useStore.getState().showToast({
      kind: "success",
      text: `Removed “${g.album}” — ${g.items.length} tracks`,
      action: {
        label: "Undo",
        undo: () => {
          for (const s of saved) void restoreToQueue(s.content, s.position);
        },
      },
    });
  };
  return (
    <>
      {groups.map((g, gi) =>
        g.album == null ? (
          g.items.map((item) => (
            <QueueRow
              key={item.id}
              onMenu={(e) => onMenu(item, e)}
              item={item}
              isCurrent={item.id === playId}
              sourceActive={sourceActive}
              currentRef={item.id === playId ? currentRef : undefined}
              selected={item.id != null && selectedIds.has(item.id)}
              onRowClick={(e) => onRowClick(item, e)}
            />
          ))
        ) : (
          <div
            key={`${g.album}-${g.items[0]?.id ?? gi}`}
            data-queue-album={g.album}
            className="mb-3"
          >
            <div
              className={cx(
                "group mb-1.5 grid grid-cols-[44px_1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5",
                // the header rests one veil step above the tracks (they are
                // transparent until hover), and hover moves it one step further
                // — the same ladder the wells and hover fills already use
                "cursor-default ring-1 ring-edge2 bg-veil transition-colors hover:bg-veil2",
              )}
              onClick={(e) => {
                // ⌘-click on the header selects the whole run
                if (
                  onGroupModClick(
                    g.items.flatMap((i) => (i.id == null ? [] : [i.id])),
                    e,
                  )
                )
                  return;
                const first = g.items[0];
                if (first?.id != null) void tt.command({ type: "playQueueId", queueId: first.id });
              }}
            >
              <MediaArt src={g.items[0]?.metadata?.art_url} kind="album" />
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="text-[13.5px] truncate font-semibold text-ink">{g.album}</div>
                  {g.items.some((i) => i.id === playId) && sourceActive && <Eqbars />}
                </div>
                <div className="text-[12px] text-dim truncate">
                  {[
                    performerFor(g.items[0]?.metadata) ?? g.items[0]?.metadata?.artist,
                    `${g.items.length} tracks`,
                    fmtTime(g.items.reduce((s, i) => s + (i.metadata?.duration ?? 0), 0)),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <div className="flex items-center gap-0.5">
                <RowAction
                  icon={X}
                  label="Remove album from queue"
                  destructive
                  onClick={() => removeAlbum(g)}
                />
              </div>
            </div>
            {g.items.map((item, i) => {
              const isCurrent = item.id === playId;
              const isSelected = item.id != null && selectedIds.has(item.id);
              return (
                <div
                  key={item.id}
                  ref={isCurrent ? currentRef : undefined}
                  className={cx(
                    "group grid grid-cols-[44px_1fr_auto] items-center gap-3 rounded-lg py-1 pl-2 pr-2",
                    "cursor-default transition-colors",
                    isCurrent && sourceActive && "row-playing bg-gold/10",
                    isCurrent &&
                      !sourceActive &&
                      !isSelected &&
                      "ring-1 ring-edge2 bg-veil/60 hover:bg-veil",
                    !isCurrent && !isSelected && "hover:bg-veil",
                    isSelected && "ring-1 ring-edge2 bg-veil2",
                  )}
                  onClick={(e) => {
                    if (onRowClick(item, e)) return;
                    if (item.id != null) void tt.command({ type: "playQueueId", queueId: item.id });
                  }}
                  onContextMenu={(e) => onMenu(item, e)}
                >
                  <span className="justify-self-end pr-1 font-mono text-[10.5px] text-faint tabular-nums">
                    {isCurrent ? <Eqbars dim={!sourceActive} /> : i + 1}
                  </span>
                  <div
                    className={cx(
                      "min-w-0 truncate text-[13px]",
                      isCurrent && sourceActive ? "text-gold" : "text-ink",
                    )}
                  >
                    {item.metadata?.title ?? "—"}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <RowAction
                      icon={X}
                      label="Remove from queue"
                      destructive
                      onClick={() => removeFromQueue(item)}
                    />
                    <RowAction
                      icon={MoreHorizontal}
                      label="More actions"
                      onClick={(e) => onMenu(item, e)}
                    />
                    <span className="pl-1 font-mono text-[11px] text-faint tabular-nums">
                      {fmtTime(item.metadata?.duration ?? 0)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ),
      )}
    </>
  );
}

/**
 * Remove a queued track, offering to put it back. The row ×, the card × and
 * the ⋯ menu all come here so the offer can't belong to only one of them.
 *
 * No confirm, deliberately: the queue is the app's most-edited list, and
 * playing an album REPLACES it wholesale with no confirm at all — guarding one
 * row while the wipe goes unguarded would protect the wrong thing.
 */
function removeFromQueue(item: QueueListItem): void {
  if (item.id == null) return;
  const md = item.metadata;
  const title = md?.title ?? null;
  const position = item.position ?? 0;
  void tt.command({ type: "queueDelete", id: item.id });
  // No title, no content identity, nothing to find it by later — so no offer.
  // (Same rule as the row's heart: see queueItemFavorite.)
  if (!title) return;
  useStore.getState().showToast({
    kind: "success",
    text: `Removed “${title}”`,
    action: {
      label: "Undo",
      undo: () =>
        void restoreToQueue(
          { title, artist: md?.artist ?? null, album: md?.album ?? null },
          position,
        ),
    },
  });
}

/**
 * Success is SILENT: you're looking at the queue, and the row reappearing in
 * place is better feedback than a toast saying so. Only the ways it can fail
 * get one — a restore that quietly did nothing is the thing worth avoiding.
 */
async function restoreToQueue(ref: ContentRef, position: number): Promise<void> {
  const showToast = useStore.getState().showToast;
  let result: QueueRestoreResult;
  try {
    result = await tt.queueRestore(ref, position);
  } catch {
    result = "failed";
  }
  if (result === "ok") return;
  showToast({
    kind: "error",
    text:
      result === "not-found"
        ? `Couldn't find “${ref.title}” to put back`
        : `Couldn't put “${ref.title}” back`,
  });
}

/**
 * The move commands that turn one id order into another, simulated stepwise:
 * queueMove takes CURRENT positions, and every move renumbers the queue, so
 * each command's from/to comes from a working copy that has already applied
 * the moves before it (the device applies them in the same order — the WS is
 * FIFO). Walks the target order and pulls each misplaced id into its slot,
 * so a block move emits at most one move per block member.
 */
function movesToTransform(
  from: number[],
  to: number[],
): Array<{ id: number; from: number; to: number }> {
  const work = [...from];
  const moves: Array<{ id: number; from: number; to: number }> = [];
  for (let i = 0; i < to.length; i++) {
    if (work[i] === to[i]) continue;
    const j = work.indexOf(to[i]);
    if (j < 0) continue;
    work.splice(j, 1);
    work.splice(i, 0, to[i]);
    moves.push({ id: to[i], from: j, to: i });
  }
  return moves;
}

interface QueueItemProps {
  onMenu?(e: React.MouseEvent): void;
  item: QueueListItem;
  isCurrent: boolean;
  /** The queue's own source (MEDIA_PLAYER) is what's audible right now. */
  sourceActive: boolean;
  currentRef?: React.MutableRefObject<HTMLDivElement | null>;
  /** Part of the current multi-selection (⌘/⇧-click). */
  selected?: boolean;
  /** Selection first: returns true when the click was a ⌘/⇧ chord and the
   *  row must NOT play — bare clicks keep meaning play, the app-wide rule. */
  onRowClick?(e: React.MouseEvent): boolean;
  /** Size of the block a batch drag is carrying (the dragged row wears the
   *  count while it moves; the other members are lifted out of the list). */
  batchCount?: number;
}

function QueueRow({
  item,
  isCurrent,
  sourceActive,
  currentRef,
  onMenu,
  selected = false,
  onRowClick,
  batchCount,
}: QueueItemProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id as number,
  });
  const md = item.metadata;
  // the performer the library knows for a compilation entry (display only)
  const artist = useQueuePerformer()(md) ?? md?.artist;
  const favorites = useStore((s) => s.favorites);
  const ref = fromQueueItem(item);
  const favorite = ref ? refToFavorite(ref) : null;
  const hearted =
    favorite != null && favorites.some((f) => favoriteKey(f) === favoriteKey(favorite as Favorite));

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        if (currentRef) currentRef.current = node;
      }}
      style={{ transform: CSS.Transform.toString(lockVertical(transform)), transition }}
      className={cx(
        "group relative grid grid-cols-[26px_44px_1fr_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5",
        "cursor-default transition-colors",
        isDragging && "z-10 bg-raised shadow-xl",
        // current + queue audible: full playing treatment; current while another
        // source plays: just the parked resume point, quietly set apart
        isCurrent && sourceActive && "row-playing bg-gold/10",
        isCurrent && !sourceActive && !selected && "ring-1 ring-edge2 bg-veil/60 hover:bg-veil",
        !isCurrent && !selected && "hover:bg-veil",
        selected && "ring-1 ring-edge2 bg-veil2",
      )}
      onClick={(e) => {
        if (onRowClick?.(e)) return;
        if (item.id != null) void tt.command({ type: "playQueueId", queueId: item.id });
      }}
      onContextMenu={(e) => {
        // right-click = the ⋯, the app-wide rule (favorites established it)
        e.preventDefault();
        onMenu?.(e);
      }}
    >
      {isDragging && (batchCount ?? 0) > 1 && (
        <span className="absolute -top-2 right-2 z-20 rounded-full bg-gold text-bg text-[10.5px] font-medium px-2 py-0.5 shadow-lg">
          {batchCount} tracks
        </span>
      )}
      <OrderHandle
        label={`Reorder ${md?.title ?? "track"}`}
        attributes={attributes}
        listeners={listeners}
      >
        {isCurrent ? (
          <Eqbars dim={!sourceActive} />
        ) : (
          <span className="font-mono text-[10.5px] text-faint tabular-nums">
            {(item.position ?? 0) + 1}
          </span>
        )}
      </OrderHandle>

      <MediaArt src={md?.art_url} kind="track" />

      <div className="min-w-0">
        <div
          className={cx(
            "text-[13.5px] truncate",
            isCurrent && sourceActive ? "text-gold" : "text-ink",
          )}
        >
          {md?.title ?? md?.name ?? "—"}
        </div>
        <div className="text-[12px] text-dim truncate">
          {[artist, md?.album].filter(Boolean).join(" — ")}
        </div>
      </div>

      {/* One cluster, gap-0.5 — the library and favorites rows group their
          actions this way, and having these as separate GRID cells made them
          inherit the row's gap-2 and sit visibly further apart. */}
      <div className="flex items-center gap-0.5">
        <RowAction
          icon={X}
          label="Remove from queue"
          destructive
          onClick={() => removeFromQueue(item)}
        />
        <RowAction icon={MoreHorizontal} label="More actions" onClick={(e) => onMenu?.(e)} />
        {/* The heart is PERSISTENT state, so it groups with the duration at the
            right edge rather than leading the cluster — a set heart with the
            hidden ⋯/× columns between it and the time looked stranded. */}
        {favorite && (
          <RowHeart
            favorited={hearted}
            held={false}
            onHeart={() => void toggleFavorite(favorite)}
          />
        )}
      </div>

      {/* Duration sits at the far right of the CONTENT, after the actions —
          it's always-visible information, so it wants a stable column, while
          the actions come and go with hover. */}
      <DurationCell secs={md?.duration ?? null} />
    </div>
  );
}

/** Card view of a queue track — mirrors PresetCard's inset-tile anatomy. */
function QueueCard({
  item,
  isCurrent,
  sourceActive,
  currentRef,
  onMenu,
  selected = false,
  onRowClick,
  batchCount,
}: QueueItemProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id as number,
  });
  const md = item.metadata;
  const artist = useQueuePerformer()(md) ?? md?.artist;

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        if (currentRef) currentRef.current = node;
      }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu?.(e);
      }}
      className={cx(
        // Hover grow matches PresetCard; scale is layout-free so edge-clipped
        // cards simply clip at the scrollport seam.
        "group relative text-left rounded-2xl p-2 pb-2.5 transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]",
        isDragging && "z-10 opacity-90",
        isCurrent && sourceActive
          ? "bg-goldtile/70 tile-playing"
          : isCurrent
            ? "bg-veil/60 ring-1 ring-edge2 card-hover-glow"
            : selected
              ? "bg-veil2 ring-1 ring-edge2 card-hover-glow"
              : "bg-raised/50 ring-1 ring-edge card-hover-glow",
      )}
    >
      {isDragging && (batchCount ?? 0) > 1 && (
        <span className="absolute -top-2 -right-1 z-20 rounded-full bg-gold text-bg text-[10.5px] font-medium px-2 py-0.5 shadow-lg">
          {batchCount} tracks
        </span>
      )}
      <button
        className="relative block w-full cursor-pointer"
        onClick={(e) => {
          if (onRowClick?.(e)) return;
          if (item.id != null) void tt.command({ type: "playQueueId", queueId: item.id });
        }}
      >
        {/* the art well is a veil lift, never a panel hole — see LibraryCards */}
        <div className="aspect-square w-full rounded-lg overflow-hidden bg-veil flex items-center justify-center">
          <ArtImage
            src={artUrlAt(md?.art_url, 240)}
            lazy
            fallback={<Disc3 size={34} strokeWidth={1.2} className="text-faint" />}
          />

          <div className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <span
              className="h-11 w-11 rounded-full bg-amber text-bg flex items-center justify-center
                         transition-all duration-150 motion-safe:hover:scale-110
                         hover:shadow-[0_0_24px_rgb(var(--amber-rgb)_/_0.6)]"
            >
              <Play size={18} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />
            </span>
          </div>

          {/* the one card-chip grammar (ContainerCard's): ⋯ bottom-right on
              the art, status top-left, one chip surface — this card used a
              rounded-full blur chip at TOP-right, the only card that did */}
          <span
            aria-label="More actions"
            onClick={(e) => {
              e.stopPropagation();
              onMenu?.(e);
            }}
            className="absolute bottom-1.5 right-1.5 z-10 h-8 w-8 rounded-lg bg-panel/80 ring-1 ring-edge text-dim hover:text-ink flex items-center justify-center transition-all opacity-0 group-hover:opacity-100"
          >
            <MoreHorizontal size={15} />
          </span>

          {isCurrent && (
            <span className="absolute top-1.5 left-1.5 flex items-center rounded-lg bg-panel/80 ring-1 ring-edge px-1.5 h-7">
              <Eqbars dim={!sourceActive} />
            </span>
          )}
        </div>
      </button>

      <div className="mt-2 px-1 flex items-start gap-1">
        <div className="flex-1 min-w-0">
          <div
            className={cx(
              "text-[12.5px] leading-snug line-clamp-2",
              isCurrent && sourceActive ? "text-gold" : "text-ink",
            )}
          >
            {md?.title ?? md?.name ?? "—"}
          </div>
          <div className="text-[11px] text-dim truncate mt-0.5">
            {[artist, md?.album].filter(Boolean).join(" — ")}
          </div>
          <div className="microlabel mt-1">
            {String((item.position ?? 0) + 1).padStart(2, "0")} · {fmtTime(md?.duration)}
          </div>
        </div>
        <button
          data-tip="Remove from queue"
          aria-label="Remove from queue"
          onPointerDown={(e) => e.stopPropagation() /* keep dnd-kit's drag sensor out of it */}
          onClick={(e) => {
            e.stopPropagation();
            if (item.id != null) void tt.command({ type: "queueDelete", id: item.id });
          }}
          className="tip-bottom p-1 rounded text-faint opacity-0 group-hover:opacity-100 hover:text-alert transition-all"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

/**
 * A queued track's ⋯ — the shared track menu (lib/mediaMenus) plus the local
 * remove. No play verbs: the row's click already plays, and a queued row has
 * no meaningful "add to queue". A row with NO content identity (no title)
 * still offers its removal — the one verb that needs only the queue id.
 */
function queueRowActions(
  item: QueueListItem,
  deps: { addToPlaylist: () => void; saveToPreset: () => void },
): MediaMenuItem[] {
  const remove: MediaMenuItem[] =
    item.id != null ? [{ label: "Remove from queue", run: () => removeFromQueue(item) }] : [];
  const ref = fromQueueItem(item);
  if (!ref) return remove;
  return trackMenuItems(ref, {
    addToPlaylist: deps.addToPlaylist,
    saveToPreset: deps.saveToPreset,
    openInLibrary: () => void openRefInLibrary(ref),
    extra: remove,
  });
}
