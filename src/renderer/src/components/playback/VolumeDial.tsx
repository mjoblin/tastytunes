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
  const limit = useStore((s) => s.settings.volumeLimitPercent)
  const ceiling = limit ?? 100
  const ratio = level == null ? 0 : Math.max(0, Math.min(1, level / Math.max(1, ceiling)))

  // A 270° arc, the gap at the bottom — the dial idiom, and the gap is what
  // makes "empty" distinguishable from "not a dial".
  const R = 13
  const C = 2 * Math.PI * R
  const SWEEP = 0.75

  const step = (delta: number): void => {
    void tt.command({ type: 'volumeStepChange', delta })
  }

  return (
    <div className="flex items-center gap-1 shrink-0">
      <div className="flex flex-col">
        <VolButton tip="Volume up 5" enabled={enabled} onClick={() => step(5)}>
          <ChevronsUp size={11} />
        </VolButton>
        <VolButton tip="Volume down 5" enabled={enabled} onClick={() => step(-5)}>
          <ChevronsDown size={11} />
        </VolButton>
      </div>

      <button
        data-tip={muted ? 'Unmute — scroll for volume' : 'Mute — scroll for volume'}
        aria-label={muted ? 'Unmute' : 'Mute'}
        disabled={!enabled}
        onClick={() => void tt.command({ type: 'setMute', mute: !muted })}
        className="tip-bottom tip-end relative h-9 w-9 shrink-0 flex items-center justify-center rounded-full hover:bg-veil transition-colors disabled:hover:bg-transparent"
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
        {/* The number lives INSIDE the arc — one glance gives both the exact
            level and its position against the ceiling. Control Bus has no
            absolute level, so it gets the speaker icon instead of a lie. */}
        {level == null ? (
          muted ? (
            <VolumeX size={13} className="relative text-gold" />
          ) : (
            <Volume2 size={13} className={cx('relative', enabled ? 'text-dim' : 'text-faint/50')} />
          )
        ) : (
          <span
            className={cx(
              'relative font-mono text-[11px] tabular-nums leading-none',
              muted ? 'text-gold' : enabled ? 'text-ink' : 'text-faint/50'
            )}
          >
            {muted ? <VolumeX size={12} /> : level}
          </span>
        )}
      </button>

      <div className="flex flex-col">
        <VolButton tip="Volume up" enabled={enabled} onClick={() => step(1)}>
          <ChevronUp size={11} />
        </VolButton>
        <VolButton tip="Volume down" enabled={enabled} onClick={() => step(-1)}>
          <ChevronDown size={11} />
        </VolButton>
      </div>
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
