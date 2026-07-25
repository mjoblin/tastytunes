import { useEffect, useMemo, useRef, useState } from 'react'
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
import { Disc3, ListOrdered, Loader2, MoreHorizontal, Pencil, Play, Trash2, X } from 'lucide-react'
import {
  favoriteKey,
  playlistItemKey,
  type Favorite,
  type FavoriteMedia,
  type Playlist,
  type PlaylistItem
} from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { EmptyState } from '@/components/EmptyState'
import { SortChip } from '@/components/SortChip'
import { FilterInput } from '@/components/FilterInput'
import { RowAction } from '@/components/RowAction'
import { createPortal } from 'react-dom'
import { usePopoverChrome, useClampedPosition } from '@/hooks/usePopover'
import { RowHeart } from '@/components/RowHeart'
import { AddToPlaylistPanel } from '@/components/AddToPlaylistPanel'
import { toggleFavorite } from '@/lib/favorites'
import { OrderHandle } from '@/components/OrderHandle'
import { ArtImage } from '@/components/ArtImage'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { lockVertical } from '@/lib/dnd'
import { cx, fmtDuration, fmtRelative, fmtTime, matchesFilter } from '@/lib/format'

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
  const [trackMenu, setTrackMenu] = useState<{
    item: PlaylistItem
    index: number
    x: number
    y: number
  } | null>(null)
  const [copyTo, setCopyTo] = useState<{ item: PlaylistItem; x: number; y: number } | null>(null)
  // A sort picker rather than manual ordering (user call 2026-07-24): manual
  // order fights the recency sort that already does useful work and needs an
  // `order` field maintained forever, for control a picker gives at a fraction
  // of the cost. 'updated' is the neutral default the store already writes in.
  const showToast = useStore((s) => s.showToast)
  const [sort, setSort] = useState<PlaylistSort>('updated')
  const [reversed, setReversed] = useState(false)
  const scrollMemory = useScrollMemory('playlists')

  const shown = useMemo(() => {
    const list = playlists.filter((p) => matchesFilter(filter, [p.name]))
    const by: Record<PlaylistSort, (a: Playlist, b: Playlist) => number> = {
      updated: (a, b) => b.updatedAt - a.updatedAt,
      created: (a, b) => b.createdAt - a.createdAt,
      // never-played sorts last rather than pretending to be oldest
      played: (a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0),
      name: (a, b) => a.name.localeCompare(b.name),
      length: (a, b) => totalSecs(b) - totalSecs(a)
    }
    const sorted = [...list].sort(by[sort])
    return reversed ? sorted.reverse() : sorted
  }, [playlists, filter, sort, reversed])
  const selected = playlists.find((p) => p.id === selectedId) ?? shown[0] ?? null
  /** Is the live activation THIS playlist's? Another one running should grey
   *  this button, not turn it into that run's progress bar. */
  const mine = !!activation && !activation.finished && activation.playlistId === selected?.id


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
    const ids = rowIds(selected.items)
    const from = ids.indexOf(String(e.active.id))
    const to = ids.indexOf(String(e.over.id))
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

  /**
   * Activating replaces the QUEUE — an effect you can't see from this screen —
   * so the outcome is a toast, which is what the app's doctrine reserves them
   * for. The per-track detail isn't repeated here: a playlist keeps its own
   * "couldn't find these" line afterwards, which outlives any toast.
   */
  const activate = async (p: Playlist): Promise<void> => {
    const res = await tt.playlistActivate(p.id)
    const missed = res.missed.length
    showToast({
      kind: res.added > 0 ? 'success' : 'error',
      text: res.cancelled
        ? `Stopped — ${res.added} of ${res.total} loaded`
        : missed > 0
          ? `Loaded ${res.added} of ${res.total} — ${missed} not found`
          : `Loaded ${res.added} ${res.added === 1 ? 'track' : 'tracks'} from “${p.name}”`,
      action: { label: 'Open Queue', screen: 'queue' }
    })
  }

  return (
    <div className="h-full flex flex-col">
      <header className="px-8 pt-8 pb-4 flex items-center gap-4">
        <h1 className="font-display screen-title font-bold text-[26px] tracking-tight">Playlists</h1>
        <div className="flex-1" />
        {playlists.length > 0 && (
          <SortChip
            sorts={[
              { value: 'updated', label: 'Recently updated' },
              { value: 'played', label: 'Recently played' },
              { value: 'created', label: 'Recently created' },
              { value: 'name', label: 'Name' },
              { value: 'length', label: 'Length' }
            ]}
            neutral="updated"
            value={sort}
            reversed={reversed}
            onChange={(v) => setSort(v)}
            onToggleReverse={() => setReversed((r) => !r)}
          />
        )}
        {playlists.length > 0 && (
          <FilterInput
            value={filter}
            onChange={(v) => setScreenFilter('playlists', v)}
            shown={shown.length}
            total={playlists.length}
          />
        )}
      </header>

      {trackMenu && (
        <TrackMenu
          menu={trackMenu}
          onClose={() => setTrackMenu(null)}
          items={[
            {
              label: 'Add to another playlist…',
              run: () => setCopyTo({ item: trackMenu.item, x: trackMenu.x, y: trackMenu.y })
            },
            {
              label: 'Remove from playlist',
              run: () => {
                if (!selected) return
                void tt.playlistSetItems(
                  selected.id,
                  selected.items.filter((_, i) => i !== trackMenu.index)
                )
              }
            }
          ]}
        />
      )}
      {copyTo && (
        <AddToPlaylistPanel
          label={copyTo.item.title}
          at={{ x: copyTo.x, y: copyTo.y }}
          onClose={() => setCopyTo(null)}
          resolve={async () => [copyTo.item]}
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
                  <div className="flex items-center gap-2.5">
                    <ArtStack playlist={p} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px]">{p.name}</div>
                      <div className="microlabel mt-0.5 truncate">
                        {p.items.length} {p.items.length === 1 ? 'track' : 'tracks'}
                        {totalSecs(p) > 0 && ` · ${fmtDuration(totalSecs(p))}`}
                      </div>
                      <div className="microlabel truncate">
                        {p.lastPlayedAt ? `played ${fmtRelative(p.lastPlayedAt)}` : 'not played yet'}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* the selected playlist */}
          {selected && (
            // @container: what fits is a question about THIS PANE, not the
            // window. The rail is a fixed 280px, so a wide window can still
            // leave this column cramped — viewport breakpoints (sm:) answered
            // the wrong question and let the metadata strangle the title.
            <div className="@container flex-1 min-w-0 min-h-0 flex flex-col">
              <div className="flex items-center gap-2 mb-1">
                {renaming === selected.id ? (
                  <RenameField
                    initial={selected.name}
                    onDone={(name) => {
                      if (name) void tt.playlistRename(selected.id, name)
                      setRenaming(null)
                    }}
                  />
                ) : (
                  <h2 className="flex-1 min-w-0 font-display font-bold text-[19px] tracking-tight truncate">
                    {selected.name}
                  </h2>
                )}
                {/* Progress lives IN the button that started it — the button is
                    already inert during the run, and an inserted banner pushed
                    the whole list down and back up again. Clicking mid-run
                    cancels, so one control owns the whole interaction. */}
                <button
                  onClick={() => (mine ? void tt.playlistActivateCancel() : void activate(selected))}
                  disabled={(!!running && !mine) || selected.items.length === 0}
                  data-tip={
                    mine
                      ? `Loading ${activation.done} of ${activation.total} — click to stop`
                      : 'Replace the queue with this playlist'
                  }
                  aria-label={mine ? 'Stop loading playlist' : 'Play playlist'}
                  className="no-drag tip-bottom relative overflow-hidden flex items-center gap-2 px-3.5 h-8 rounded-lg bg-gold text-bg text-[12.5px] font-medium shadow-[0_0_14px_rgb(var(--gold-rgb)_/_0.3)] hover:brightness-110 disabled:opacity-40 disabled:shadow-none motion-safe:active:scale-95 transition-all"
                >
                  {mine && (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-0 bg-bg/20 transition-[width] duration-200"
                      style={{
                        width: `${Math.round((activation.done / Math.max(1, activation.total)) * 100)}%`
                      }}
                    />
                  )}
                  {/* The LABEL never changes and the icon carries the state, so
                      the button can't resize mid-run — the sleep timer settled
                      this exact question when an in-bar countdown grew the
                      right cluster and squeezed the volume slider. The live
                      count lives in the tooltip, where it can be read at
                      leisure rather than glimpsed. */}
                  <span className="relative flex items-center gap-2">
                    {mine ? (
                      <Loader2 size={14} strokeWidth={2.2} className="motion-safe:animate-spin" />
                    ) : (
                      <Play size={14} strokeWidth={2.2} />
                    )}
                    Play
                  </span>
                </button>
                <button
                  onClick={() => setRenaming(selected.id)}
                  data-tip="Rename"
                  aria-label="Rename playlist"
                  className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
                >
                  <Pencil size={16} />
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
                    'no-drag tip-bottom tip-end rounded-lg motion-safe:active:scale-90 transition-all',
                    confirmDelete === selected.id
                      ? 'px-2.5 h-9 text-[11.5px] bg-alert text-white'
                      : 'p-2 ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70'
                  )}
                >
                  {confirmDelete === selected.id ? 'Sure?' : <Trash2 size={16} />}
                </button>
              </div>

              {/* Its own line, under the title — stacked rather than competing,
                  so the name is never the thing that loses. Facts drop by PANE
                  width, least useful first: created, then artists. */}
              <div className="microlabel truncate mb-3">
                {selected.items.length} {selected.items.length === 1 ? 'track' : 'tracks'}
                {totalSecs(selected) > 0 && ` · ${fmtDuration(totalSecs(selected))}`}
                {artistCount(selected) > 1 && (
                  <span className="hidden @sm:inline"> · {artistCount(selected)} artists</span>
                )}
                {selected.lastPlayedAt && (
                  <span className="hidden @xs:inline"> · played {fmtRelative(selected.lastPlayedAt)}</span>
                )}
                <span className="hidden @lg:inline"> · created {fmtRelative(selected.createdAt)}</span>
              </div>

              {(selected.lastMissing?.length ?? 0) > 0 && (
                <div className="mb-2 text-[11.5px] text-dim">
                  Last played, {selected.lastMissing?.length} could not be found:{' '}
                  <span className="text-faint">{selected.lastMissing?.join(', ')}</span>
                </div>
              )}
              {/* divide-y divide-edge/50: the same hairline the queue and the
                  library's track lists use between rows */}
              <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-edge/50">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={onDragEnd}
                >
                  <SortableContext items={rowIds(selected.items)} strategy={verticalListSortingStrategy}>
                    {selected.items.map((item, i) => (
                      <TrackRow
                        key={rowIds(selected.items)[i]}
                        id={rowIds(selected.items)[i]}
                        index={i}
                        item={item}
                        onRemove={() => removeItem(i)}
                        onMenu={(e) => setTrackMenu({ item, index: i, x: e.clientX, y: e.clientY })}
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

type PlaylistSort = 'updated' | 'created' | 'played' | 'name' | 'length'

/** Total runtime; null durations (servers that don't report one) just don't add. */
const totalSecs = (p: Playlist): number => p.items.reduce((n, i) => n + (i.durationSecs ?? 0), 0)

/** How many distinct artists — a cheap read on how varied a playlist is. */
const artistCount = (p: Playlist): number =>
  new Set(p.items.map((i) => (i.artist ?? '').trim().toLowerCase()).filter(Boolean)).size

/**
 * The first few covers, stacked. Playlists are far easier to recognise by their
 * art than by a line of text, and we already store artUrl per entry — so this
 * costs nothing but makes the collection scannable.
 */
function ArtStack({ playlist }: { playlist: Playlist }): React.JSX.Element {
  const covers = [...new Set(playlist.items.map((i) => i.artUrl).filter(Boolean))].slice(0, 3)
  if (covers.length === 0) {
    return (
      <div className="h-10 w-10 shrink-0 rounded bg-raised ring-1 ring-edge flex items-center justify-center">
        <ListOrdered size={14} className="text-faint" />
      </div>
    )
  }
  return (
    <div className="relative h-10 w-10 shrink-0">
      {covers.map((src, i) => (
        <div
          key={src}
          className="absolute h-8 w-8 rounded overflow-hidden ring-1 ring-edge2 bg-raised"
          style={{ left: i * 4, top: i * 2, zIndex: covers.length - i }}
        >
          <ArtImage src={src} fallback={<span />} />
        </div>
      ))}
    </div>
  )
}

/**
 * Stable per-ITEM ids, NOT positional ones.
 *
 * dnd-kit animates a sortable by its id. With `${playlist}:${index}` the ids
 * never move — after a swap they're still :0, :1, :2 in that order — so the
 * dragged element springs back to its original slot while the content changes
 * underneath it. The reorder works, but it reads as if it failed. Keying on
 * CONTENT means the id travels with the track and the move animates properly.
 *
 * A playlist may legitimately hold the same track twice, so identical entries
 * are disambiguated by occurrence. Swapping two identical tracks does exchange
 * their ids, but they're indistinguishable on screen, so nothing reads wrong.
 */
function rowIds(items: PlaylistItem[]): string[] {
  const seen = new Map<string, number>()
  return items.map((it) => {
    const key = playlistItemKey(it)
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    return `${key}#${n}`
  })
}

function TrackRow({
  id,
  index,
  item,
  onRemove,
  onMenu
}: {
  id: string
  index: number
  item: PlaylistItem
  onRemove: () => void
  onMenu: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const favorites = useStore((s) => s.favorites)
  // A playlist entry already carries the content identity favorites need.
  const favorite: Omit<FavoriteMedia, 'addedAt'> | null =
    item.title && item.artist
      ? {
          kind: 'track',
          title: item.title,
          artist: item.artist,
          album: item.album,
          artUrl: item.artUrl,
          serverUdn: item.serverUdn,
          serverName: item.serverName,
          objectId: item.objectId,
          titlePath: null,
          durationSecs: item.durationSecs ?? null
        }
      : null
  const hearted =
    favorite != null && favorites.some((f) => favoriteKey(f) === favoriteKey(favorite as Favorite))
  return (
    // Same anatomy as a queue row (QueueScreen's QueueRow): position, art,
    // title/artist, duration, remove, grip — in that order, on the same grid.
    // Both screens are ordered lists of tracks; there is no reason for a track
    // row to feel like a different object depending on which one you're in.
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(lockVertical(transform)), transition }}
      className={cx(
        'group grid grid-cols-[26px_44px_1fr_auto_auto_auto_auto] items-center gap-2 rounded-lg px-2 py-1.5',
        'transition-colors',
        isDragging ? 'z-10 bg-raised shadow-xl' : 'hover:bg-veil'
      )}
    >
      <OrderHandle
        label={`Reorder ${item.title}`}
        attributes={attributes}
        listeners={listeners}
      >
        <span className="font-mono text-[10.5px] text-faint tabular-nums">{index + 1}</span>
      </OrderHandle>

      <div className="h-10 w-10 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage src={item.artUrl} lazy fallback={<Disc3 size={16} className="text-faint" />} />
      </div>

      <div className="min-w-0">
        <div className="text-[13.5px] truncate text-ink">{item.title}</div>
        <div className="text-[12px] text-dim truncate">
          {[item.artist, item.album].filter(Boolean).join(' — ')}
        </div>
      </div>

      <RowAction
        icon={X}
        label={`Remove ${item.title}`}
        tip="Remove from playlist"
        destructive
        onClick={onRemove}
      />

      <RowAction icon={MoreHorizontal} label="More actions" onClick={(e) => onMenu(e)} />

      {/* persistent state groups with the duration — see QueueRow */}
      {favorite && (
        <RowHeart favorited={hearted} held={false} onHeart={() => void toggleFavorite(favorite)} />
      )}

      {/* far right of the content, after the hover actions — see QueueRow */}
      <span className="font-mono text-[11px] text-faint tabular-nums">
        {item.durationSecs != null ? fmtTime(item.durationSecs) : ''}
      </span>

      {/* Grip last, matching the queue. Unlike the queue's it carries an
          aria-label and pairs with a KeyboardSensor, so the list can be
          reordered without a mouse. */}

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

/** The row ⋯ menu — the FavMenu/QueueRowMenu shape, third instance. */
function TrackMenu({
  menu,
  items,
  onClose
}: {
  menu: { item: PlaylistItem; x: number; y: number }
  items: Array<{ label: string; run: () => void }>
  onClose(): void
}): React.JSX.Element {
  usePopoverChrome(onClose)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pos = useClampedPosition(boxRef, menu.x, menu.y)
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={onClose} />
      <div
        ref={boxRef}
        className="fixed z-50 w-52 rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-1.5 space-y-0.5"
        style={pos}
      >
        <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint truncate">{menu.item.title}</div>
        {items.map((it) => (
          <button
            key={it.label}
            onClick={() => {
              onClose()
              it.run()
            }}
            className="w-full px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim hover:text-ink hover:bg-veil transition-colors"
          >
            {it.label}
          </button>
        ))}
      </div>
    </>,
    document.body
  )
}
