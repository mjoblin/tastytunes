import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MediaNode, MediaQueueAction } from '@shared/ipc'
import { useStore } from '@/store'
import { cx } from '@/lib/format'
import { usePopoverChrome, useClampedPosition } from '@/hooks/usePopover'
import { ArtImage } from '@/components/ArtImage'

// ------------------------------------------------------------------- ⋯ menu

export function ItemMenu({
  menu,
  onClose,
  onAction,
  onSavePreset,
  onAddToPlaylist,
  goToAlbum,
  goToArtist,
  favorite
}: {
  menu: { node: MediaNode; x: number; y: number }
  onClose(): void
  onAction(action: MediaQueueAction | 'PLAY', playFromId?: string): void
  onSavePreset(): void
  /** Adding from wherever you see music is the primary way playlists are built.
   *  Absent for nodes that can't become tracks (artists, plain folders). */
  onAddToPlaylist?(): void
  /** Search results give tracks navigate verbs (the row click still plays). */
  goToAlbum?(): void
  goToArtist?(): void
  /** When present, the menu grows an Add/Remove favorites entry (last). */
  favorite?: { active: boolean; toggle(): void }
}): React.JSX.Element {
  const { node } = menu
  const playlistItem = onAddToPlaylist
    ? [{ label: 'Add to playlist…', run: onAddToPlaylist }]
    : []
  const favoriteItem = favorite
    ? [
        {
          label: favorite.active ? 'Remove from favorites' : 'Add to favorites',
          run: favorite.toggle
        }
      ]
    : []
  const items: Array<{ label: string; run: () => void }> = node.isContainer
    ? [
        { label: 'Play', run: () => onAction('PLAY') },
        { label: 'Play next', run: () => onAction('PLAY_NEXT') },
        { label: 'Add to end of queue', run: () => onAction('APPEND') },
        { label: 'Replace queue', run: () => onAction('REPLACE') },
        { label: 'Save to preset…', run: onSavePreset },
        ...playlistItem,
        ...favoriteItem
      ]
    : [
        { label: 'Play now', run: () => onAction('PLAY_NOW') },
        { label: 'Play next', run: () => onAction('PLAY_NEXT') },
        { label: 'Add to end of queue', run: () => onAction('APPEND') },
        { label: 'Replace queue', run: () => onAction('REPLACE') },
        ...(node.parentId
          ? [
              {
                label: 'Play album from here',
                run: () => onAction('PLAY_FROM_HERE', node.id)
              }
            ]
          : []),
        ...(goToAlbum ? [{ label: 'Go to album', run: goToAlbum }] : []),
        ...(goToArtist ? [{ label: 'Go to artist', run: goToArtist }] : []),
        { label: 'Save to preset…', run: onSavePreset },
        ...playlistItem,
        ...favoriteItem
      ]

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
        <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint truncate">{node.title}</div>
        {items.map((item) => (
          <button
            key={item.label}
            onClick={item.run}
            className="w-full px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim hover:text-ink hover:bg-veil transition-colors"
          >
            {item.label}
          </button>
        ))}
      </div>
    </>,
    document.body
  )
}

// -------------------------------------------------------------- preset picker

/**
 * The one preset-save control, shared by the Library ⋯ menu (album/track →
 * preset) and the Queue screen (queue → preset). Optional name field, a
 * visual slot grid showing each occupied slot's art, and a two-tap overwrite
 * confirm. `onSave(slot, name)` does the entry-specific work and must throw on
 * failure (the panel then stays open); on success it closes its own wrapper.
 */
export function PresetSavePanel({
  title,
  subtitle,
  nameAutoFocus = false,
  onSave
}: {
  title: string
  subtitle?: string
  nameAutoFocus?: boolean
  onSave(slot: number, name: string | null): Promise<void>
}): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  const occupied = new Map<number, { name: string; art: string | null }>()
  for (const p of presets?.presets ?? []) {
    if (p.id != null)
      occupied.set(p.id, { name: p.name ?? `Preset ${p.id}`, art: p.art_urls?.[0] ?? p.art_url ?? null })
  }
  const maxSlots = presets?.max_presets ?? 99
  let nextFree = 1
  while (occupied.has(nextFree) && nextFree < maxSlots) nextFree++
  const slotCount = Math.max(24, Math.min(maxSlots, (Math.max(0, ...occupied.keys()) || 0) + 6))
  const [name, setName] = useState('')
  const [confirmSlot, setConfirmSlot] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const commit = async (slot: number): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await onSave(slot, name.trim() || null)
      // success → the wrapper has closed; leave state as-is
    } catch {
      // failure was toasted upstream — reset so the user can retry
      setConfirmSlot(null)
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2.5">
      <div>
        <div className="text-[13px] font-medium truncate">{title}</div>
        {subtitle && <div className="text-[11px] text-faint mt-0.5">{subtitle}</div>}
      </div>
      <input
        autoFocus={nameAutoFocus}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit(nextFree)
        }}
        placeholder="Name (optional)"
        className="w-full bg-bg rounded-lg ring-1 ring-edge focus:ring-edge2 outline-none px-3 py-1.5 text-[13px] placeholder:text-faint"
      />
      <button
        onClick={() => void commit(nextFree)}
        disabled={busy}
        className="w-full px-3 py-2 rounded-lg bg-amber text-bg text-[13px] font-medium disabled:opacity-50 motion-safe:active:scale-95 transition-all"
        data-preset-save-primary
      >
        Save to preset {nextFree}
      </button>
      <div className="grid grid-cols-6 gap-1.5 max-h-[168px] overflow-y-auto">
        {Array.from({ length: slotCount }, (_, i) => i + 1).map((slot) => {
          const occ = occupied.get(slot)
          const taken = occ != null
          const confirming = confirmSlot === slot
          return (
            <button
              key={slot}
              onClick={() => {
                if (!taken) return void commit(slot)
                if (confirming) return void commit(slot)
                setConfirmSlot(slot)
              }}
              data-tip={taken ? `Overwrite “${occ?.name}”` : `Preset ${slot}`}
              className={cx(
                'relative aspect-square rounded-md overflow-hidden ring-1 flex items-center justify-center text-[10.5px] font-mono transition-all',
                confirming
                  ? 'ring-alert bg-alert text-white'
                  : taken
                    ? 'ring-edge2 bg-panel text-dim hover:ring-alert/60'
                    : 'ring-edge bg-panel/60 text-faint hover:text-ink hover:ring-edge2'
              )}
            >
              {confirming ? 'sure?' : taken && occ?.art ? <ArtImage src={occ.art} lazy fallback={<span>{slot}</span>} /> : slot}
            </button>
          )
        })}
      </div>
      <div className="text-[10.5px] text-faint leading-snug">
        Occupied slots need a second click to overwrite.
      </div>
    </div>
  )
}

/** Library ⋯ → save: the shared panel in an anchored popover next to the item. */
export function PresetPicker({
  picker,
  onClose,
  onSave
}: {
  picker: { node: MediaNode; x: number; y: number }
  onClose(): void
  onSave(slot: number, name: string | null): Promise<void>
}): React.JSX.Element {
  usePopoverChrome(onClose)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pos = useClampedPosition(boxRef, picker.x, picker.y)

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={boxRef}
        className="fixed z-50 w-[272px] rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-3"
        style={pos}
      >
        <PresetSavePanel title={picker.node.title} onSave={onSave} />
      </div>
    </>,
    document.body
  )
}
