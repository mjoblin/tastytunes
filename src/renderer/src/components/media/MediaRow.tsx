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
 * scale (13.5/12; the `dense` panel variant runs 13.5/11.5-faint — see the
 * prop), one art size per variant, one playing/tuning treatment — and a
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
  parked,
  slot
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
   * The row-anatomy law fixes the ART (32px here — the `dense` variant) and
   * the TITLE at 13.5px; neither moves. The SUBTITLE is the one line that
   * differs by law: 11.5px `faint` here vs the window rows' 12px `dim`
   * (amended at the user's call, 2026-08-04 — in a 380px glanceable panel
   * the second line is wayfinding, not content, and the AA-retuned `faint`
   * lets it be quieter without dropping under the contrast floor). Those
   * tokens are what make a row recognisably the same object across
   * surfaces; anything that wants a genuinely smaller row wants a different
   * row (see the panel's compressed mode, which drops the art entirely
   * rather than shrinking it).
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
  /**
   * Device slot number, rendered as a fixed-width zero-padded mono cell
   * between the art and the name — the flat skin's position cell, adopted
   * here for rows whose identity IS a slot (the tray panel's preset rows,
   * whose second line said "Preset N" on every row: boilerplate wearing a
   * subtitle's clothes; user call 2026-08-04). The cell is present in every
   * state and the number is always two glyphs, so names share one left edge.
   * Playing/tuning markers move INTO the cell, replacing the number — the
   * flat skin's rule — instead of stacking beside it in the title row.
   */
  slot?: number
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
        'group w-full text-left flex items-center transition-colors',
        // A dense row squares off to `rounded-md`, matching the compact rows
        // it shares a panel with — the two densities are the same list seen
        // two ways, and a 12px corner beside a 6px one reads as two different
        // kinds of thing. The window's rows keep `rounded-xl`: nothing there
        // sits next to a compact row.
        // pl-1 == py-1: the art sits the same distance from the row's left
        // edge as from its top and bottom. pr-2 keeps the trailing duration off
        // the edge, which is a different job.
        dense ? 'gap-2.5 pl-1 pr-2 py-1 rounded-md' : 'gap-3 px-3 py-2.5 rounded-xl',
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
      <MediaArt src={artUrl} kind={kind} icon={icon} size={dense ? 'dense' : 'row'} />
      {slot != null && (
        <span
          data-slot={String(slot).padStart(2, '0')}
          className="shrink-0 w-[18px] flex justify-center font-mono text-[10.5px] text-faint tabular-nums"
        >
          {playing ? (
            <Eqbars playing />
          ) : tuning ? (
            <Loader2 size={13} className="spin text-gold/80" />
          ) : (
            String(slot).padStart(2, '0')
          )}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div
          className={cx(
            'flex items-center gap-2 text-[13.5px] truncate',
            dense && 'leading-tight',
            playing ? 'text-gold' : tuning ? 'text-gold/80' : 'text-ink'
          )}
        >
          {/* the floating skin has no position cell, so the playing state
              lives inline before the title — the flat skin's rule is the
              position cell; both are one glance from the name. A row WITH a
              slot cell has a position cell again, and the markers live there
              instead. */}
          {playing && slot == null && <Eqbars playing />}
          {tuning && slot == null && <Loader2 size={13} className="spin shrink-0" />}
          <span className="truncate">{title}</span>
        </div>
        <div className={cx('flex items-center gap-1.5 min-w-0', dense && 'leading-tight')}>
          {badge && (
            <span className="shrink-0 text-[10px] uppercase tracking-wide font-mono text-faint/80 ring-1 ring-edge rounded px-1 py-px">
              {badge}
            </span>
          )}
          {subtitle && (
            <div
              data-row-subtitle
              className={cx(
                'truncate',
                dense ? 'text-[11.5px] text-faint' : 'text-[12px] text-dim'
              )}
            >
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {actions && <div className="shrink-0 flex items-center gap-0.5">{actions}</div>}
      {meta && <span className="shrink-0 text-[11px] text-faint tabular-nums">{meta}</span>}
      {duration !== undefined && <DurationCell secs={duration} />}
    </div>
  )
}
