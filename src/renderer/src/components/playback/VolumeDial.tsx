import { ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, Volume2, VolumeX } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { cx } from '@/lib/format'

/**
 * The tray panel's volume control: an arc showing level against the ceiling,
 * with single and 5-step nudges either side.
 *
 * WHY AN ARC RATHER THAN A SLIDER. A horizontal slider needs width to be
 * usable, and width is the one thing a 380px panel hasn't got — it ate the
 * whole transport row, leaving nowhere for a playhead. An arc reads at a
 * glance in a square, which is the shape the top-right corner actually has.
 * (PunyTunes reached the same conclusion; this is that idea in our own
 * chrome.)
 *
 * THE CEILING IS THE VOLUME LIMIT, not 100. If someone capped the app at 60,
 * an arc that shows 60 as "60% round" is describing a number rather than the
 * thing the control does — the arc is full when the app will go no louder.
 */
export function VolumeDial({
  level,
  muted,
  enabled
}: {
  /** Device level 0..100, or null when the model reports none (Control Bus). */
  level: number | null
  muted: boolean
  enabled: boolean
}): React.JSX.Element {
  const step = (delta: number): void => {
    void tt.command({ type: 'volumeStepChange', delta })
  }

  return (
    <div data-volume-dial className="flex items-center gap-1.5 shrink-0">
      {/* MUTE IS ITS OWN BUTTON with the app's own speaker glyph, not a state
          hidden inside the dial. Every other surface spells mute this way, and
          a control you can only find by clicking the number isn't a control. */}
      <button
        data-tip={muted ? 'Unmute — scroll for volume' : 'Mute — scroll for volume'}
        aria-label={muted ? 'Unmute' : 'Mute'}
        disabled={!enabled}
        onClick={() => void tt.command({ type: 'setMute', mute: !muted })}
        className={cx(
          'tip-bottom tip-end p-1 rounded transition-colors',
          !enabled ? 'text-faint/40' : muted ? 'text-gold' : 'text-dim hover:text-ink hover:bg-veil'
        )}
      >
        {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
      </button>

      <VolumeArc size="panel" level={level} muted={muted} enabled={enabled} />

      {/* ±1 and ±5, in a 2x2 to the RIGHT of the arc — singles nearest the
          dial, doubles outboard, so the bigger jump is the further reach. */}
      <div className="grid grid-cols-2 gap-x-1 gap-y-0.5">
        <VolButton tip="Volume up" enabled={enabled} onClick={() => step(1)}>
          <ChevronUp size={12} />
        </VolButton>
        <VolButton tip="Volume up 5" enabled={enabled} onClick={() => step(5)}>
          <ChevronsUp size={12} />
        </VolButton>
        <VolButton tip="Volume down" enabled={enabled} onClick={() => step(-1)}>
          <ChevronDown size={12} />
        </VolButton>
        <VolButton tip="Volume down 5" enabled={enabled} onClick={() => step(-5)}>
          <ChevronsDown size={12} />
        </VolButton>
      </div>
    </div>
  )
}

/**
 * The arc + number on its own, so the mini player can carry the same level
 * display at its own scale. `size` is a NAMED VARIANT, the MediaArt rule: the
 * point of the token is that no caller picks its own number. 'panel' is the
 * tray panel's 36px arc with the 10.5px readout; 'mini' is the mini player's
 * 28px with 9.5px, matching the mono sizes beside it there.
 */
export function VolumeArc({
  level,
  muted,
  enabled,
  size
}: {
  /** Device level 0..100, or null when the model reports none (Control Bus). */
  level: number | null
  muted: boolean
  enabled: boolean
  size: 'panel' | 'mini'
}): React.JSX.Element {
  const limit = useStore((s) => s.settings.volumeLimitPercent)
  const ceiling = limit ?? 100
  const ratio = level == null ? 0 : Math.max(0, Math.min(1, level / Math.max(1, ceiling)))

  // A 270° arc, the gap at the bottom — the dial idiom, and the gap is what
  // makes "empty" distinguishable from "not a dial".
  const R = 13
  const C = 2 * Math.PI * R
  const SWEEP = 0.75

  return (
    <div
      data-volume-arc
      className={cx(
        'relative shrink-0 flex items-center justify-center',
        size === 'panel' ? 'h-9 w-9' : 'h-7 w-7'
      )}
    >
      <svg viewBox="0 0 32 32" className="absolute inset-0 h-full w-full -rotate-[225deg]">
        <circle
          cx="16"
          cy="16"
          r={R}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="stroke-edge2"
          strokeDasharray={`${C * SWEEP} ${C}`}
        />
        <circle
          cx="16"
          cy="16"
          r={R}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className={cx(
            'transition-[stroke-dasharray,stroke] duration-200',
            muted || !enabled ? 'stroke-faint' : 'stroke-gold'
          )}
          strokeDasharray={`${C * SWEEP * ratio} ${C}`}
        />
      </svg>
      {/* The number lives inside the arc — one glance gives the exact level
          and its position against the ceiling. Control Bus has no absolute
          level, so it gets a dash rather than a lie. */}
      <span
        className={cx(
          // panel: 10.5px, not 11.5 — it sat a size above the readouts either
          // side of it, and a three-digit level needs the room inside the arc.
          'relative font-mono tabular-nums leading-none',
          size === 'panel' ? 'text-[10.5px]' : 'text-[9.5px]',
          muted ? 'text-faint' : enabled ? 'text-ink' : 'text-faint/50'
        )}
      >
        {level ?? '–'}
      </span>
    </div>
  )
}

function VolButton({
  children,
  tip,
  enabled,
  onClick
}: {
  children: React.ReactNode
  tip: string
  enabled: boolean
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      data-tip={tip}
      aria-label={tip}
      disabled={!enabled}
      onClick={onClick}
      className={cx(
        'tip-bottom tip-end px-0.5 leading-none rounded transition-colors',
        enabled ? 'text-faint hover:text-ink hover:bg-veil' : 'text-faint/30'
      )}
    >
      {children}
    </button>
  )
}
