import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListOrdered, Plus } from 'lucide-react'
import type { PlaylistItem } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { cx, fmtTime, matchesFilter } from '@/lib/format'
import { usePopoverChrome, useClampedPosition } from '@/hooks/usePopover'

/**
 * The one add-to-playlist control, shared by every surface that shows a track
 * (Library ⋯ menu, Favorites, Recently Played, Now Playing) — the PresetSavePanel
 * idiom. Adding from wherever you see music is the PRIMARY way playlists get
 * built; "save queue as playlist" is the convenience for capturing something
 * already assembled, not the main door.
 *
 * `resolve` returns the items to append. It's async because an ALBUM has to be
 * expanded into its tracks first: a playlist is an ordered list of TRACKS, so
 * adding an album appends what's in it rather than storing a reference that
 * would drift as the server's album changes. Stations never reach here — an
 * endless stream can't hold a position in an ordered list.
 */
export function AddToPlaylistPanel({
  label,
  resolve,
  at,
  onClose
}: {
  /** What's being added, shown in the header. */
  label: string
  resolve: () => Promise<PlaylistItem[]>
  at: { x: number; y: number }
  onClose(): void
}): React.JSX.Element {
  const all = useStore((s) => s.playlists)
  const showToast = useStore((s) => s.showToast)
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  usePopoverChrome(onClose)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pos = useClampedPosition(boxRef, at.x, at.y)

  // A filter only earns its space once the list is long enough to hunt through.
  // Below that it's chrome in the way of a two-click action; the list is
  // newest-updated-first, so the one you just used is already at the top.
  const showFilter = all.length > 8
  const playlists = filter
    ? all.filter((p) => matchesFilter(filter, [p.name]))
    : all

  const done = (count: number, name: string): void => {
    showToast({
      kind: 'success',
      text: `Added ${count} ${count === 1 ? 'track' : 'tracks'} to “${name}”`,
      action: { label: 'Open Playlists', screen: 'playlists' }
    })
    onClose()
  }

  const addTo = async (id: string, name: string): Promise<void> => {
    setBusy(true)
    try {
      const items = await resolve()
      if (items.length === 0) {
        showToast({ kind: 'error', text: `Nothing to add from “${label}”` })
        onClose()
        return
      }
      await tt.playlistAppend(id, items)
      done(items.length, name)
    } catch {
      showToast({ kind: 'error', text: "Couldn't add to the playlist" })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const createWith = async (): Promise<void> => {
    const name = newName.trim() || label
    setBusy(true)
    try {
      const items = await resolve()
      if (items.length === 0) {
        showToast({ kind: 'error', text: `Nothing to add from “${label}”` })
        onClose()
        return
      }
      // Toast the STORED name — a collision uniquifies it ("Jazz (2)"), and
      // the toast naming a playlist that isn't the one just made reads as a bug.
      const created = await tt.playlistCreate(name, items)
      done(items.length, created.name)
    } catch {
      showToast({ kind: 'error', text: "Couldn't create the playlist" })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={onClose} />
      <div
        ref={boxRef}
        className="fixed z-50 w-64 rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-1.5"
        style={pos}
      >
        <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint truncate">Add “{label}” to…</div>
        {showFilter && (
          <div className="px-1 pb-1.5">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                // Enter with exactly one match is the fast path
                if (e.key === 'Enter' && playlists.length === 1) void addTo(playlists[0].id, playlists[0].name)
                if (e.key === 'Escape') (filter ? setFilter('') : onClose())
              }}
              placeholder={`Filter ${all.length} playlists`}
              aria-label="Filter playlists"
              className="w-full bg-panel ring-1 ring-edge2 rounded px-2 h-7 text-[12.5px]"
            />
          </div>
        )}

        <div className="max-h-[280px] overflow-y-auto space-y-0.5">
          {playlists.map((p) => {
            const secs = p.items.reduce((n, i) => n + (i.durationSecs ?? 0), 0)
            return (
              <button
                key={p.id}
                disabled={busy}
                onClick={() => void addTo(p.id, p.name)}
                className="w-full px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim hover:text-ink hover:bg-veil disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                <ListOrdered size={13} className="shrink-0 text-faint" />
                <span className="flex-1 min-w-0 truncate">{p.name}</span>
                <span className="font-mono text-[10px] text-faint shrink-0">
                  {secs > 0 ? fmtTime(secs) : p.items.length}
                </span>
              </button>
            )
          })}
          {playlists.length === 0 && (
            <div className="px-2.5 py-2 text-[12px] text-faint">
              {all.length === 0 ? 'No playlists yet.' : 'No playlist matches that.'}
            </div>
          )}
        </div>

        <div className="mt-1 pt-1 border-t border-edge">
          {creating ? (
            <div className="p-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createWith()
                  if (e.key === 'Escape') setCreating(false)
                }}
                placeholder={label}
                aria-label="New playlist name"
                className="w-full bg-panel ring-1 ring-edge2 rounded px-2 h-7 text-[12.5px]"
              />
              <button
                disabled={busy}
                onClick={() => void createWith()}
                className={cx(
                  'mt-1 w-full rounded-lg h-7 text-[12px] bg-amberdim text-amber',
                  'hover:brightness-110 disabled:opacity-50 transition-all'
                )}
              >
                Create and add
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="w-full px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim hover:text-ink hover:bg-veil transition-colors flex items-center gap-2"
            >
              <Plus size={13} className="shrink-0 text-faint" />
              New playlist…
            </button>
          )}
        </div>
      </div>
    </>,
    document.body
  )
}

/** Map a library node (already known to be a track) to a stored playlist entry. */
export function itemFromNode(
  node: {
    title: string
    artist: string | null
    album: string | null
    artUrl: string | null
    id: string
    durationSecs: number | null
  },
  serverUdn: string | null,
  serverName: string | null
): PlaylistItem {
  return {
    title: node.title,
    artist: node.artist,
    album: node.album,
    artUrl: node.artUrl,
    serverUdn,
    serverName,
    objectId: node.id,
    durationSecs: node.durationSecs
  }
}
