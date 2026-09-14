import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { useKnownDrs } from "@/lib/audioAnalysis";
import { useWindowedList } from "@/hooks/useWindowedList";
import { DrBadge } from "@/components/media/Waveform";
import { createPortal } from "react-dom";
import { useQueuePerformer } from "@/hooks/useQueuePerformer";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Modifier } from "@dnd-kit/core";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  BookmarkPlus,
  Check,
  Crosshair,
  Disc3,
  Footprints,
  LayoutGrid,
  ListMusic,
  ListOrdered,
  ListPlus,
  ListX,
  Heart,
  MoreHorizontal,
  Play,
  Rows3,
  X,
} from "lucide-react";
import { queueContentHash, type QueueListItem } from "@shared/smoip";
import { presetVolumeKey, type QueueLayout, audioAnalysisKey } from "@shared/model";
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
import { activeSourceId, cx, fmtTime, matchesFilter, fmtCount } from "@/lib/format";
import { toggleFavorite } from "@/lib/favorites";
import { fromQueueItem, refToFavorite, refToPlaylistItem } from "@/lib/mediaRef";
import { saveRefToPreset, openRefInLibrary } from "@/lib/mediaActions";
import { NameLine } from "@/components/media/NameLine";
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
import { SelectionBar, SelectionVerb } from "@/components/controls/SelectionBar";
import { DragChip } from "@/components/controls/DragChip";
import { clampChipPos } from "@/lib/navDrop";
import { ModalShell } from "@/components/chrome/Overlay";
import { PresetSavePanel, PresetPicker } from "@/components/library/LibraryMenus";
import { HeaderChip, ScreenTitle, GAP_BETWEEN, GAP_WITHIN } from "@/components/chrome/Chrome";
import { artSrc } from "@/lib/artSrc";
import { useQueueDrag } from "@/components/queue/useQueueDrag";
import { useQueueSelection, type SelectionLate } from "@/components/queue/useQueueSelection";

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
        subtitle={`${fmtCount(trackCount)} tracks, stored on the streamer`}
        nameAutoFocus
        onSave={onSave}
      />
    </ModalShell>
  );
}

