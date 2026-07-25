import { useEffect, useRef, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { BookmarkPlus, Crosshair, Disc3, Footprints, LayoutGrid, ListMusic, ListOrdered, MoreHorizontal, Play, Rows3, X } from 'lucide-react'
import { queueContentHash, type QueueListItem } from '@shared/smoip'
import {
  favoriteKey,
  presetVolumeKey,
  type ContentRef,
  type Favorite,
  type FavoriteMedia,
  type QueueRestoreResult,
  type ScreenLayout
} from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { Eqbars } from '@/components/Eqbars'
import { EmptyState } from '@/components/EmptyState'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { flashTarget, scrollToWithContext } from '@/lib/scroll'
import { lockVertical } from '@/lib/dnd'
import { activeSourceId, cx, fmtTime, matchesFilter } from '@/lib/format'
import { toggleFavorite } from '@/lib/favorites'
import { AddToPlaylistPanel } from '@/components/AddToPlaylistPanel'
import { RowMenu } from '@/components/RowMenu'
import { RowAction } from '@/components/RowAction'
import { RowHeart } from '@/components/RowHeart'
import { OrderHandle } from '@/components/OrderHandle'
import { ArtImage } from '@/components/ArtImage'
import { FilterInput } from '@/components/FilterInput'
import { PopoverChrome } from '@/hooks/usePopover'
import { PresetSavePanel } from '@/components/LibraryMenus'

/**
 * Queue → preset: the shared PresetSavePanel in a centered modal. The device
 * stores the whole queue as a MediaQueue preset (recallable anywhere); we also
 * record its exact track signature so the Presets screen can recognize it.
 */
function SaveQueueDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const trackCount = useStore((s) => s.queue?.items?.length ?? 0)
  const showToast = useStore((s) => s.showToast)

  const saveSettings = useStore((s) => s.saveSettings)

  const onSave = async (slot: number, name: string | null): Promise<void> => {
    // throws on failure (already toasted by the api layer) → panel stays open
    await tt.command({ type: 'queueSavePreset', slot, name })
    // Remember exactly what this slot holds (all tracks, in order) so the
    // Presets screen recognizes this queue coming back from any controller.
    const { queue, systemInfo, settings } = useStore.getState()
    if (queue?.items?.length) {
      void saveSettings({
        queueSignatures: {
          ...settings.queueSignatures,
          [presetVolumeKey(systemInfo?.udn, slot)]: queueContentHash(queue.items)
        }
      })
    }
    showToast({
      kind: 'success',
      text: `Saved “${name ?? `Queue Preset ${slot}`}” to preset ${slot}`,
      action: { label: 'View', screen: 'presets' }
    })
    onClose()
  }

  return (
    <div
      className="absolute inset-0 z-30 bg-black/60 backdrop-blur-sm flex items-center justify-center"
      onClick={onClose}
    >
      <PopoverChrome onClose={onClose} />
      <div
        className="w-[360px] rounded-2xl bg-panel ring-1 ring-edge2 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-display font-bold text-[17px] tracking-tight mb-3">
          Save queue as preset
        </div>
        <PresetSavePanel
          title="Current queue"
          subtitle={`${trackCount} tracks — stored on the streamer`}
          nameAutoFocus
          onSave={onSave}
        />
      </div>
    </div>
  )
}

