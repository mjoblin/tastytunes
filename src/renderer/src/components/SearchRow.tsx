import { ArtImage } from '@/components/ArtImage'
import { cx } from '@/lib/format'

/**
 * One search result, for the four LOCAL groups (library, favorites, playlists,
 * presets). Internet radio keeps its own StationRow — a station carries
 * metadata and actions nothing else here has.
 *
 * ONE row shape across four groups on purpose. Importing each screen's own row
 * would drag four visual languages into a single list and make results read as
 * screens stapled together; what must not be re-implemented is the ACTIONS, and
 * those live in shared helpers (lib/favorites, playlistActivate, recallPreset,
 * mediaQueueAdd) that both the screens and this list call.
 *
 * The icon fallback carries the group's identity when there's no art, which is
 * most of the time for playlists and presets.
 */
export function SearchRow({
  title,
  subtitle,
  artUrl,
  icon: Icon,
  badge,
  meta,
  playing,
  dimmed,
  actions,
  onClick
}: {
  title: string
  subtitle?: string | null
  artUrl?: string | null
  icon: React.ComponentType<{ size?: number; className?: string }>
  /** WHAT this is — Track, Album, Artist, Playlist… Search is the one list in
   *  the app whose neighbours are different kinds of thing, so the kind has to
   *  be on the row; without it the click contract looks arbitrary. */
  badge?: string
  /** Right-hand detail — a track count, a preset slot, a server name. */
  meta?: string | null
  playing?: boolean
  /** No route to it right now (an unreachable server, a disconnected device). */
  dimmed?: boolean
  /** Hover-revealed RowActions, as every other list in the app has. */
  actions?: React.ReactNode
  onClick(): void
}): React.JSX.Element {
  return (
    <div
      data-search-row={title}
      role="button"
      tabIndex={dimmed ? -1 : 0}
      onClick={() => !dimmed && onClick()}
      onKeyDown={(e) => {
        if (dimmed) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={cx(
        // favorites' track-row rhythm — the same ringed floating row at the
        // same density, so results feel like the screens they came from
        'group w-full text-left flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors',
        !dimmed && 'cursor-pointer',
        playing
          ? 'row-playing bg-gold/10'
          : 'ring-1 ring-edge bg-panel/60 hover:bg-raised/70 hover:ring-edge2',
        dimmed && 'opacity-50 cursor-default'
      )}
    >
      <div className="h-9 w-9 shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage src={artUrl ?? null} lazy fallback={<Icon size={15} className="text-faint" />} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={cx('text-[13.5px] truncate', playing ? 'text-gold' : 'text-ink')}>{title}</div>
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
    </div>
  )
}
