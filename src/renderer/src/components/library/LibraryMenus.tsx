import { useState } from 'react'
import type { MediaNode, MediaQueueAction } from '@shared/model'
import { useStore } from '@/store'
import { cx } from '@/lib/format'
import { isAlbumClass, isArtistClass } from '@/lib/media'
import { fromNode } from '@/lib/mediaRef'
import {
  albumMenuItems,
  artistMenuItems,
  trackMenuItems,
  type MediaMenuCaps,
  type MediaMenuItem
} from '@/lib/mediaMenus'
import type { SearchBack } from '@/store'
import { PopoverCard } from '@/components/chrome/Overlay'
import { useConfirmTap } from '@/hooks/useConfirmTap'
import { ArtImage } from '@/components/media/ArtImage'

// ------------------------------------------------------------------- ⋯ menu

export function ItemMenu({
  menu,
  onClose,
  onAction,
  onSavePreset,
  onAddToPlaylist,
  goToAlbum,
  goToArtist,
  searchFrom,
  favorite,
  onInfo
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
  /** Back-link the search pivot records — see mediaMenus. */
  searchFrom?: SearchBack
  /** Overrides the builders' derived heart (the library stores richer
   *  favorites — titlePath from the crumbs). */
  favorite?: { active: boolean; toggle(): void }
  /** Open the Info modal on this node (every entity menu offers it). */
  onInfo?(): void
}): React.JSX.Element {
  const { node } = menu
  // The item lists come from the per-entity builders (lib/mediaMenus) — the
  // same lists every other surface composes, so a track's menu here IS a
  // track's menu everywhere. PLAIN FOLDERS stay outside the entity system on
  // purpose: a folder is filing, not media — it gets the queue verbs and
  // nothing content-shaped (no pivot, no heart, no playlist).
  const ref = fromNode(node)
  const caps: MediaMenuCaps = {
    playNow: () => onAction(node.isContainer ? 'PLAY' : 'PLAY_NOW'),
    playNext: () => onAction('PLAY_NEXT'),
    append: () => onAction('APPEND'),
    replaceQueue: () => onAction('REPLACE'),
    extraQueueVerbs:
      !node.isContainer && node.parentId
        ? [{ label: 'Play album from here', run: () => onAction('PLAY_FROM_HERE', node.id) }]
        : undefined,
    goToAlbum,
    goToArtist,
    saveToPreset: onSavePreset,
    addToPlaylist: onAddToPlaylist,
    heart: favorite,
    searchFrom,
    info: onInfo
  }
  const items: MediaMenuItem[] =
    node.isContainer && isArtistClass(node.upnpClass)
      ? artistMenuItems(ref, { searchFrom })
      : node.isContainer && !isAlbumClass(node.upnpClass)
        ? [
            { label: 'Play', run: () => onAction('PLAY') },
            { label: 'Play next', run: () => onAction('PLAY_NEXT') },
            { label: 'Add to end of queue', run: () => onAction('APPEND') },
            { label: 'Replace queue', run: () => onAction('REPLACE') },
            { label: 'Save to preset…', run: onSavePreset },
            ...(onInfo ? [{ label: 'Info…', run: onInfo }] : [])
          ]
        : node.isContainer
          ? albumMenuItems(ref, caps)
          : trackMenuItems(ref, caps)

  return (
    <PopoverCard
      at={menu}
      width="w-52"
      onClose={onClose}
      rightClickCloses
      className="p-1.5 space-y-0.5"
    >
      <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint truncate">{node.title}</div>
      {items.map((item) => (
        <button
          key={item.label}
          onClick={() => {
            // close-then-run, the RowMenu contract — builder items (pivot,
            // heart) don't know about this menu's state, and callers that
            // also close themselves just close twice, harmlessly
            onClose()
            item.run()
          }}
          className="w-full px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim hover:text-ink hover:bg-veil transition-colors"
        >
          {item.label}
        </button>
      ))}
    </PopoverCard>
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
  const overwrite = useConfirmTap<number>()
  const [busy, setBusy] = useState(false)

  const commit = async (slot: number): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await onSave(slot, name.trim() || null)
      // success → the wrapper has closed; leave state as-is
    } catch {
      // failure was toasted upstream — reset so the user can retry
      overwrite.disarm()
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
        className="w-full px-3 py-2 rounded-lg bg-amber text-bg text-[13px] font-medium disabled:opacity-50 motion-safe:active:scale-95"
        data-preset-save-primary
      >
        Save to preset {nextFree}
      </button>
      <div className="grid grid-cols-6 gap-1.5 max-h-[168px] overflow-y-auto">
        {Array.from({ length: slotCount }, (_, i) => i + 1).map((slot) => {
          const occ = occupied.get(slot)
          const taken = occ != null
          const confirming = overwrite.isArmed(slot)
          return (
            <button
              key={slot}
              onClick={() => {
                // A free slot saves on the first click; an occupied one arms,
                // then commits on the second (and disarms on a timer or on the
                // focus leaving it — useConfirmTap's rule, app-wide).
                if (!taken || overwrite.tap(slot)) void commit(slot)
              }}
              {...overwrite.blurProps}
              data-tip={taken ? `Overwrite “${occ?.name}”` : `Preset ${slot}`}
              className={cx(
                // No transition — this grid mounts inside the frosted
                // ModalShell (save-queue), where animated hovers crawl on
                // software rendering; see the shell's doc comment.
                'relative aspect-square rounded-md overflow-hidden ring-1 flex items-center justify-center text-[10.5px] font-mono',
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
  /** Only the title is read — loosened from MediaNode so any surface with a
   *  name (a queue row, a search result) can offer the picker. */
  picker: { node: Pick<MediaNode, 'title'>; x: number; y: number }
  onClose(): void
  onSave(slot: number, name: string | null): Promise<void>
}): React.JSX.Element {
  return (
    <PopoverCard at={picker} width="w-[272px]" onClose={onClose} className="p-3">
      <PresetSavePanel title={picker.node.title} onSave={onSave} />
    </PopoverCard>
  )
}