export function QueueScreen(): React.JSX.Element {
  const queue = useStore((s) => s.queue)
  const saveSettings = useStore((s) => s.saveSettings)
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const zoneState = useStore((s) => s.zoneState)
  const { followQueue, queueLayout, presetCardSize, presetGap, presetFillRows } = useStore(
    (s) => s.settings
  )
  const setQueueItems = useStore((s) => s.setQueueItems)
  const filter = useStore((s) => s.screenFilters.queue)
  const setScreenFilter = useStore((s) => s.setScreenFilter)
  const cards = queueLayout === 'cards'
  const [saveOpen, setSaveOpen] = useState(false)
  // Follow-current does its own scrolling on entry; otherwise restore the
  // previous position.
  const scrollRef = useScrollMemory('queue', !followQueue)

  const setFollowQueue = async (follow: boolean): Promise<void> => {
    await saveSettings({ followQueue: follow })
  }
  const setLayout = async (queueLayout: ScreenLayout): Promise<void> => {
    await saveSettings({ queueLayout })
  }
  // Cards get half a card of context above the target; rows get a full row.
  const scrollToCurrent = (): void => {
    scrollToWithContext(currentRef.current, cards ? presetGap : 8, cards ? 0.5 : 1)
    flashTarget(currentRef.current)
  }

  const showToast = useStore((s) => s.showToast)
  const favorites = useStore((s) => s.favorites)
  // Right-click rather than a third hover button: the row already carries
  // remove and a grip, and Favorites established right-click for exactly this
  // (a local list of tracks whose rows are already busy).
  const [rowMenu, setRowMenu] = useState<{ item: QueueListItem; x: number; y: number } | null>(null)
  const [playlistFor, setPlaylistFor] = useState<{ item: QueueListItem; x: number; y: number } | null>(
    null
  )
  const allItems = (queue?.items ?? []).filter((i) => i.id != null)

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
        title: m.title ?? 'Unknown track',
        artist: m.artist ?? null,
        album: m.album ?? null,
        artUrl: m.art_url ?? null,
        serverUdn: null,
        serverName: null,
        objectId: null,
        durationSecs: m.duration ?? null
      }))
    if (items.length === 0) return
    // Date alone collides the second time you save in a day — and two rows
    // reading "Queue — Jul 24" are indistinguishable. The time makes it unique
    // in practice AND tells you which session it was.
    const name = `Queue — ${new Date().toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })}`
    // Toast the STORED name (two saves in the same minute uniquify to "… (2)").
    const created = await tt.playlistCreate(name, items)
    showToast({
      kind: 'success',
      text: `Saved ${items.length} tracks as “${created.name}”`,
      action: { label: 'Open Playlists', screen: 'playlists' }
    })
  }
  // Filter over everything we hold, displayed or not (genre, class, source).
  const items = filter
    ? allItems.filter((i) =>
        matchesFilter(filter, [
          i.metadata?.title,
          i.metadata?.name,
          i.metadata?.artist,
          i.metadata?.album,
          i.metadata?.genre,
          i.metadata?.class,
          i.metadata?.source
        ])
      )
    : allItems
  const playId = queue?.play_id ?? playState?.queue_id ?? null
  const playing = playState?.state === 'play'
  // The queue belongs to the MEDIA_PLAYER source. When another source is
  // active (AirPlay, radio, …) the device still reports a play_id — that row
  // is just where the queue is parked, and must not claim to be playing.
  const queueSourceActive = activeSourceId(zoneState, nowPlaying) === 'MEDIA_PLAYER'

  const totalSecs = allItems.reduce((acc, i) => acc + (i.metadata?.duration ?? 0), 0)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const currentRef = useRef<HTMLDivElement | null>(null)
  // First follow after mount positions INSTANTLY — re-entering the screen
  // shouldn't replay a glide to a place you already were. The animation is
  // reserved for track changes while you're watching.
  const firstFollow = useRef(true)
  useEffect(() => {
    // Follow pauses while a filter is active — the current row may be hidden.
    if (followQueue && !filter && currentRef.current) {
      scrollToWithContext(
        currentRef.current,
        cards ? presetGap : 8,
        cards ? 0.5 : 1,
        firstFollow.current ? 'auto' : undefined
      )
    }
    firstFollow.current = false
  }, [playId, followQueue, cards, presetGap, filter])

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = items.findIndex((i) => i.id === active.id)
    const newIndex = items.findIndex((i) => i.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const from = items[oldIndex].position ?? oldIndex
    const to = items[newIndex].position ?? newIndex
    // Optimistic reorder; the streamer re-announces the authoritative queue.
    setQueueItems(arrayMove(items, oldIndex, newIndex))
    void tt.command({ type: 'queueMove', id: active.id as number, from, to })
  }

  if (allItems.length === 0) {
    return (
      <EmptyState
        className="h-full"
        icon={ListMusic}
        title="Queue is empty"
        caption="Queue tracks from the StreamMagic app or another controller — they'll show up here."
      />
    )
  }

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <h1 className="font-display screen-title font-bold text-[26px] tracking-tight">Queue</h1>
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
              onChange={(t) => setScreenFilter('queue', t)}
              shown={items.length}
              total={allItems.length}
            />
            <button
              data-tip="Save queue as a playlist"
              aria-label="Save queue as a playlist"
              onClick={() => void saveAsPlaylist()}
              disabled={allItems.length === 0}
              className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 disabled:opacity-40 motion-safe:active:scale-90 transition-all"
            >
              <ListOrdered size={16} />
            </button>
            <button
              data-tip="Save queue as preset"
              aria-label="Save queue as preset"
              onClick={() => setSaveOpen(true)}
              className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
            >
              <BookmarkPlus size={16} />
            </button>
          </div>
          <div className="flex items-center gap-1.5">
          <button
              data-tip={cards ? 'View as rows' : 'View as cards'}
              aria-label={cards ? 'View as rows' : 'View as cards'}
              onClick={() => void setLayout(cards ? 'rows' : 'cards')}
              className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
            >
              {cards ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
            </button>
            <button
              data-tip="Scroll to the current track"
              aria-label="Scroll to the current track"
              onClick={scrollToCurrent}
              className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
            >
              <Crosshair size={16} />
            </button>
            <button
              data-tip={followQueue ? 'Auto-follow: on' : 'Auto-follow: off'}
              aria-label={followQueue ? 'Auto-follow: on' : 'Auto-follow: off'}
              onClick={() => void setFollowQueue(!followQueue)}
              className={cx(
                'no-drag tip-bottom p-2 rounded-lg ring-1 transition-all',
                followQueue
                  ? 'ring-gold/50 bg-golddim text-gold'
                  : 'ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70'
              )}
            >
              <Footprints size={16} />
            </button>
          </div>
        </div>
      </header>

      {rowMenu && (
        <RowMenu
          title={rowMenu.item.metadata?.title ?? 'Track'}
          at={{ x: rowMenu.x, y: rowMenu.y }}
          onClose={() => setRowMenu(null)}
          items={queueRowActions(rowMenu.item, {
            favorites,
            addToPlaylist: () => setPlaylistFor({ item: rowMenu.item, x: rowMenu.x, y: rowMenu.y })
          })}
        />
      )}
      {playlistFor && (
        <AddToPlaylistPanel
          label={playlistFor.item.metadata?.title ?? 'this track'}
          at={{ x: playlistFor.x, y: playlistFor.y }}
          onClose={() => setPlaylistFor(null)}
          resolve={async () => {
            const md = playlistFor.item.metadata
            return md
              ? [
                  {
                    title: md.title ?? 'Unknown track',
                    artist: md.artist ?? null,
                    album: md.album ?? null,
                    artUrl: md.art_url ?? null,
                    // a queue id belongs to THIS queue, not to the library —
                    // content is the identity, resolved fresh on activation
                    serverUdn: null,
                    serverName: null,
                    objectId: null,
                    durationSecs: md.duration ?? null
                  }
                ]
              : []
          }}
        />
      )}
      {saveOpen && <SaveQueueDialog onClose={() => setSaveOpen(false)} />}

      {/* rows: pt-1 keeps the current ring unclipped; cards: pt-2 gives the
          hover grow + glow ring headroom on the top row */}
      <div ref={scrollRef} className={cx('flex-1 overflow-y-auto', cards ? 'px-8 pb-8 pt-2' : 'px-6 pb-6 pt-1 divide-y divide-edge/50')}>
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
                  gap: presetGap
                }}
              >
                {items.map((item) => (
                  <QueueCard
                    key={item.id}
                    onMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setRowMenu({ item, x: e.clientX, y: e.clientY })
                    }}
                    item={item}
                    isCurrent={item.id === playId}
                    playing={playing}
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
                    e.preventDefault()
                    e.stopPropagation()
                    setRowMenu({ item, x: e.clientX, y: e.clientY })
                  }}
                  item={item}
                  isCurrent={item.id === playId}
                  playing={playing}
                  sourceActive={queueSourceActive}
                  currentRef={item.id === playId ? currentRef : undefined}
                />
              ))
            )}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  )
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
  if (item.id == null) return
  const md = item.metadata
  const title = md?.title ?? null
  const position = item.position ?? 0
  void tt.command({ type: 'queueDelete', id: item.id })
  // No title, no content identity, nothing to find it by later — so no offer.
  // (Same rule as the row's heart: see queueItemFavorite.)
  if (!title) return
  useStore.getState().showToast({
    kind: 'success',
    text: `Removed “${title}”`,
    action: {
      label: 'Undo',
      undo: () =>
        void restoreToQueue({ title, artist: md?.artist ?? null, album: md?.album ?? null }, position)
    }
  })
}

