import { Loader2 } from 'lucide-react'
import { DurationCell } from '@/components/media/DurationCell'
import { MediaArt, type MediaArtKind } from '@/components/media/MediaArt'
import { Eqbars } from '@/components/media/Eqbars'
import { cx } from '@/lib/format'

/**
 * THE floating row — the app's second row skin, for heterogeneous collection
 * and result feeds you scan (Favorites, Search, Recently Played, Radio).
 * Ordered, editable lists you work in (queue, playlist detail, library
 * listings) keep the FLAT grid skin with hairlines; the two skins share their
 * primitives (MediaArt, DurationCell, RowAction, RowHeart), not a wrapper.
 *
 * Grew out of SearchRow when the audit found Favorites, Recents and Radio each
 * hand-rolling the same ringed row at drifting sizes. One shell means one type
 * scale (13.5/12), one art size, one playing/tuning treatment — and a
 * `duration` slot that reserves its width, so a row without a known length
 * can't let the heart drift out of line (the screenshot that started this).
 */
export function MediaRow({
  title,
  subtitle,
  artUrl,
  kind,
  icon,
  badge,
  meta,
  duration,
  playing,
  tuning,
  dimmed,
  actions,
  onClick,
  onContextMenu,
  attrs,
  dense,
  parked
}: {
  title: string
  subtitle?: React.ReactNode
  artUrl?: string | null
  /** Picks the art fallback icon — see MediaArt. */
  kind?: MediaArtKind
  icon?: React.ComponentType<{ size?: number; className?: string }>
  /** WHAT this is — Track, Album, Artist… Only where kinds interleave in one
   *  list (Search); grouped screens say it with section headers instead. */
  badge?: string
  /** Right-hand detail — codec/bitrate, a preset slot, a relative time. */
  meta?: React.ReactNode
  /** Track length. Pass null/undefined-able seconds to RESERVE the column
   *  ('–:––' when unknown); omit the prop entirely for kinds without one. */
  duration?: number | null
  playing?: boolean
  /** Play sent, stream/queue not landed yet — half-lit, spinner by the title. */
  tuning?: boolean
  /** No route to it right now (an unreachable server, a disconnected device). */
  dimmed?: boolean
  /** Hover-revealed RowActions + RowHeart, as every list has. */
  actions?: React.ReactNode
  onClick?(el: HTMLElement | null): void
  onContextMenu?(e: React.MouseEvent): void
  /** data-* passthrough for flash targets and harnesses. */
  attrs?: Record<string, string | undefined>
  /**
   * Tighter padding, for surfaces where vertical space is the scarce thing —
   * the tray panel, which is 380px wide and has ~340px of body.
   *
   * PADDING ONLY, and deliberately so: the row-anatomy law fixes the ART at
   * 40px and the TITLE at 13.5px, and neither moves here. Those tokens are
   * what make a row recognisably the same object across surfaces; the box it
   * sits in is not one of them. Anything that wants a genuinely smaller row
   * wants a different row (see the panel's compressed mode, which drops the
   * art entirely rather than shrinking it).
   */
  dense?: boolean
  /**
   * The current row of a queue whose source ISN'T the audible one — a radio
   * preset or AirPlay is playing, and this is merely where the queue will
   * resume. Set apart quietly rather than dressed as playing: the device
   * keeps reporting a play_id regardless, and eqbars dancing on a track that
   * stopped minutes ago is a lie. The flat skin has drawn this distinction
   * since the AirPlay round; this gives the floating skin the same word.
   */
  parked?: boolean
}): React.JSX.Element {
  return (
    <div
      {...attrs}
      data-media-row={title}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick && !dimmed ? 0 : undefined}
      onClick={(e) => !dimmed && onClick?.(e.currentTarget as HTMLElement)}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (dimmed || !onClick) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick(e.currentTarget as HTMLElement)
        }
      }}
      className={cx(
        'group w-full text-left flex items-center rounded-xl transition-colors',
        dense ? 'gap-2.5 px-2 py-1' : 'gap-3 px-3 py-2.5',
        onClick && !dimmed && 'cursor-pointer',
        playing
          ? 'row-playing bg-gold/10'
          : tuning
            ? 'ring-1 ring-gold/40 bg-golddim/40' // half-lit: on its way to playing
            : parked
              ? 'ring-1 ring-edge2 bg-veil/60 hover:bg-veil'
              : 'ring-1 ring-edge bg-panel/60 hover:bg-raised/70 hover:ring-edge2',
        dimmed && 'opacity-50 cursor-default'
      )}
    >
      <MediaArt src={artUrl} kind={kind} icon={icon} />
      <div className="min-w-0 flex-1">
        <div
          className={cx(
            'flex items-center gap-2 text-[13.5px] truncate',
            playing ? 'text-gold' : tuning ? 'text-gold/80' : 'text-ink'
          )}
        >
          {/* the floating skin has no position cell, so the playing state
              lives inline before the title — the flat skin's rule is the
              position cell; both are one glance from the name */}
          {playing && <Eqbars playing />}
          {tuning && <Loader2 size={13} className="spin shrink-0" />}
          <span className="truncate">{title}</span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          {badge && (
            <span className="shrink-0 text-[10px] uppercase tracking-wide font-mono text-faint/80 ring-1 ring-edge rounded px-1 py-px">
              {badge}
            </span>
          )}
          {subtitle && <div className="text-[12px] text-dim truncate">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="shrink-0 flex items-center gap-0.5">{actions}</div>}
      {meta && <span className="shrink-0 text-[11px] text-faint tabular-nums">{meta}</span>}
      {duration !== undefined && <DurationCell secs={duration} />}
    </div>
  )
}
