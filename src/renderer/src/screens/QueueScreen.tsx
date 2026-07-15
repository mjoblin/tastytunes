import { useEffect, useRef } from 'react'
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
import {
  Crosshair,
  Disc3,
  Footprints,
  GripVertical,
  LayoutGrid,
  ListMusic,
  Play,
  Rows3,
  X
} from 'lucide-react'
import type { QueueListItem } from '@shared/smoip'
import type { ScreenLayout } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { flashTarget, scrollToWithContext } from '@/lib/scroll'
import { cx, fmtTime } from '@/lib/format'

export function QueueScreen(): React.JSX.Element {
  const queue = useStore((s) => s.queue)
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const zoneState = useStore((s) => s.zoneState)
  const { followQueue, queueLayout, presetCardSize, presetGap, presetFillRows } = useStore(
    (s) => s.settings
  )
  const setSettings = useStore((s) => s.setSettings)
  const setQueueItems = useStore((s) => s.setQueueItems)
  const cards = queueLayout === 'cards'
  // Follow-current does its own scrolling on entry; otherwise restore the
  // previous position.
  const scrollRef = useScrollMemory('queue', !followQueue)

  const setFollowQueue = async (follow: boolean): Promise<void> => {
    setSettings(await tt.setSettings({ followQueue: follow }))
  }
  const setLayout = async (queueLayout: ScreenLayout): Promise<void> => {
    setSettings(await tt.setSettings({ queueLayout }))
  }
  // Cards get half a card of context above the target; rows get a full row.
  const scrollToCurrent = (): void => {
    scrollToWithContext(currentRef.current, cards ? presetGap : 8, cards ? 0.5 : 1)
    flashTarget(currentRef.current)
  }

  const items = (queue?.items ?? []).filter((i) => i.id != null)
  const playId = queue?.play_id ?? playState?.queue_id ?? null
  const playing = playState?.state === 'play'
  // The queue belongs to the MEDIA_PLAYER source. When another source is
  // active (AirPlay, radio, …) the device still reports a play_id — that row
  // is just where the queue is parked, and must not claim to be playing.
  const queueSourceActive = (nowPlaying?.source?.id ?? zoneState?.source) === 'MEDIA_PLAYER'

  const totalSecs = items.reduce((acc, i) => acc + (i.metadata?.duration ?? 0), 0)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const currentRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (followQueue && currentRef.current) {
      scrollToWithContext(currentRef.current, cards ? presetGap : 8, cards ? 0.5 : 1)
    }
  }, [playId, followQueue, cards, presetGap])

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

  if (items.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-8">
        <ListMusic size={56} strokeWidth={1} className="text-faint/50" />
        <div className="font-display text-2xl text-dim">Queue is empty</div>
        <div className="text-[13px] text-faint max-w-sm">
          Queue tracks from the StreamMagic app or another controller — they'll show up here.
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <h1 className="font-display font-bold text-[26px] tracking-tight">Queue</h1>
        <span className="font-mono text-[11px] text-faint">
          {items.length} tracks · {fmtTime(totalSecs)}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <button
            data-tip={cards ? 'View as rows' : 'View as cards'}
            aria-label={cards ? 'View as rows' : 'View as cards'}
            onClick={() => void setLayout(cards ? 'rows' : 'cards')}
            className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 active:scale-90 transition-all"
          >
            {cards ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
          </button>
          <button
            data-tip="Scroll to the current track"
            aria-label="Scroll to the current track"
            onClick={scrollToCurrent}
            className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 active:scale-90 transition-all"
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
      </header>

      {/* rows: pt-1 keeps the current ring unclipped; cards: pt-2 gives the
          hover grow + glow ring headroom on the top row */}
      <div ref={scrollRef} className={cx('flex-1 overflow-y-auto', cards ? 'px-8 pb-8 pt-2' : 'px-6 pb-6 pt-1')}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
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

interface QueueItemProps {
  item: QueueListItem
  isCurrent: boolean
  playing: boolean
  /** The queue's own source (MEDIA_PLAYER) is what's audible right now. */
  sourceActive: boolean
  currentRef?: React.MutableRefObject<HTMLDivElement | null>
}

function Eqbars({ playing, sourceActive }: { playing: boolean; sourceActive: boolean }): React.JSX.Element {
  return (
    <span
      className={cx(
        'eqbars',
        sourceActive ? 'text-gold' : 'text-faint',
        (!playing || !sourceActive) && 'paused'
      )}
    >
      <span style={{ height: 6 }} />
      <span style={{ height: 10 }} />
      <span style={{ height: 5 }} />
    </span>
  )
}

function QueueRow({ item, isCurrent, playing, sourceActive, currentRef }: QueueItemProps): React.JSX.Element {
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
      className={cx(
        'group grid grid-cols-[26px_44px_1fr_auto_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5',
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
      <div className="flex items-center justify-center">
        {isCurrent ? (
          <Eqbars playing={playing} sourceActive={sourceActive} />
        ) : (
          <span className="font-mono text-[10.5px] text-faint tabular-nums">
            {(item.position ?? 0) + 1}
          </span>
        )}
      </div>

      <div className="h-10 w-10 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        {md?.art_url ? (
          <img src={md.art_url} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <Disc3 size={16} className="text-faint" />
        )}
      </div>

      <div className="min-w-0">
        <div className={cx('text-[13.5px] truncate', isCurrent && sourceActive ? 'text-gold' : 'text-ink')}>
          {md?.title ?? md?.name ?? '—'}
        </div>
        <div className="text-[12px] text-dim truncate">
          {[md?.artist, md?.album].filter(Boolean).join(' — ')}
        </div>
      </div>

      <span className="font-mono text-[11px] text-faint tabular-nums">
        {fmtTime(md?.duration)}
      </span>

      <button
        title="Remove from queue"
        onClick={(e) => {
          e.stopPropagation()
          if (item.id != null) void tt.command({ type: 'queueDelete', id: item.id })
        }}
        className="p-1.5 rounded text-faint opacity-0 group-hover:opacity-100 hover:text-alert transition-all"
      >
        <X size={14} />
      </button>

      <button
        title="Drag to reorder"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="p-1 rounded text-faint opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </button>
    </div>
  )
}

/** Card view of a queue track — mirrors PresetCard's inset-tile anatomy. */
function QueueCard({ item, isCurrent, playing, sourceActive, currentRef }: QueueItemProps): React.JSX.Element {
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
        'group text-left rounded-2xl p-2 pb-2.5 transition-all duration-200 ease-out hover:z-10 hover:scale-[1.04]',
        isDragging && 'z-10 opacity-90',
        isCurrent && sourceActive
          ? 'bg-goldtile/70 tile-playing'
          : isCurrent
            ? 'bg-veil/60 ring-1 ring-edge2 card-hover-glow'
            : 'bg-raised/70 ring-1 ring-edge card-hover-glow'
      )}
    >
      <button
        className="relative block w-full cursor-pointer"
        onClick={() => {
          if (item.id != null) void tt.command({ type: 'playQueueId', queueId: item.id })
        }}
      >
        <div className="aspect-square w-full rounded-lg overflow-hidden bg-panel/70 flex items-center justify-center">
          {md?.art_url ? (
            <img src={md.art_url} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <Disc3 size={34} strokeWidth={1.2} className="text-faint" />
          )}

          <div className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <span
              className="h-11 w-11 rounded-full bg-amber text-bg flex items-center justify-center
                         transition-all duration-150 hover:scale-110
                         hover:shadow-[0_0_24px_rgb(var(--amber-rgb)_/_0.6)]"
            >
              <Play size={18} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />
            </span>
          </div>

          {isCurrent && (
            <span className="absolute top-2 left-2 flex items-center rounded-md bg-black/55 backdrop-blur-sm px-1.5 py-1">
              <Eqbars playing={playing} sourceActive={sourceActive} />
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
          title="Remove from queue"
          onPointerDown={(e) => e.stopPropagation() /* keep dnd-kit's drag sensor out of it */}
          onClick={(e) => {
            e.stopPropagation()
            if (item.id != null) void tt.command({ type: 'queueDelete', id: item.id })
          }}
          className="p-1 rounded text-faint opacity-0 group-hover:opacity-100 hover:text-alert transition-all"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