/**
 * Success is SILENT: you're looking at the queue, and the row reappearing in
 * place is better feedback than a toast saying so. Only the ways it can fail
 * get one — a restore that quietly did nothing is the thing worth avoiding.
 */
async function restoreToQueue(ref: ContentRef, position: number): Promise<void> {
  const showToast = useStore.getState().showToast
  let result: QueueRestoreResult
  try {
    result = await tt.queueRestore(ref, position)
  } catch {
    result = 'failed'
  }
  if (result === 'ok') return
  showToast({
    kind: 'error',
    text:
      result === 'not-found'
        ? `Couldn't find “${ref.title}” to put back`
        : `Couldn't put “${ref.title}” back`
  })
}

interface QueueItemProps {
  onMenu?(e: React.MouseEvent): void
  item: QueueListItem
  isCurrent: boolean
  playing: boolean
  /** The queue's own source (MEDIA_PLAYER) is what's audible right now. */
  sourceActive: boolean
  currentRef?: React.MutableRefObject<HTMLDivElement | null>
}

function QueueRow({ item, isCurrent, playing, sourceActive, currentRef, onMenu }: QueueItemProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id as number
  })
  const md = item.metadata
  const favorites = useStore((s) => s.favorites)
  const favorite = queueItemFavorite(item)
  const hearted =
    favorite != null && favorites.some((f) => favoriteKey(f) === favoriteKey(favorite as Favorite))

  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        if (currentRef) currentRef.current = node
      }}
      style={{ transform: CSS.Transform.toString(lockVertical(transform)), transition }}
      className={cx(
        'group grid grid-cols-[26px_44px_1fr_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5',
        'cursor-default transition-colors',
        isDragging && 'z-10 bg-raised shadow-xl',
        // current + queue audible: full playing treatment; current while another
        // source plays: just the parked resume point, quietly set apart
        isCurrent && sourceActive && 'row-playing bg-gold/10',
        isCurrent && !sourceActive && 'ring-1 ring-edge2 bg-veil/60 hover:bg-veil',
        !isCurrent && 'hover:bg-veil'
      )}
      onClick={() => {
        if (item.id != null) void tt.command({ type: 'playQueueId', queueId: item.id })
      }}
    >
      <OrderHandle
        label={`Reorder ${md?.title ?? 'track'}`}
        attributes={attributes}
        listeners={listeners}
      >
        {isCurrent ? (
          <Eqbars playing={playing} dim={!sourceActive} />
        ) : (
          <span className="font-mono text-[10.5px] text-faint tabular-nums">
            {(item.position ?? 0) + 1}
          </span>
        )}
      </OrderHandle>

      <div className="h-10 w-10 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage src={md?.art_url} lazy fallback={<Disc3 size={16} className="text-faint" />} />
      </div>

      <div className="min-w-0">
        <div className={cx('text-[13.5px] truncate', isCurrent && sourceActive ? 'text-gold' : 'text-ink')}>
          {md?.title ?? md?.name ?? '—'}
        </div>
        <div className="text-[12px] text-dim truncate">
          {[md?.artist, md?.album].filter(Boolean).join(' — ')}
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
          <RowHeart favorited={hearted} held={false} onHeart={() => void toggleFavorite(favorite)} />
        )}
      </div>

      {/* Duration sits at the far right of the CONTENT, after the actions —
          it's always-visible information, so it wants a stable column, while
          the actions come and go with hover. */}
      <span className="font-mono text-[11px] text-faint tabular-nums">
        {fmtTime(md?.duration)}
      </span>
    </div>
  )
}

