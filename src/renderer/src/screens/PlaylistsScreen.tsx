import { useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, ListOrdered, Pencil, Play, Trash2, X } from 'lucide-react'
import type { Playlist, PlaylistActivation, PlaylistItem } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { EmptyState } from '@/components/EmptyState'
import { FilterInput } from '@/components/FilterInput'
import { ArtImage } from '@/components/ArtImage'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { cx, fmtTime, matchesFilter } from '@/lib/format'

/**
 * Stored playlists: the collection on the left, the selected playlist's tracks
 * on the right. Activating REPLACES the streamer's queue — slow by nature (the
 * firmware takes entries one at a time), so the run reports progress and can be
 * cancelled, and a track that can no longer be found is named rather than
 * silently dropped.
 */
export function PlaylistsScreen(): React.JSX.Element {
  const playlists = useStore((s) => s.playlists)
  const activation = useStore((s) => s.playlistActivation)
  const filter = useStore((s) => s.screenFilters.playlists)
  const setScreenFilter = useStore((s) => s.setScreenFilter)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const scrollMemory = useScrollMemory('playlists')

  const shown = useMemo(
    () => playlists.filter((p) => matchesFilter(filter, [p.name])),
    [playlists, filter]
  )
  const selected = playlists.find((p) => p.id === selectedId) ?? shown[0] ?? null

  // A deleted (or filtered-away) selection must not strand the detail pane.
  useEffect(() => {
    if (selectedId && !playlists.some((p) => p.id === selectedId)) setSelectedId(null)
  }, [playlists, selectedId])

  // Pointer AND keyboard: reordering a list you can't drag is otherwise
  // impossible for anyone without a mouse.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const onDragEnd = (e: DragEndEvent): void => {
    if (!selected || !e.over || e.active.id === e.over.id) return
    const from = selected.items.findIndex((_, i) => rowId(selected, i) === e.active.id)
    const to = selected.items.findIndex((_, i) => rowId(selected, i) === e.over?.id)
    if (from < 0 || to < 0) return
    void tt.playlistSetItems(selected.id, arrayMove(selected.items, from, to))
  }

  const removeItem = (index: number): void => {
    if (!selected) return
    void tt.playlistSetItems(
      selected.id,
      selected.items.filter((_, i) => i !== index)
    )
  }

  const running = activation && !activation.finished

  return (
    <div className="h-full flex flex-col">
      <header className="px-8 pt-8 pb-4 flex items-center gap-4">
        <h1 className="font-display screen-title font-bold text-[26px] tracking-tight">Playlists</h1>
        <div className="flex-1" />
        {playlists.length > 0 && (
          <FilterInput
            value={filter}
            onChange={(v) => setScreenFilter('playlists', v)}
            shown={shown.length}
            total={playlists.length}
          />
        )}
      </header>

      {activation && (
        <ActivationBanner
          activation={activation}
          onCancel={() => void tt.playlistActivateCancel()}
        />
      )}

      {playlists.length === 0 ? (
        <EmptyState
          icon={ListOrdered}
          title="No playlists yet"
          caption="Save the queue as a playlist from the Queue screen."
        />
      ) : (
        <div className="flex-1 min-h-0 flex gap-6 px-8 pb-8">
          {/* the collection */}
          <div className="w-[280px] shrink-0 min-h-0 overflow-y-auto" ref={scrollMemory}>
            <div className="flex flex-col gap-1">
              {shown.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  aria-current={selected?.id === p.id ? 'true' : undefined}
                  className={cx(
                    'text-left rounded-lg px-3 py-2 transition-colors',
                    selected?.id === p.id ? 'bg-amberdim text-amber' : 'hover:bg-veil text-ink'
                  )}
                >
                  <div className="truncate text-[13.5px]">{p.name}</div>
                  <div className="microlabel mt-0.5">
                    {p.items.length} {p.items.length === 1 ? 'track' : 'tracks'}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* the selected playlist */}
          {selected && (
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              <div className="flex items-center gap-2 mb-3">
                {renaming === selected.id ? (
                  <RenameField
                    initial={selected.name}
                    onDone={(name) => {
                      if (name) void tt.playlistRename(selected.id, name)
                      setRenaming(null)
                    }}
                  />
                ) : (
                  <h2 className="font-display font-bold text-[19px] tracking-tight truncate">
                    {selected.name}
                  </h2>
                )}
                <div className="flex-1" />
                <button
                  onClick={() => void tt.playlistActivate(selected.id)}
                  disabled={!!running || selected.items.length === 0}
                  data-tip="Replace the queue with this playlist"
                  aria-label="Play playlist"
                  className="no-drag tip-bottom flex items-center gap-1.5 rounded-lg px-3 h-8 text-[12.5px] bg-amberdim text-amber hover:brightness-110 disabled:opacity-40 transition-all"
                >
                  <Play size={14} /> Play
                </button>
                <button
                  onClick={() => setRenaming(selected.id)}
                  data-tip="Rename"
                  aria-label="Rename playlist"
                  className="no-drag tip-bottom p-1.5 rounded text-faint hover:text-ink transition-colors"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => {
                    if (confirmDelete === selected.id) {
                      void tt.playlistDelete(selected.id)
                      setConfirmDelete(null)
                    } else setConfirmDelete(selected.id)
                  }}
                  onBlur={() => setConfirmDelete(null)}
                  data-tip="Delete playlist"
                  aria-label="Delete playlist"
                  className={cx(
                    'no-drag tip-bottom tip-end rounded px-2 h-7 text-[11.5px] transition-colors',
                    confirmDelete === selected.id
                      ? 'bg-alert text-white'
                      : 'p-1.5 text-faint hover:text-alert'
                  )}
                >
                  {confirmDelete === selected.id ? 'Sure?' : <Trash2 size={14} />}
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                  <SortableContext
                    items={selected.items.map((_, i) => rowId(selected, i))}
                    strategy={verticalListSortingStrategy}
                  >
                    {selected.items.map((item, i) => (
                      <TrackRow
                        key={rowId(selected, i)}
                        id={rowId(selected, i)}
                        item={item}
                        onRemove={() => removeItem(i)}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
                {selected.items.length === 0 && (
                  <div className="microlabel px-1 py-6">This playlist is empty.</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Stable per-position id — a playlist may hold the same track twice, so the
 *  content key alone can't identify a row. */
const rowId = (p: Playlist, index: number): string => `${p.id}:${index}`

function TrackRow({
  id,
  item,
  onRemove
}: {
  id: string
  item: PlaylistItem
  onRemove: () => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    // The WHOLE ROW is the drag handle, matching Queue and Presets — a grip-only
    // handle looks identical but silently refuses the drag everyone has been
    // taught by the rest of the app. The grip stays as the visual affordance
    // (a span, not a button: a second tab stop for the same action is noise).
    // The distance constraint means clicks on the inner buttons still land.
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      aria-label={`${item.title} — drag or press space to reorder`}
      className={cx(
        'group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-veil transition-colors',
        isDragging && 'opacity-60'
      )}
    >
      <span aria-hidden className="cursor-grab text-faint group-hover:text-dim transition-colors">
        <GripVertical size={14} />
      </span>
      <div className="h-9 w-9 shrink-0 rounded overflow-hidden bg-raised">
        <ArtImage src={item.artUrl} fallback={<span />} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-ink">{item.title}</div>
        <div className="truncate text-[11.5px] text-dim">
          {[item.artist, item.album].filter(Boolean).join(' — ') || ' '}
        </div>
      </div>
      {item.durationSecs != null && (
        <span className="font-mono text-[11px] text-faint">{fmtTime(item.durationSecs)}</span>
      )}
      <button
        onClick={onRemove}
        aria-label={`Remove ${item.title}`}
        data-tip="Remove"
        className="no-drag tip-top tip-end p-1 rounded text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-alert transition-all"
      >
        <X size={13} />
      </button>
    </div>
  )
}

function RenameField({
  initial,
  onDone
}: {
  initial: string
  onDone: (name: string | null) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(value.trim() || null)
        if (e.key === 'Escape') onDone(null)
      }}
      aria-label="Playlist name"
      className="bg-raised ring-1 ring-edge2 rounded px-2 h-8 text-[15px] font-display tracking-tight min-w-0 flex-1 max-w-[320px]"
    />
  )
}

/**
 * Progress while a playlist loads, and the honest aftermath. Activation is
 * ~2 round-trips per track, so a long playlist takes real time — and a partial
 * result (tracks no longer on any server) is a normal outcome worth naming,
 * not an error to swallow.
 */
function ActivationBanner({
  activation: a,
  onCancel
}: {
  activation: PlaylistActivation
  onCancel: () => void
}): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    setDismissed(false)
  }, [a.name, a.finished])
  if (a.finished && (dismissed || (a.missed.length === 0 && !a.cancelled))) return null

  return (
    <div className="mx-8 mb-3 flex items-center gap-3 rounded-lg bg-raised ring-1 ring-edge px-3 py-2 text-[12.5px]">
      {!a.finished ? (
        <>
          <span className="text-dim">
            Loading “{a.name}” — {a.done} of {a.total}
          </span>
          <div className="flex-1" />
          <button onClick={onCancel} className="no-drag text-faint hover:text-ink transition-colors">
            Cancel
          </button>
        </>
      ) : (
        <>
          <span className="text-dim">
            {a.cancelled ? 'Stopped — ' : ''}
            {a.added} of {a.total} loaded
            {a.missed.length > 0 && `; couldn't find ${a.missed.join(', ')}`}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            className="no-drag text-faint hover:text-ink transition-colors"
          >
            <X size={13} />
          </button>
        </>
      )}
    </div>
  )
}
