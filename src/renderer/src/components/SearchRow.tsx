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
  meta,
  playing,
  dimmed,
  onClick
}: {
  title: string
  subtitle?: string | null
  artUrl?: string | null
  icon: React.ComponentType<{ size?: number; className?: string }>
  /** Right-hand detail — a track count, a preset slot, a server name. */
  meta?: string | null
  playing?: boolean
  /** No route to it right now (an unreachable server, a disconnected device). */
  dimmed?: boolean
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      data-search-row={title}
      onClick={onClick}
      disabled={dimmed}
      className={cx(
        // favorites' track-row rhythm — the same ringed floating row at the
        // same density, so results feel like the screens they came from
        'group w-full text-left flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors',
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
        {subtitle && <div className="text-[12px] text-dim truncate">{subtitle}</div>}
      </div>
      {meta && <span className="shrink-0 text-[11px] text-faint tabular-nums">{meta}</span>}
    </button>
  )
}
