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
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Crosshair, Disc3, Footprints, GripVertical, ListMusic, X } from 'lucide-react'
import type { QueueListItem } from '@shared/smoip'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { flashTarget, scrollToWithContext } from '@/lib/scroll'
import { cx, fmtTime } from '@/lib/format'

export function QueueScreen(): React.JSX.Element {
  const queue = useStore((s) => s.queue)
  const playState = useStore((s) => s.playState)
  const followQueue = useStore((s) => s.settings.followQueue)
  const setSettings = useStore((s) => s.setSettings)
  const setQueueItems = useStore((s) => s.setQueueItems)
  // Follow-current does its own scrolling on entry; otherwise restore the
  // previous position.
  const scrollRef = useScrollMemory('queue', !followQueue)

  const setFollowQueue = async (follow: boolean): Promise<void> => {
    setSettings(await tt.setSettings({ followQueue: follow }))
  }
  const scrollToCurrent = (): void => {
    scrollToWithContext(currentRef.current)
    flashTarget(currentRef.current)
  }

  const items = (queue?.items ?? []).filter((i) => i.id != null)
  const playId = queue?.play_id ?? playState?.queue_id ?? null
  const playing = playState?.state === 'play'

  const totalSecs = items.reduce((acc, i) => acc + (i.metadata?.duration ?? 0), 0)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const currentRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (followQueue && currentRef.current) {
      scrollToWithContext(currentRef.current)
    }
  }, [playId, followQueue])

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

      {/* pt-1 so the current row's ring isn't clipped when it's the first row */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pb-6 pt-1">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((i) => i.id as number)} strategy={verticalListSortingStrategy}>
            {items.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                isCurrent={item.id === playId}
                playing={playing}
                currentRef={item.id === playId ? currentRef : undefined}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  )
}

function QueueRow({
  item,
  isCurrent,
  playing,
  currentRef
}: {
  item: QueueListItem
  isCurrent: boolean
  playing: boolean
  currentRef?: React.MutableRefObject<HTMLDivElement | null>
}): React.JSX.Element {
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
        isCurrent ? 'row-playing bg-gold/10' : 'hover:bg-veil'
      )}
      onClick={() => {
        if (item.id != null) void tt.command({ type: 'playQueueId', queueId: item.id })
      }}
    >
      <div className="flex items-center justify-center">
        {isCurrent ? (
          <span className={cx('eqbars text-gold', !playing && 'paused')}>
            <span style={{ height: 6 }} />
            <span style={{ height: 10 }} />
            <span style={{ height: 5 }} />
          </span>
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
        <div className={cx('text-[13.5px] truncate', isCurrent ? 'text-gold' : 'text-ink')}>
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