export function QueueScreen(): React.JSX.Element {
  const queue = useStore((s) => s.queue);
  const saveSettings = useStore((s) => s.saveSettings);
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
  const [playlistBatch, setPlaylistBatch] = useState<{
    x: number;
    y: number;
    /** Rail drops name their tracks; the bar verb omits this and the panel
     *  takes the live selection. */
    ids?: number[];
  } | null>(null);
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
  // the SETTLED playing id (store.effectivePlayId): the pointer, unless the
  // readout has named another entry for long enough — see lib/playingEntry
  const playId = useStore((s) => s.effectivePlayId);
  // DR wherever a track row is (2026-09-02): the known integers by content key,
  // a reserved cell in every row once the queue knows any
  const keyOf = (i: QueueListItem): string =>
    audioAnalysisKey({
      title: i.metadata?.title ?? "",
      artist: i.metadata?.artist ?? null,
      album: i.metadata?.album ?? null,
      durationSecs: i.metadata?.duration ?? null,
    });
  // A LARGE queue renders only the rows near the viewport (2026-09-04, the
  // 2,528-track queue: 83k DOM nodes took ~7s to commit and every hover
  // re-laid-out the lot). Rows keep their ABSOLUTE index — selection edges,
  // the insert line and dnd-kit's SortableContext ids are untouched — and two
  // spacers hold the scroll height, so useScrollMemory and the current-row
  // follow keep working. Only above LEAN_QUEUE: an ordinary queue renders
  // every row exactly as before.
  const leanRows = !cards && !albums && items.length > LEAN_QUEUE;
  // the shared hook (hooks/useWindowedList, 2026-09-05): the pitch from the
  // rendered rows, the offset of row 0 below the header inside the scroller
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  /** True through a drag AND the event that ends it (the drag hook sets it; the
   *  selection's Escape reads it, so a cancelled drag does not also clear the
   *  selection): the screen's, so both hooks share one flag. */
  const dragLiveRef = useRef(false);
  // Selection lives in components/queue/useQueueSelection (lifted 2026-09-13, the
  // second lift): the multi-select, its keyboard and clearing, remove with its
  // undo, the batch heart and the bar's block moves; the block move itself is
  // the drag hook's and reaches the selection late-bound through selectionLate
  const selectionLate = useRef<SelectionLate>({ applyBlockMove: () => false });
  const {
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
  } = useQueueSelection({
    items,
    allItems,
    favorites,
    scrollElRef,
    dragLiveRef,
    snapQueueRows,
    restoreToQueue,
    late: selectionLate,
  });
  // Drag and drop lives in components/queue/useQueueDrag (lifted 2026-09-13, the
  // first lift of this screen's hygiene round, the Library's pattern): the batch
  // and single drags, the insertion line from live geometry, the drag-to-rail
  // handoff, the block move and its device commands, the drop and the cancel;
  // the screen keeps the rows, the overlay and the FLIP landing, and takes the
  // state back under the old names
  const {
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
  } = useQueueDrag({
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
  });
  selectionLate.current = { applyBlockMove };
  const leanWin = useWindowedList({
    scrollRef: scrollElRef,
    count: items.length,
    itemSelector: "[data-queue-id]",
    estimate: 57,
    overscan: LEAN_OVERSCAN,
    enabled: leanRows,
  });
  const leanRange: [number, number] = [leanWin.first, leanWin.last];

  const drKeys = useMemo(() => allItems.map(keyOf), [allItems]);
  const drByKey = useKnownDrs(drKeys);
  const anyDr = Object.keys(drByKey).length > 0;
  const drFor = (i: QueueListItem): number | null | undefined =>
    anyDr ? (drByKey[keyOf(i)] ?? null) : undefined;
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
    } else if (followQueue && !filter && leanRows) {
      // the current row is outside the rendered window: land it by index
      const idx = items.findIndex((i) => i.id === playId);
      const sc = scrollElRef.current;
      if (idx >= 0 && sc) sc.scrollTop = Math.max(0, leanWin.offsetOf(idx) - sc.clientHeight / 2);
    }
    firstFollow.current = false;
    // leanRows/items/leanWin are read for the windowed landing only; the effect stays keyed on the pointer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playId, followQueue, cards, presetGap, filter]);

  // THE LANDING ANIMATES (user, 2026-08-27 — an instant re-order after the
  // line model read as a teleport): a FLIP pass flies every displaced row
  // from its old rect to its new one. WAAPI (el.animate), not style
  // mutation, so the streamer's re-announce mid-flight can't snap a row out
  // of its animation; skipped under reduced motion.
  useLayoutEffect(() => {
    // arrival washes are keyed on identity + position, not on the armed
    // snapshot — a restore's landing announce often arrives with no
    // mutation of ours armed (see pendingWash)
    lastQueueItems = queue?.items ?? [];
    washArrivals();
    const snap = flipSnap;
    if (!snap) return;
    flipSnap = null;
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      document.documentElement.classList.contains("reduce-motion")
    )
      return;
    document.querySelectorAll<HTMLElement>("[data-queue-id]").forEach((el) => {
      const old = snap.get(Number(el.dataset.queueId));
      if (!old) {
        // no old rect = a row that just entered — it fades in while its
        // neighbors FLIP out of the way. No wash here: this branch also
        // fires for a restore's transient tail append, which is exactly
        // where the wash must NOT go (it lit the off-screen tail, not the
        // landing) — washArrivals owns the gold.
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
        return;
      }
      const r = el.getBoundingClientRect();
      const dx = old.x - r.left;
      const dy = old.y - r.top;
      if (dx === 0 && dy === 0) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
        duration: 220,
        easing: "cubic-bezier(0.2, 0.7, 0.3, 1)",
      });
    });
  }, [queue]);

  /** ONE wiring for what a card and a row share (they carried two copies of it,
   *  2026-09-13): identity, the menu, the playing state, the selection, the drag's
   *  stillness and line, the open menu. A row adds what only rows have (the DR
   *  cell, the selection edges, the body drag). */
  const rowProps = (item: QueueListItem) => ({
    onMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setRowMenu({ item, x: e.clientX, y: e.clientY });
    },
    item,
    isCurrent: item.id === playId,
    sourceActive: queueSourceActive,
    currentRef: item.id === playId ? currentRef : undefined,
    selected: item.id != null && selected.has(item.id),
    onRowClick: (e: React.MouseEvent) => rowClick(item, e),
    staticDrag: dragBatch != null || navHover != null,
    dragLive: dragBatch != null || dragSingle != null,
    // the literals stay narrow (a bare literal in a mutable property widens to string)
    insertLine:
      insertAt?.id === item.id
        ? insertAt.after
          ? ("after" as const)
          : ("before" as const)
        : undefined,
    menuOpen: rowMenu?.item.id === item.id,
  });

  if (allItems.length === 0) {
    return (
      <EmptyState
        className="h-full"
        icon={ListMusic}
        title="Queue is empty"
        caption="Queue tracks from the Library, Search or Playlists and they'll show up here."
      />
    );
  }

  return (
    <div
      className="relative h-full flex flex-col"
      onClick={(e) => {
        // blank-space click clears the selection (the Finder rule); chords
        // and anything interactive are excluded, rows handle themselves
        if (selected.size === 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        const t = e.target as HTMLElement;
        // a portaled surface's dismiss click (popover backdrop, menu, panel —
        // React bubbles through portals) is its own gesture, never a
        // background click: the target must really live inside this screen
        if (!e.currentTarget.contains(t)) return;
        if (
          t.closest("button, input, a, [data-queue-id], [data-queue-album], [data-selection-bar]")
        )
          return;
        setSelected(new Set());
      }}
    >
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <ScreenTitle>Queue</ScreenTitle>
        <span className="font-mono text-[11px] text-faint">
          {allItems.length} tracks · {fmtTime(totalSecs)}
        </span>
        <div className="flex-1" />
        {/* Same split as the Now Playing header: the two SAVE verbs create
            stored things, the three after them only change what you're looking
            at. Told apart by the wider tier BETWEEN groups against the tier
            within one — the app-wide toolbar tiers, one home in Chrome
            (GAP_BETWEEN / GAP_WITHIN). The filter stands alone: typing is its
            own kind of act, so the between tier separates it from the verbs. */}
        <div className={`flex items-center ${GAP_BETWEEN}`}>
          <FilterInput
            value={filter}
            onChange={(t) => setScreenFilter("queue", t)}
            shown={items.length}
            total={allItems.length}
          />
          <div className={`flex items-center ${GAP_WITHIN}`}>
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
          <div className={`flex items-center ${GAP_WITHIN}`}>
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

      {/* a menu invoked ON a selected row speaks for the whole selection,
          pluralized — the Finder/Spotify convention; on an unselected row
          it stays that row's menu */}
      {rowMenu &&
        (rowMenu.item.id != null && selected.has(rowMenu.item.id) && selected.size > 1 ? (
          <RowMenu
            title={`${selected.size} tracks`}
            at={{ x: rowMenu.x, y: rowMenu.y }}
            onClose={() => setRowMenu(null)}
            items={[
              { label: "Move to top", run: () => moveSelected("top") },
              { label: "Move to bottom", run: () => moveSelected("bottom") },
              {
                label: "Add to playlist…",
                run: () => setPlaylistBatch({ x: rowMenu.x, y: rowMenu.y }),
              },
              ...(selFavs.length > 0
                ? [
                    {
                      label: selAllHearted ? "Remove from favorites" : "Add to favorites",
                      run: heartSelected,
                    },
                  ]
                : []),
              { label: "Remove from queue", run: removeSelected },
            ]}
          />
        ) : (
          <RowMenu
            title={rowMenu.item.metadata?.title ?? "Track"}
            at={{ x: rowMenu.x, y: rowMenu.y }}
            onClose={() => setRowMenu(null)}
            items={queueRowActions(rowMenu.item, {
              addToPlaylist: () =>
                setPlaylistFor({ item: rowMenu.item, x: rowMenu.x, y: rowMenu.y }),
              saveToPreset: () => setPresetFor({ item: rowMenu.item, x: rowMenu.x, y: rowMenu.y }),
            })}
          />
        ))}
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
          label={`${(playlistBatch.ids ?? [...selected]).length} tracks`}
          at={playlistBatch}
          onClose={() => setPlaylistBatch(null)}
          resolve={() => {
            const chosen = new Set(playlistBatch.ids ?? [...selected]);
            // content identity, resolved fresh on activation (the per-row rule)
            const refs = items.flatMap((it) =>
              it.id != null && chosen.has(it.id) ? [fromQueueItem(it)] : [],
            );
            setSelected(new Set());
            return Promise.resolve(refs.flatMap((r) => (r != null ? [refToPlaylistItem(r)] : [])));
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

      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          onClear={() => setSelected(new Set())}
          className="bottom-4 inset-x-6 z-30"
        >
          <SelectionVerb icon={<ArrowUpToLine size={13} />} onClick={() => moveSelected("top")}>
            Move to top
          </SelectionVerb>
          <SelectionVerb
            icon={<ArrowDownToLine size={13} />}
            onClick={() => moveSelected("bottom")}
          >
            Move to bottom
          </SelectionVerb>
          <SelectionVerb
            icon={<ListPlus size={13} />}
            onClick={(e) => setPlaylistBatch({ x: e.clientX, y: e.clientY })}
          >
            Add to playlist…
          </SelectionVerb>
          {selFavs.length > 0 && (
            <SelectionVerb
              icon={<Heart size={13} fill={selAllHearted ? "currentColor" : "none"} />}
              onClick={heartSelected}
            >
              {selAllHearted ? "Remove from favorites" : "Add to favorites"}
            </SelectionVerb>
          )}
          <SelectionVerb destructive icon={<X size={13} />} onClick={removeSelected}>
            Remove from queue
          </SelectionVerb>
        </SelectionBar>
      )}

      {/* rows: pt-1 keeps the current ring unclipped; cards: pt-2 gives the
          hover grow + glow ring headroom on the top row */}
      <div
        ref={(el) => {
          scrollRef(el);
          scrollElRef.current = el;
        }}
        className={cx(
          // overflow-anchor off: Chromium's scroll anchoring re-adjusts scrollTop
          // when rows reorder above the viewport, dragging the Move-to-bottom
          // jump back up — this list manages its own scrolling
          "flex-1 overflow-y-auto [overflow-anchor:none]",
          // the albums view separates by its header surface, not by rules —
          // dividers would double the boundary the veil bar already draws
          cards ? "px-8 pt-2" : albums ? "px-6 pt-1" : "px-6 pt-1 divide-y divide-edge/50",
          // the floating bar overlaps the last rows at full scroll — selection
          // mode adds scroll-room below the content so every row can clear it
          selected.size > 0 ? "pb-28" : cards ? "pb-8" : "pb-6",
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
          onDragMove={onDragMove}
          onDragCancel={onDragCancel}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={items.map((i) => i.id as number)}
            strategy={cards ? rectSortingStrategy : verticalListSortingStrategy}
          >
            {albums ? (
              <QueueAlbumGroups
                items={items}
                playId={playId}
                drFor={drFor}
                sourceActive={queueSourceActive}
                currentRef={currentRef}
                selectedIds={selected}
                menuId={rowMenu?.item.id ?? null}
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
                {items.map((item) => (
                  <QueueCard key={item.id} {...rowProps(item)} />
                ))}
              </div>
            ) : (
              <>
                {leanRows && leanRange[0] > 0 && (
                  <div data-lean-spacer="top" style={{ height: leanWin.padTop }} />
                )}
                {items.slice(leanRange[0], leanRange[1] + 1).map((item, k) => {
                  const idx = leanRange[0] + k;
                  const prev = items[idx - 1];
                  const next = items[idx + 1];
                  return (
                    <QueueRow
                      key={item.id}
                      {...rowProps(item)}
                      dr={drFor(item)}
                      selStart={!(prev?.id != null && selected.has(prev.id))}
                      selEnd={!(next?.id != null && selected.has(next.id))}
                      bodyDrag={selected.size > 0}
                    />
                  );
                })}
                {leanRows && leanRange[1] < items.length - 1 && (
                  <div data-lean-spacer="bottom" style={{ height: leanWin.padBottom }} />
                )}
              </>
            )}
          </SortableContext>
          {/* the batch drag's cursor chip: the active track as a stacked card
              with the count — the rows themselves never move */}
          {/* IN THE LIST the batch chip rides dnd-kit's overlay (anchored at
              the grab point, the make-room grammar); OVER THE RAIL both
              batch and single drags hand off to a cursor-anchored ghost —
              the overlay's grab offset would park the chip ON TOP of the
              target row, and the glow must stay visible (the two-state
              model, ruled with the user 2026-08-30). */}
          <DragOverlay dropAnimation={null} modifiers={[chipToCursor]}>
            {(() => {
              if (!dragBatch || navHover != null) return null;
              const md = allItems.find((it) => it.id === dragBatch.active)?.metadata;
              return (
                <DragChip
                  title={md?.title ?? md?.name ?? "—"}
                  artUrl={md?.art_url}
                  count={dragBatch.ids.length}
                />
              );
            })()}
          </DragOverlay>
          {navHover != null &&
            railPt != null &&
            (() => {
              const carried = dragBatch ?? dragSingle;
              if (!carried) return null;
              const activeId = "active" in carried ? carried.active : carried.id;
              const md = allItems.find((it) => it.id === activeId)?.metadata;
              return createPortal(
                <div
                  data-nav-drag-ghost
                  className="pointer-events-none fixed z-50"
                  style={clampChipPos(railPt.x, railPt.y)}
                >
                  <DragChip
                    title={md?.title ?? md?.name ?? "—"}
                    artUrl={md?.art_url}
                    count={"ids" in carried ? carried.ids.length : 1}
                  />
                </div>,
                document.body,
              );
            })()}
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
  menuId,
  onRowClick,
  onGroupModClick,
  drFor,
}: {
  items: QueueListItem[];
  playId: number | null;
  /** The screen's known-DR lookup (a reserved cell once the queue knows any). */
  drFor: (i: QueueListItem) => number | null | undefined;
  sourceActive: boolean;
  /** The row whose ⋯ menu is open holds its hover treatment. */
  menuId: number | null;
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
    snapQueueRows();
    for (const i of g.items) if (i.id != null) void tt.command({ type: "queueDelete", id: i.id });
    // One closure, two entry points — sequential, ascending positions, each
    // restore arming the FLIP (the batch-remove pattern exactly).
    const undoId = useStore
      .getState()
      .pushUndo(
        g.album != null ? `Remove “${g.album}”` : `Remove ${g.items.length} Tracks`,
        async () => {
          for (const s of saved) {
            snapQueueRows();
            await restoreToQueue(s.content, s.position);
          }
        },
      );
    useStore.getState().showToast({
      kind: "success",
      text: `Removed ${g.items.length} ${g.items.length === 1 ? "track" : "tracks"} from “${g.album}”`,
      action: { label: "Undo", undo: () => useStore.getState().runUndo(undoId) },
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
              dr={drFor(item)}
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
              const prev = g.items[i - 1];
              const next = g.items[i + 1];
              const runStart = !(prev?.id != null && selectedIds.has(prev.id));
              const runEnd = !(next?.id != null && selectedIds.has(next.id));
              return (
                <div
                  key={item.id}
                  ref={isCurrent ? currentRef : undefined}
                  className={cx(
                    "group relative grid grid-cols-[44px_1fr_auto] items-center gap-3 rounded-lg py-1 pl-2 pr-2",
                    "cursor-default transition-colors",
                    isCurrent && sourceActive && "row-playing bg-gold/10",
                    isCurrent &&
                      !sourceActive &&
                      !isSelected &&
                      "ring-1 ring-edge2 bg-veil/60 hover:bg-veil",
                    !isCurrent && !isSelected && (item.id === menuId ? "bg-veil" : "hover:bg-veil"),
                    isSelected && "bg-veil2",
                    isSelected && !runStart && "rounded-t-none",
                    isSelected && !runEnd && "rounded-b-none",
                  )}
                  onClick={(e) => {
                    if (onRowClick(item, e)) return;
                    if (item.id != null) void tt.command({ type: "playQueueId", queueId: item.id });
                  }}
                  onContextMenu={(e) => onMenu(item, e)}
                >
                  {isSelected && (
                    <span
                      aria-hidden
                      data-sel-run
                      className={cx(
                        "pointer-events-none absolute inset-0 rounded-[inherit] border-edge2",
                        runStart && runEnd
                          ? "border"
                          : runStart
                            ? "border-x border-t"
                            : runEnd
                              ? "border-x border-b"
                              : "border-x",
                      )}
                    />
                  )}
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
  snapQueueRows();
  void tt.command({ type: "queueDelete", id: item.id });
  // No title, no content identity, nothing to find it by later — so no offer.
  // (Same rule as the row's heart: see queueItemFavorite.)
  if (!title) return;
  const undoId = useStore.getState().pushUndo(`Remove “${title}”`, () => {
    snapQueueRows();
    void restoreToQueue({ title, artist: md?.artist ?? null, album: md?.album ?? null }, position);
  });
  useStore.getState().showToast({
    kind: "success",
    text: `Removed “${title}”`,
    action: { label: "Undo", undo: () => useStore.getState().runUndo(undoId) },
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
    result = { status: "failed" };
  }
  if (result.status === "ok") {
    if (result.id != null) armArrivalWash(result.id, position);
    return;
  }
  showToast({
    kind: "error",
    text:
      result.status === "not-found"
        ? `Couldn't find “${ref.title}” to put back`
        : `Couldn't put “${ref.title}” back`,
  });
}

/**
 * The exact inverse of a reorder: put the queue back in `prev` order, by
 * SEQUENCED moves against the live queue (the multi-select law — parallel
 * posts split blocks on the device). Best-effort like every inverse here:
 * ids that left the queue are skipped, ids that arrived keep their spots.
 */
async function restoreQueueOrder(prev: number[]): Promise<void> {
  const snap = await tt.getSnapshot();
  const liveIds = (snap.queue?.items ?? []).flatMap((i) => (i.id != null ? [i.id] : []));
  const live = new Set(liveIds);
  const target = prev.filter((id) => live.has(id));
  const work = [...liveIds];
  snapQueueRows();
  for (let k = 0; k < target.length; k++) {
    const id = target[k];
    const from = work.indexOf(id);
    if (from === k) continue;
    work.splice(from, 1);
    work.splice(k, 0, id);
    await tt.command({ type: "queueMove", id, from, to: k });
  }
}

/**
 * Anchor the drag chip to the CURSOR (+14, +10), not the grabbed row's rect:
 * dnd-kit places an overlay at the dragged node's rect plus the delta, so
 * grabbing a row's far side parked the 320px chip far from the pointer —
 * and the rail ghost uses the same +14/+10, so crossing onto the rail never
 * makes the chip jump (user, 2026-08-30).
 */
const chipToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (draggingNodeRect == null || !(activatorEvent instanceof MouseEvent)) return transform;
  // The cursor's live position in viewport space, then clamped so the chip
  // never clips at the window's edge (clampChipPos, shared with the ghosts).
  const cursorX =
    draggingNodeRect.left + (activatorEvent.clientX - draggingNodeRect.left) + transform.x;
  const cursorY =
    draggingNodeRect.top + (activatorEvent.clientY - draggingNodeRect.top) + transform.y;
  const pos = clampChipPos(cursorX, cursorY);
  return {
    ...transform,
    x: pos.left - draggingNodeRect.left,
    y: pos.top - draggingNodeRect.top,
  };
};

/** Rows an undo just put back: the queue id each landed under → the slot it
 *  was restored to. A restore is an append at the tail plus a move into
 *  place — TWO announces — and washing on "row just appeared" lit the tail
 *  off-screen instead of the landing (user, 2026-08-28: three tracks came
 *  back, one brief wash). The wash instead fires when the queue shows the id
 *  AT its restored position, from whichever side wins the announce-vs-IPC
 *  race; entries expire quietly (a filtered view may never render the row). */
const pendingWash = new Map<number, { position: number; until: number }>();
function armArrivalWash(id: number, position: number): void {
  pendingWash.set(id, { position, until: Date.now() + 15000 });
  // the landing announce may already have been processed before the
  // restore's IPC round-trip resolved — sweep now, not only on the next
  // queue change
  requestAnimationFrame(() => washArrivals());
}
let lastQueueItems: QueueListItem[] = [];
function washArrivals(): void {
  if (pendingWash.size === 0) return;
  const at = new Map<number, number>();
  lastQueueItems.forEach((it, i) => {
    if (it.id != null) at.set(it.id, it.position ?? i);
  });
  for (const [id, w] of pendingWash) {
    if (w.until < Date.now()) {
      pendingWash.delete(id);
      continue;
    }
    if (at.get(id) !== w.position) continue;
    const el = document.querySelector<HTMLElement>(`[data-queue-id="${id}"]`);
    if (!el) continue;
    pendingWash.delete(id);
    flashTarget(el); // the arrival wash, one home (lib/scroll)
  }
}

/** The FLIP snapshot lives at module scope so the album-grouped view's
 *  remove/undo (a child component in this file) can arm it too: every row's
 *  rect, captured just before a queue mutation, consumed by the screen's
 *  layout effect when the new order commits. */
let flipSnap: Map<number, { x: number; y: number }> | null = null;
function snapQueueRows(): void {
  const m = new Map<number, { x: number; y: number }>();
  document.querySelectorAll<HTMLElement>("[data-queue-id]").forEach((el) => {
    const r = el.getBoundingClientRect();
    m.set(Number(el.dataset.queueId), { x: r.left, y: r.top });
  });
  flipSnap = m;
}

interface QueueItemProps {
  /** A known TT-DR (undefined = the queue knows none yet, no cell). */
  dr?: number | null;
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
  /** A batch drag is running: rows hold still (no make-room transforms, no
   *  in-place drag styling) — the DragOverlay chip carries the story. */
  staticDrag?: boolean;
  /** Contiguous-selection run edges: a run draws ONE border, so a row whose
   *  neighbor is also selected drops the shared side (rows only — the card
   *  grid has gaps, so its rings never overlap). */
  selStart?: boolean;
  selEnd?: boolean;
  /** The gold insertion line — where the block will land on release. */
  insertLine?: "before" | "after";
  /** This row's ⋯ menu is open — hold the hover treatment (the Library's
   *  menuNodeId rule; losing it read as the row deselecting itself). */
  menuOpen?: boolean;
  /** While a selection exists the whole row body drags (selection mode
   *  suspends click-to-play, so the body is free — the Photos rule); with
   *  no selection the grip stays the one drag affordance, keeping sloppy
   *  clicks from reordering. Listeners only, never dnd attributes, on a
   *  container that holds other controls (the useShortcuts law). */
  bodyDrag?: boolean;
  /** A queue drag is live: rows take no pointer events, so hover fills,
   *  card grows and hover-revealed buttons stay dark under a passing drag
   *  — mid-drag the line and the drop targets are the only affordances
   *  (the nav rail's rule, applied at home; user, 2026-08-30). dnd-kit is
   *  unaffected: its tracking is window-level and rect-based. */
  dragLive?: boolean;
}

/**
 * A LARGE queue (2026-09-04: a mis-aimed Play from here queued 2,528 tracks
 * and the screen crawled — 83k DOM nodes, ~100ms of layout and paint per
 * hover, 8s before the rows appeared). Above this size every row and card
 * off-screen skips style, layout and paint (content-visibility: auto) while
 * staying in the DOM, so refs, drag geometry and the current-row scroll keep
 * working unchanged. Ordinary queues render exactly as before.
 */
const LEAN_QUEUE = 200;
/** Rows rendered beyond each edge of the viewport (rows layout, lean mode). */
const LEAN_OVERSCAN = 12;
/** The row's settled height, so skipped rows keep the scroll height honest. */
// the placeholder is the CONTENT box: a row is 53px with 12px of padding and a
// 1px ring, so 40px here makes a skipped row measure the same as a laid-out one
// (56 made it 69, and the windowing hook read that as the pitch — 2026-09-05)
const LEAN_ROW = "[content-visibility:auto] [contain-intrinsic-size:auto_40px]";
const LEAN_CARD = "[content-visibility:auto] [contain-intrinsic-size:auto_220px]";
const useLeanQueue = (): boolean => useStore((s) => (s.queue?.total ?? 0) > LEAN_QUEUE);

function QueueRow({
  item,
  isCurrent,
  sourceActive,
  currentRef,
  onMenu,
  selected = false,
  onRowClick,
  staticDrag = false,
  insertLine,
  selStart = true,
  selEnd = true,
  bodyDrag = false,
  menuOpen = false,
  dragLive = false,
  dr,
}: QueueItemProps): React.JSX.Element {
  const lean = useLeanQueue();
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
      style={
        staticDrag
          ? undefined
          : { transform: CSS.Transform.toString(lockVertical(transform)), transition }
      }
      data-queue-id={item.id}
      data-queue-current={isCurrent || undefined}
      data-selected={selected || undefined}
      {...(bodyDrag ? listeners : {})}
      className={cx(
        "group relative grid items-center gap-3 rounded-lg px-2 py-1.5",
        lean && LEAN_ROW,
        // the DR cell is a sixth column only while it renders: an empty auto
        // column would still cost a gap and inset the duration
        dr !== undefined
          ? "grid-cols-[26px_44px_1fr_auto_auto_auto]"
          : "grid-cols-[26px_44px_1fr_auto_auto]",
        dragLive && "pointer-events-none",
        // a selected row carries the block, and says so (the grip's cursor)
        bodyDrag && selected ? "cursor-grab active:cursor-grabbing" : "cursor-default",
        "transition-colors",
        isDragging && !staticDrag && "z-10 bg-raised shadow-xl",
        // current + queue audible: full playing treatment; current while another
        // source plays: just the parked resume point, quietly set apart
        isCurrent && sourceActive && "row-playing bg-gold/10",
        isCurrent && !sourceActive && !selected && "ring-1 ring-edge2 bg-veil/60 hover:bg-veil",
        !isCurrent && !selected && (menuOpen ? "bg-veil" : "hover:bg-veil"),
        // a contiguous run reads as ONE block: the fill continues and the
        // border is drawn by the data-sel-run span on the run's outer
        // boundary only (overlapping per-row rings doubled up and read
        // brighter between neighbors — user, 2026-08-27)
        selected && "bg-veil2",
        selected && !selStart && "rounded-t-none",
        selected && !selEnd && "rounded-b-none",
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
      {selected && (
        <span
          aria-hidden
          data-sel-run
          className={cx(
            "pointer-events-none absolute inset-0 rounded-[inherit] border-edge2",
            selStart && selEnd
              ? "border"
              : selStart
                ? "border-x border-t"
                : selEnd
                  ? "border-x border-b"
                  : "border-x",
          )}
        />
      )}
      {insertLine && (
        <span
          aria-hidden
          data-insert-line
          className={cx(
            "absolute inset-x-1 z-20 h-[2px] rounded-full bg-gold shadow-[0_0_6px_rgb(var(--gold-rgb)_/_0.6)]",
            insertLine === "before" ? "-top-px" : "-bottom-px",
          )}
        />
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
          <NameLine artist={artist} album={md?.album} ref={ref} />
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
      {dr !== undefined && (
        <span className="flex w-12 shrink-0 justify-end font-mono text-[10.5px]" data-track-dr>
          {dr != null && <DrBadge dr={dr} className="" />}
        </span>
      )}
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
  staticDrag = false,
  insertLine,
  menuOpen = false,
  dragLive = false,
}: QueueItemProps): React.JSX.Element {
  const leanCard = useLeanQueue();
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
      data-queue-id={item.id}
      data-queue-current={isCurrent || undefined}
      data-selected={selected || undefined}
      style={staticDrag ? undefined : { transform: CSS.Transform.toString(transform), transition }}
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
        leanCard && LEAN_CARD,
        dragLive && "pointer-events-none",
        isDragging && !staticDrag && "z-10 opacity-90",
        menuOpen && "z-10 motion-safe:scale-[1.04]",
        isCurrent && sourceActive
          ? "bg-goldtile/70 tile-playing"
          : isCurrent
            ? "bg-veil/60 ring-1 ring-edge2 card-hover-glow"
            : selected
              ? "bg-veil2 ring-1 ring-edge2 card-hover-glow"
              : "bg-raised/50 ring-1 ring-edge card-hover-glow",
      )}
    >
      {insertLine && (
        <span
          aria-hidden
          data-insert-line
          className={cx(
            "absolute inset-y-2 z-20 w-[2px] rounded-full bg-gold shadow-[0_0_6px_rgb(var(--gold-rgb)_/_0.6)]",
            insertLine === "before" ? "-left-[3px]" : "-right-[3px]",
          )}
        />
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
            src={artSrc(md?.art_url, 240)}
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
            className={cx(
              "absolute bottom-1.5 right-1.5 z-10 h-8 w-8 rounded-lg bg-panel/80 ring-1 ring-edge text-dim hover:text-ink flex items-center justify-center transition-all",
              menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          >
            <MoreHorizontal size={15} />
          </span>

          {isCurrent && (
            <span className="absolute top-1.5 left-1.5 flex items-center rounded-lg bg-panel/80 ring-1 ring-edge px-1.5 h-7">
              <Eqbars dim={!sourceActive} />
            </span>
          )}

          {/* selection is a STATUS on the art (the card-chip grammar): the
              ring alone whispered under the artwork and moved selections
              were kept without anyone noticing (user, 2026-08-28) */}
          {selected && (
            <span
              data-sel-check
              className="absolute top-1.5 right-1.5 z-10 h-6 w-6 rounded-full bg-gold text-bg flex items-center justify-center shadow-lg"
            >
              <Check size={13} strokeWidth={3} />
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
            removeFromQueue(item);
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