/** Card view of a queue track — mirrors PresetCard's inset-tile anatomy. */
function QueueCard({ item, isCurrent, playing, sourceActive, currentRef, onMenu }: QueueItemProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id as number
  })
  const md = item.metadata

  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        if (currentRef) currentRef.current = node
      }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={cx(
        // Hover grow matches PresetCard; scale is layout-free so edge-clipped
        // cards simply clip at the scrollport seam.
        'group text-left rounded-2xl p-2 pb-2.5 transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]',
        isDragging && 'z-10 opacity-90',
        isCurrent && sourceActive
          ? 'bg-goldtile/70 tile-playing'
          : isCurrent
            ? 'bg-veil/60 ring-1 ring-edge2 card-hover-glow'
            : 'bg-raised/70 ring-1 ring-edge card-hover-glow'
      )}
    >
      {/* Cards get the same visible ⋯ as the rows — an art-corner chip, the
          treatment presets already use for their hover controls. */}
      <button
        aria-label="More actions"
        onClick={(e) => {
          e.stopPropagation()
          onMenu?.(e)
        }}
        className="absolute top-3 right-3 z-10 h-7 w-7 rounded-full grid place-items-center bg-bg/70 text-dim opacity-0 group-hover:opacity-100 hover:text-ink backdrop-blur-sm transition-all"
      >
        <MoreHorizontal size={14} />
      </button>

      <button
        className="relative block w-full cursor-pointer"
        onClick={() => {
          if (item.id != null) void tt.command({ type: 'playQueueId', queueId: item.id })
        }}
      >
        <div className="aspect-square w-full rounded-lg overflow-hidden bg-panel/70 flex items-center justify-center">
          <ArtImage
            src={md?.art_url}
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

          {isCurrent && (
            <span className="absolute top-2 left-2 flex items-center rounded-md bg-black/55 backdrop-blur-sm px-1.5 py-1">
              <Eqbars playing={playing} dim={!(sourceActive)} />
            </span>
          )}
        </div>
      </button>

      <div className="mt-2 px-1 flex items-start gap-1">
        <div className="flex-1 min-w-0">
          <div
            className={cx(
              'text-[12.5px] leading-snug line-clamp-2',
              isCurrent && sourceActive ? 'text-gold' : 'text-ink'
            )}
          >
            {md?.title ?? md?.name ?? '—'}
          </div>
          <div className="text-[11px] text-dim truncate mt-0.5">
            {[md?.artist, md?.album].filter(Boolean).join(' — ')}
          </div>
          <div className="microlabel mt-1">
            {String((item.position ?? 0) + 1).padStart(2, '0')} · {fmtTime(md?.duration)}
          </div>
        </div>
        <button
          data-tip="Remove from queue"
          aria-label="Remove from queue"
          onPointerDown={(e) => e.stopPropagation() /* keep dnd-kit's drag sensor out of it */}
          onClick={(e) => {
            e.stopPropagation()
            if (item.id != null) void tt.command({ type: 'queueDelete', id: item.id })
          }}
          className="tip-bottom p-1 rounded text-faint opacity-0 group-hover:opacity-100 hover:text-alert transition-all"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}

