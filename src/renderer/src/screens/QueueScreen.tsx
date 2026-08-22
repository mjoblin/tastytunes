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
import { presetVolumeKey, type ScreenLayout } from "@shared/model";
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
import { saveRefToPreset } from "@/lib/mediaActions";
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
  const [saveOpen, setSaveOpen] = useState(false);
  const clearConfirm = useConfirmPopover();
  // Follow-current does its own scrolling on entry; otherwise restore the
  // previous position.
  const scrollRef = useScrollMemory("queue", !followQueue);

  const setFollowQueue = async (follow: boolean): Promise<void> => {
    await saveSettings({ followQueue: follow });
  };
  const setLayout = async (queueLayout: ScreenLayout): Promise<void> => {
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

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const from = items[oldIndex].position ?? oldIndex;
    const to = items[newIndex].position ?? newIndex;
    // Optimistic reorder; the streamer re-announces the authoritative queue.
    setQueueItems(arrayMove(items, oldIndex, newIndex));
    void tt.command({ type: "queueMove", id: active.id as number, from, to });
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
    <div className="h-full flex flex-col">
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
              data-tip={cards ? "View as rows" : "View as cards"}
              aria-label={cards ? "View as rows" : "View as cards"}
              onClick={() => void setLayout(cards ? "rows" : "cards")}
              className="no-drag tip-bottom p-2 motion-safe:active:scale-90"
            >
              {cards ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
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
          resolve={async () => {
            // a queue id belongs to THIS queue, not to the library — content
            // is the identity, resolved fresh on activation
            const ref = fromQueueItem(playlistFor.item);
            return ref ? [refToPlaylistItem(ref)] : [];
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

      {/* rows: pt-1 keeps the current ring unclipped; cards: pt-2 gives the
          hover grow + glow ring headroom on the top row */}
      <div
        ref={scrollRef}
        className={cx(
          "flex-1 overflow-y-auto",
          cards ? "px-8 pb-8 pt-2" : "px-6 pb-6 pt-1 divide-y divide-edge/50",
        )}
      >
        {items.length === 0 && (
          <div className="text-[15px] text-faint pt-6 px-2">No matches for “{filter}”</div>
        )}
        {/* Reordering a partial list is ambiguous — drags are inert while filtered. */}
        <DndContext
          sensors={filter ? [] : sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={items.map((i) => i.id as number)}
            strategy={cards ? rectSortingStrategy : verticalListSortingStrategy}
          >
            {cards ? (
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
                  />
                ))}
              </div>
            ) : (
              items.map((item) => (
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

interface QueueItemProps {
  onMenu?(e: React.MouseEvent): void;
  item: QueueListItem;
  isCurrent: boolean;
  /** The queue's own source (MEDIA_PLAYER) is what's audible right now. */
  sourceActive: boolean;
  currentRef?: React.MutableRefObject<HTMLDivElement | null>;
}

function QueueRow({
  item,
  isCurrent,
  sourceActive,
  currentRef,
  onMenu,
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
        "group grid grid-cols-[26px_44px_1fr_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5",
        "cursor-default transition-colors",
        isDragging && "z-10 bg-raised shadow-xl",
        // current + queue audible: full playing treatment; current while another
        // source plays: just the parked resume point, quietly set apart
        isCurrent && sourceActive && "row-playing bg-gold/10",
        isCurrent && !sourceActive && "ring-1 ring-edge2 bg-veil/60 hover:bg-veil",
        !isCurrent && "hover:bg-veil",
      )}
      onClick={() => {
        if (item.id != null) void tt.command({ type: "playQueueId", queueId: item.id });
      }}
      onContextMenu={(e) => {
        // right-click = the ⋯, the app-wide rule (favorites established it)
        e.preventDefault();
        onMenu?.(e);
      }}
    >
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
        "group text-left rounded-2xl p-2 pb-2.5 transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]",
        isDragging && "z-10 opacity-90",
        isCurrent && sourceActive
          ? "bg-goldtile/70 tile-playing"
          : isCurrent
            ? "bg-veil/60 ring-1 ring-edge2 card-hover-glow"
            : "bg-raised/70 ring-1 ring-edge card-hover-glow",
      )}
    >
      <button
        className="relative block w-full cursor-pointer"
        onClick={() => {
          if (item.id != null) void tt.command({ type: "playQueueId", queueId: item.id });
        }}
      >
        <div className="aspect-square w-full rounded-lg overflow-hidden bg-panel/70 flex items-center justify-center">
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
    searchFrom: { screen: "queue" },
    extra: remove,
  });
}
