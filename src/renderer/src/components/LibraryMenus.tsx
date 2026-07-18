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
  onSavePreset
}: {
  menu: { node: MediaNode; x: number; y: number }
  onClose(): void
  onAction(action: MediaQueueAction | 'PLAY', playFromId?: string): void
  onSavePreset(): void
}): React.JSX.Element {
  const { node } = menu
  const items: Array<{ label: string; run: () => void }> = node.isContainer
    ? [
        { label: 'Play', run: () => onAction('PLAY') },
        { label: 'Play next', run: () => onAction('PLAY_NEXT') },
        { label: 'Add to end of queue', run: () => onAction('APPEND') },
        { label: 'Replace queue', run: () => onAction('REPLACE') },
        { label: 'Save to preset…', run: onSavePreset }
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
        { label: 'Save to preset…', run: onSavePreset }
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

export function PresetPicker({
  picker,
  onClose,
  onSave
}: {
  picker: { node: MediaNode; x: number; y: number }
  onClose(): void
  onSave(slot: number): void
}): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  const occupied = new Map<number, string | null>()
  for (const p of presets?.presets ?? []) {
    if (p.id != null) occupied.set(p.id, p.art_url)
  }
  let nextFree = 1
  while (occupied.has(nextFree) && nextFree < 99) nextFree++
  const slotCount = Math.max(24, Math.min(99, (Math.max(0, ...occupied.keys()) ?? 0) + 6))
  const [confirmSlot, setConfirmSlot] = useState<number | null>(null)
  usePopoverChrome(onClose)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pos = useClampedPosition(boxRef, picker.x, picker.y)

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={boxRef}
        className="fixed z-50 w-[264px] rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-3 space-y-2.5"
        style={pos}
      >
        <div className="text-[11px] text-faint truncate">{picker.node.title}</div>
        <button
          onClick={() => onSave(nextFree)}
          className="w-full px-3 py-2 rounded-lg bg-amber text-bg text-[13px] font-medium motion-safe:active:scale-95 transition-all"
          data-preset-save-primary
        >
          Save to preset {nextFree}
        </button>
        <div className="grid grid-cols-6 gap-1.5 max-h-[168px] overflow-y-auto">
          {Array.from({ length: slotCount }, (_, i) => i + 1).map((slot) => {
            const art = occupied.get(slot)
            const taken = occupied.has(slot)
            const confirming = confirmSlot === slot
            return (
              <button
                key={slot}
                onClick={() => {
                  if (!taken) return onSave(slot)
                  if (confirming) return onSave(slot)
                  setConfirmSlot(slot)
                }}
                data-tip={taken ? `Overwrite preset ${slot}` : `Preset ${slot}`}
                className={cx(
                  'relative aspect-square rounded-md overflow-hidden ring-1 flex items-center justify-center text-[10.5px] font-mono transition-all',
                  confirming
                    ? 'ring-alert bg-alert text-white'
                    : taken
                      ? 'ring-edge2 bg-panel text-dim hover:ring-alert/60'
                      : 'ring-edge bg-panel/60 text-faint hover:text-ink hover:ring-edge2'
                )}
              >
                {confirming ? (
                  'sure?'
                ) : taken && art ? (
                  <ArtImage src={art} lazy fallback={<span>{slot}</span>} />
                ) : (
                  slot
                )}
              </button>
            )
          })}
        </div>
        <div className="text-[10.5px] text-faint leading-snug">
          Occupied slots need a second click to overwrite.
        </div>
      </div>
    </>,
    document.body
  )
}
