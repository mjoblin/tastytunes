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
import { ListOrdered, Loader2, MoreHorizontal, Pencil, Play, Trash2, X } from 'lucide-react'
import { queueContentHash } from '@shared/smoip'
import {
  favoriteKey,
  playlistContentHash,
  playlistItemKey,
  playlistTotalSecs,
  type Favorite,
  type FavoriteMedia,
  type Playlist,
  type PlaylistItem
} from '@shared/model'
import { tt } from '@/api'
import { useStore } from '@/store'
import { EmptyState } from '@/components/chrome/EmptyState'
import { SortChip } from '@/components/controls/SortChip'
import { FilterInput } from '@/components/controls/FilterInput'
import { RowAction } from '@/components/media/RowAction'
import { RowMenu } from '@/components/media/RowMenu'
import { RowHeart } from '@/components/media/RowHeart'
import { AddToPlaylistPanel } from '@/components/overlays/AddToPlaylistPanel'
import { toggleFavorite } from '@/lib/favorites'
import { activatePlaylist } from '@/lib/playlists'
import { fromPlaylistItem } from '@/lib/mediaRef'
import { saveRefToPreset } from '@/lib/mediaActions'
import { trackMenuItems } from '@/lib/mediaMenus'
import { OrderHandle } from '@/components/controls/OrderHandle'
import { ArtImage } from '@/components/media/ArtImage'
import { MediaArt } from '@/components/media/MediaArt'
import { DurationCell } from '@/components/media/DurationCell'
import { PresetPicker } from '@/components/library/LibraryMenus'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { lockVertical } from '@/lib/dnd'
import { activeSourceId, cx, fmtDuration, fmtRelative, matchesFilter } from '@/lib/format'
import { Eqbars } from '@/components/media/Eqbars'
import { HeaderChip, PrimaryButton, ScreenTitle } from '@/components/chrome/Chrome'
import { useConfirmPopover } from '@/components/chrome/Confirm'
import { useOneShotAsk } from '@/hooks/useOneShotAsk'
import { artUrlAt } from '@shared/artUrl'

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
  const queue = useStore((s) => s.queue)
  /**
   * Which playlist IS the queue right now — matched on CONTENT, not on a stored
   * "active playlist" id. Content matching recognises a queue loaded before the
   * app started or by another controller, and it degrades honestly: edit the
   * queue and the badge simply goes, because it genuinely isn't that playlist
   * any more. (A stored active-id plus a "modified" state was considered and
   * dropped — after you queue an album it would still claim the old playlist
   * was loaded-but-edited, which is worse than saying nothing.)
   */
  const liveHash = useMemo(() => queueContentHash(queue?.items ?? []), [queue])
  const filter = useStore((s) => s.screenFilters.playlists)
  const setScreenFilter = useStore((s) => s.setScreenFilter)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const confirmDelete = useConfirmPopover()
  const [trackMenu, setTrackMenu] = useState<{
    item: PlaylistItem
    index: number
    x: number
    y: number
  } | null>(null)
  const [copyTo, setCopyTo] = useState<{ item: PlaylistItem; x: number; y: number } | null>(null)
  const [presetFor, setPresetFor] = useState<{ item: PlaylistItem; x: number; y: number } | null>(
    null
  )
  // A sort picker rather than manual ordering (user call 2026-07-24): manual
  // order fights the recency sort that already does useful work and needs an
  // `order` field maintained forever, for control a picker gives at a fraction
  // of the cost. 'updated' is the neutral default the store already writes in.
  const showToast = useStore((s) => s.showToast)
  const saveSettings = useStore((s) => s.saveSettings)
  // View default, persisted (2026-08-06). Sanitized on use: a hand-edited
  // settings file must not leave the list unsorted-and-unlabeled.
  const storedSort = useStore((s) => s.settings.playlistsSort)
  const sort: PlaylistSort = PLAYLIST_SORT_IDS.includes(storedSort) ? storedSort : 'updated'
  const reversed = useStore((s) => s.settings.playlistsSortReversed)
  const scrollMemory = useScrollMemory('playlists')

  const queuedId = useMemo(() => {
    if ((queue?.items?.length ?? 0) === 0) return null
    return playlists.find((p) => playlistContentHash(p.items) === liveHash)?.id ?? null
  }, [playlists, liveHash, queue])
  // Playing marker, queue-screen rules. queuedId means the queue and the
  // playlist are content-identical INCLUDING ORDER (the hash is
  // order-sensitive), so the playing queue POSITION is the playlist index —
  // no title matching, and twin-titled tracks can't cross-light.
  const playState = useStore((s) => s.playState)
  const zoneState = useStore((s) => s.zoneState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const queueSourceActive = activeSourceId(zoneState, nowPlaying) === 'MEDIA_PLAYER'
  const playingIndex = useMemo(() => {
    const playId = queue?.play_id ?? playState?.queue_id ?? null
    if (playId == null) return null
    return queue?.items?.find((it) => it.id === playId)?.position ?? null
  }, [queue, playState])

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
  // The record keeps every title the last activation couldn't find, but the
  // note's job is pointing at a gap in THIS list — a missing track the user
  // has since edited out is a gap that no longer exists, so it drops from the
  // display. The stored record stays untouched; the next play rewrites it.
  const stillMissing = (selected?.lastMissing ?? []).filter((title) =>
    (selected?.items ?? []).some(
      (it) => it.title.trim().toLowerCase() === title.trim().toLowerCase()
    )
  )
  /** Is the live activation THIS playlist's? Another one running should grey
   *  this button, not turn it into that run's progress bar. */
  const mine = !!activation && !activation.finished && activation.playlistId === selected?.id
  // Computed once per items change: rowIds walks the whole list, and calling
  // it per row (as key= and id= once did) is O(n²) at the 500-item ceiling.
  const ids = useMemo(() => rowIds(selected?.items ?? []), [selected?.items])

  // A deleted (or filtered-away) selection must not strand the detail pane.
  useEffect(() => {
    if (selectedId && !playlists.some((p) => p.id === selectedId)) setSelectedId(null)
  }, [playlists, selectedId])

  // A search result OPENS a playlist rather than playing it (containers open,
  // leaves play), so it plants an id here and this consumes it. Cleared on
  // arrival — a stale jump must not re-select on a later visit.
  const playlistsJump = useStore((s) => s.playlistsJump)
  const clearPlaylistsJump = useStore((s) => s.clearPlaylistsJump)
  useOneShotAsk(
    playlistsJump,
    (id) => {
      if (playlists.some((p) => p.id === id)) setSelectedId(id)
    },
    { clear: clearPlaylistsJump }
  )

  // Pointer AND keyboard: reordering a list you can't drag is otherwise
  // impossible for anyone without a mouse.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const onDragEnd = (e: DragEndEvent): void => {
    if (!selected || !e.over || e.active.id === e.over.id) return
    const from = ids.indexOf(String(e.active.id))
    const to = ids.indexOf(String(e.over.id))
    if (from < 0 || to < 0) return
    void tt.playlistSetItems(selected.id, arrayMove(selected.items, from, to))
  }

  /**
   * The × and the ⋯ menu's "Remove from playlist" both land here, so the undo
   * offer can't belong to only one of them.
   *
   * The row is gone the instant you click — no confirm. Removing tracks while
   * tidying a playlist is something you do repeatedly, and a "Sure?" on every
   * one punishes the common case to guard the rare mistake; the undo offer
   * covers the mistake without slowing the habit. (A whole-playlist DELETE
   * keeps its confirm: rare, and it takes the collection with it.)
   */
  const removeItem = (index: number): void => {
    if (!selected) return
    const id = selected.id
    const item = selected.items[index]
    if (!item) return
    void tt.playlistSetItems(
      selected.id,
      selected.items.filter((_, i) => i !== index)
    )
    showToast({
      kind: 'success',
      text: `Removed “${item.title}”`,
      action: { label: 'Undo', undo: () => restoreItem(id, index, item) }
    })
  }

  /**
   * Splice the track back into the playlist as it is NOW, rather than restoring
   * the array snapshot taken at removal time — undoing must not silently
   * discard a reorder or a second removal made in the seconds since. Reading the
   * live playlist out of the store (not the `selected` closure) is what makes
   * that true even if the selection has moved on.
   */
  const restoreItem = (id: string, index: number, item: PlaylistItem): void => {
    const current = useStore.getState().playlists.find((p) => p.id === id)
    if (!current) return // the playlist itself was deleted meanwhile
    const items = [...current.items]
    items.splice(Math.min(index, items.length), 0, item)
    void tt.playlistSetItems(id, items)
  }

  const running = activation && !activation.finished

  // Activation reporting lives in lib/playlists (activatePlaylist), shared
  // with unified search. The per-track detail isn't repeated in its toast: a
  // playlist keeps its own "couldn't find these" line afterwards, which
  // outlives any toast.

  return (
    <div className="h-full flex flex-col">
      <header className="px-8 pt-8 pb-4 flex items-center gap-4">
        <ScreenTitle>Playlists</ScreenTitle>
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
            onChange={(v) => void saveSettings({ playlistsSort: v, playlistsSortReversed: false })}
            onToggleReverse={() => void saveSettings({ playlistsSortReversed: !reversed })}
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
        <RowMenu
          title={trackMenu.item.title}
          at={{ x: trackMenu.x, y: trackMenu.y }}
          onClose={() => setTrackMenu(null)}
          // the shared track menu (heart, pivot, preset…) + the local remove
          items={trackMenuItems(fromPlaylistItem(trackMenu.item), {
            addToPlaylist: () => setCopyTo({ item: trackMenu.item, x: trackMenu.x, y: trackMenu.y }),
            saveToPreset: () =>
              setPresetFor({ item: trackMenu.item, x: trackMenu.x, y: trackMenu.y }),
            searchFrom: { screen: 'playlists' },
            extra: [{ label: 'Remove from playlist', run: () => removeItem(trackMenu.index) }]
          })}
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
      {presetFor && (
        <PresetPicker
          picker={{ node: { title: presetFor.item.title }, x: presetFor.x, y: presetFor.y }}
          onClose={() => setPresetFor(null)}
          onSave={async (slot, name) => {
            await saveRefToPreset(fromPlaylistItem(presetFor.item), slot, name)
            setPresetFor(null)
          }}
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
                      <div className="flex items-center gap-2 text-[13.5px]">
                        {queuedId === p.id && <Eqbars dim={!queueSourceActive} />}
                        <span className="truncate">{p.name}</span>
                      </div>
                      <div className="microlabel mt-0.5 truncate">
                        {queuedId === p.id && <span className="text-gold">in the queue · </span>}
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
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              {/* Two columns: the title AND the fact line share one right
                  boundary and can never run under the buttons — the same
                  text-cluster/actions anatomy every row follows. @container
                  sits on the LEFT COLUMN so the fact gates measure the space
                  the facts actually have, not the pane behind the buttons. */}
              <div className="flex items-start gap-4 mb-3">
                <div className="@container flex-1 min-w-0">
                  <div className="flex items-center min-h-8 mb-1 gap-2">
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
                  </div>

                  {/* Its own line, under the title — stacked rather than
                      competing, so the name is never the thing that loses.
                      Facts drop by the width the facts actually get, least
                      useful first: created, then artists. */}
                  <div data-playlist-meta className="microlabel truncate">
                    {queuedId === selected.id && <span className="text-gold">in the queue · </span>}
                    {selected.items.length} {selected.items.length === 1 ? 'track' : 'tracks'}
                    {totalSecs(selected) > 0 && ` · ${fmtDuration(totalSecs(selected))}`}
                    {artistCount(selected) > 1 && (
                      <span className="hidden @md:inline"> · {artistCount(selected)} artists</span>
                    )}
                    {selected.lastPlayedAt && (
                      <span className="hidden @xs:inline"> · played {fmtRelative(selected.lastPlayedAt)}</span>
                    )}
                    <span className="hidden @xl:inline"> · created {fmtRelative(selected.createdAt)}</span>
                  </div>
                </div>

                <div data-playlist-actions className="shrink-0 flex items-center gap-2">
                  {/* Progress lives IN the button that started it — the button is
                      already inert during the run, and an inserted banner pushed
                      the whole list down and back up again. Clicking mid-run
                      cancels, so one control owns the whole interaction. */}
                  <PrimaryButton
                    onClick={() =>
                      mine ? void tt.playlistActivateCancel() : void activatePlaylist(selected)
                    }
                    disabled={(!!running && !mine) || selected.items.length === 0}
                    data-tip={
                      mine
                        ? `Loading ${activation.done} of ${activation.total} — click to stop`
                        : 'Replace the queue with this playlist'
                    }
                    aria-label={mine ? 'Stop loading playlist' : 'Play playlist'}
                    className="no-drag tip-bottom relative overflow-hidden flex items-center gap-2 px-3.5 h-8 text-[12.5px]"
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
                  </PrimaryButton>
                  <HeaderChip
                    onClick={() => setRenaming(selected.id)}
                    data-tip="Rename"
                    aria-label="Rename playlist"
                    className="no-drag tip-bottom p-2 motion-safe:active:scale-90"
                  >
                    <Pencil size={16} />
                  </HeaderChip>
                  <button
                    onClick={(e) =>
                      confirmDelete.ask(e, {
                        question: `Delete “${selected.name}”?`,
                        onConfirm: () => {
                          // Snapshot the WHOLE playlist, not its id: undo has to
                          // put back the name, the items and the timestamps, and
                          // after the delete there is nowhere left to read them.
                          const deleted = selected
                          void tt.playlistDelete(deleted.id)
                          showToast({
                            kind: 'success',
                            text: `Deleted “${deleted.name}”`,
                            action: { label: 'Undo', undo: () => void tt.playlistRestore(deleted) }
                          })
                        }
                      })
                    }
                    data-tip="Delete playlist"
                    aria-label="Delete playlist"
                    className="no-drag tip-bottom tip-end rounded-lg motion-safe:active:scale-90 transition-all p-2 ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70"
                  >
                    <Trash2 size={16} />
                  </button>
                  {confirmDelete.popover}
                </div>
              </div>

              {stillMissing.length > 0 && (
                <div className="mb-2 text-[11.5px] text-dim">
                  Last played, {stillMissing.length} could not be found:{' '}
                  <span className="text-faint">{stillMissing.join(', ')}</span>
                </div>
              )}
              {/* divide-y divide-edge/50: the same hairline the queue and the
                  library's track lists use between rows */}
              <div className="flex-1 min-h-0 overflow-y-auto px-1.5 -mx-1.5 py-1 -my-1 divide-y divide-edge/50">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={onDragEnd}
                >
                  <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                    {selected.items.map((item, i) => (
                      <TrackRow
                        key={ids[i]}
                        id={ids[i]}
                        index={i}
                        item={item}
                        current={queuedId === selected.id && playingIndex === i}
                        sourceActive={queueSourceActive}
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
const PLAYLIST_SORT_IDS: readonly PlaylistSort[] = ['updated', 'created', 'played', 'name', 'length']

/** Total runtime lives in @shared/model (`playlistTotalSecs`) — the tray
 *  panel shows it too, and two sums is how they'd drift. */
const totalSecs = playlistTotalSecs

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
          <ArtImage src={artUrlAt(src, 32)} fallback={<span />} />
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
  current,
  sourceActive,
  onRemove,
  onMenu
}: {
  id: string
  index: number
  item: PlaylistItem
  /** This row is what the queue is playing (only when the playlist IS the queue). */
  current: boolean
  /** The queue's own source (MEDIA_PLAYER) is what's audible right now. */
  sourceActive: boolean
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
    // Same anatomy as a queue row (QueueScreen's QueueRow): position/handle,
    // art, title+artist, actions cluster, duration last — on the same grid.
    // Both screens are ordered lists of tracks; there is no reason for a track
    // row to feel like a different object depending on which one you're in.
    // Unlike the queue's, this row's handle pairs with a KeyboardSensor, so
    // the list can be reordered without a mouse.
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(lockVertical(transform)), transition }}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e)
      }}
      className={cx(
        'group grid grid-cols-[26px_44px_1fr_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5',
        'transition-colors',
        isDragging && 'z-10 bg-raised shadow-xl',
        // current + queue audible: the queue row's full playing treatment;
        // current while another source plays: the parked resume point
        current && sourceActive && 'row-playing bg-gold/10',
        current && !sourceActive && 'ring-1 ring-edge2 bg-veil/60 hover:bg-veil',
        !current && !isDragging && 'hover:bg-veil'
      )}
    >
      <OrderHandle
        label={`Reorder ${item.title}`}
        attributes={attributes}
        listeners={listeners}
      >
        {current ? (
          <Eqbars dim={!sourceActive} />
        ) : (
          <span className="font-mono text-[10.5px] text-faint tabular-nums">{index + 1}</span>
        )}
      </OrderHandle>

      <MediaArt src={item.artUrl} kind="track" />

      <div className="min-w-0">
        <div className="text-[13.5px] truncate text-ink">{item.title}</div>
        <div className="text-[12px] text-dim truncate">
          {[item.artist, item.album].filter(Boolean).join(' — ')}
        </div>
      </div>

      {/* one cluster at gap-0.5, matching the library and favorites rows */}
      <div className="flex items-center gap-0.5">
        <RowAction
          icon={X}
          label={`Remove ${item.title}`}
          tip="Remove from playlist"
          destructive
          onClick={onRemove}
        />
        <RowAction icon={MoreHorizontal} label="More actions" onClick={(e) => onMenu(e)} />
        {favorite && (
          <RowHeart favorited={hearted} held={false} onHeart={() => void toggleFavorite(favorite)} />
        )}
      </div>

      {/* far right of the content, after the hover actions — see QueueRow */}
      <DurationCell secs={item.durationSecs ?? null} />
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

