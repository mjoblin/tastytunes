import { cx } from '@/lib/format'
import type { usePanelWidth } from '@/hooks/usePanelWidth'

type Props = Pick<ReturnType<typeof usePanelWidth>, 'dragging' | 'snapped' | 'handleProps'>

/**
 * The drawers' left-edge resize grip: invisible until hovered (or dragging),
 * gold while sitting on the default-width detent so the snap is felt AND seen.
 */
export function PanelResizeHandle({ dragging, snapped, handleProps }: Props): React.JSX.Element {
  return (
    <div
      {...handleProps}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      className="group absolute inset-y-0 left-0 w-2 cursor-col-resize touch-none z-10"
    >
      <div
        className={cx(
          'absolute inset-y-0 left-[2px] w-[3px] rounded-full transition-opacity',
          dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          dragging && snapped ? 'bg-gold/70' : 'bg-edge2'
        )}
      />
    </div>
  )
}