/**
 * A queued track as a favorite — or null when it can't be one. Favorites key on
 * CONTENT, so a track with no title or no artist has no identity to store and
 * could never be found again; offering a heart there would be a lie. Shared by
 * the row's heart and its ⋯ menu so the two can't disagree.
 */
export function queueItemFavorite(item: QueueListItem): Omit<FavoriteMedia, 'addedAt'> | null {
  const md = item.metadata
  const title = md?.title ?? null
  const artist = md?.artist ?? null
  if (!title || !artist) return null
  return {
    kind: 'track',
    title,
    artist,
    album: md?.album ?? null,
    artUrl: md?.art_url ?? null,
    serverUdn: null,
    serverName: null,
    objectId: null,
    titlePath: null,
    durationSecs: md?.duration ?? null
  }
}

/**
 * What a queued track offers beyond play and remove. The queue had NO row menu
 * at all — you could hear a track, want to keep it, and have nowhere to say so
 * without going to Now Playing and waiting for it to come round.
 */
function queueRowActions(
  item: QueueListItem,
  deps: { favorites: Favorite[]; addToPlaylist: () => void }
): Array<{ label: string; run: () => void }> {
  const fav = queueItemFavorite(item)
  const hearted =
    fav != null && deps.favorites.some((f) => favoriteKey(f) === favoriteKey(fav as Favorite))

  return [
    { label: 'Add to playlist…', run: deps.addToPlaylist },
    // A track needs title AND artist to have a content identity; without one
    // it can't be re-found later, so it isn't offered.
    ...(fav
      ? [
          {
            label: hearted ? 'Remove from favorites' : 'Add to favorites',
            run: () => void toggleFavorite(fav)
          }
        ]
      : []),
    ...(item.id != null
      ? [
          {
            label: 'Remove from queue',
            run: () => removeFromQueue(item)
          }
        ]
      : [])
  ]
}
