import { useRef } from 'react'
import { Disc3, Folder, Heart, MoreHorizontal, Play } from 'lucide-react'
import type { MediaNode } from '@shared/ipc'
import { cx, fmtTime } from '@/lib/format'
import { isAlbumClass, isMutedArt } from '@/lib/media'
import { ArtImage } from '@/components/ArtImage'
import { Eqbars } from '@/components/Eqbars'

// The Library's four listing renderers — cards and rows for containers and
// tracks. Pure presentation: every action arrives as a callback.

/**
 * Art-corner heart (top-right — the preset-card speaker-chip idiom):
 * hover-revealed control normally, but a set heart stays visible in gold —
 * presence + color IS the indicator. A DIRECT child of the (scaling) card,
 * not of the art tile: it still zooms with the hover animation, but its
 * tooltip escapes the art's overflow-hidden clip (tip grows inward via
 * tip-end so it never pokes past the scrollport either).
 */
function HeartChip({
  favorited,
  held,
  onHeart
}: {
  favorited: boolean
  /** The card's menu is open — match the other chips' held visibility. */
  held: boolean
  onHeart(): void
}): React.JSX.Element {
  return (
    <span
      data-tip={favorited ? 'Remove from favorites' : 'Add to favorites'}
      data-card-heart={favorited ? 'on' : 'off'}
      onClick={(e) => {
        e.stopPropagation()
        onHeart()
      }}
      className={cx(
        // 14px = the card's p-2 plus the chips' 6px inset from the art corner
        'tip-bottom tip-end absolute top-3.5 right-3.5 z-10 h-8 w-8 rounded-lg bg-panel/80 ring-1 ring-edge flex items-center justify-center transition-all motion-safe:active:scale-90 cursor-pointer',
        favorited
          ? 'text-gold opacity-100'
          : cx('text-dim hover:text-ink', held ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')
      )}
    >
      <Heart size={14} fill={favorited ? 'currentColor' : 'none'} />
    </span>
  )
}

export function ContainerCard({
  node,
  playing,
  audible,
  menuOpen,
  favorited,
  onHeart,
  onEnter,
  onPlay,
  onMenu
}: {
  node: MediaNode
  /** The playing track belongs to this album (and the queue source is live). */
  playing: boolean
  /** Transport is actually in the play state (eqbars animate vs freeze). */
  audible: boolean
  /** This card's ⋯ menu or preset picker is open — hold the hover treatment. */
  menuOpen: boolean
  /** With onHeart: the art-corner heart chip (albums only make sense). */
  favorited?: boolean
  onHeart?(): void
  onEnter(): void
  onPlay(el: HTMLElement | null): void
  onMenu(e: React.MouseEvent): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  // Queue/preset verbs only make sense on albums — plain folders (artist
  // dirs, USB volumes, Asset's virtual views) get no chips and no menu.
  const album = isAlbumClass(node.upnpClass)
  const muted = isMutedArt(node)
  const subtitle = [node.artist, node.year].filter(Boolean).join(' · ')
  return (
    // Preset-card idiom: inset tile, hover grow + lift + glow; the highlight
    // wraps the gray tile so it stays legible over gold/orange covers.
    <div
      ref={ref}
      onContextMenu={album ? onMenu : undefined}
      data-library-card
      className={cx(
        'group relative text-left rounded-2xl p-2 pb-2.5 transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]',
        playing ? 'bg-goldtile/70 tile-playing' : 'bg-raised/70 ring-1 ring-edge card-hover-glow',
        // held while this card's ⋯ menu / preset picker is open — the pointer
        // has left, but the card is still what's being acted on: keep the
        // full hover treatment (grow + glow), not just a ring
        menuOpen && 'ring-1 ring-edge2 z-10 motion-safe:scale-[1.04] card-glow-held'
      )}
    >
      {/* the card CENTER always enters — play/menu are corner chips on the
          art, never intercepting the open gesture (unlike preset cards,
          whose whole-card click IS the play action) */}
      <button className="block w-full cursor-pointer" onClick={onEnter}>
        <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-panel/70 flex items-center justify-center">
          <ArtImage
            src={node.artUrl}
            lazy
            className={cx('h-full w-full object-cover', muted && 'opacity-60 saturate-[.6]')}
            fallback={
              album ? (
                <Disc3 size={34} strokeWidth={1.2} className="text-faint" />
              ) : (
                <Folder size={34} strokeWidth={1.2} className="text-faint" />
              )
            }
          />
          {muted && node.artUrl && (
            <div className="absolute inset-0 pointer-events-none bg-panel/30" />
          )}
          {playing && (
            <span className="absolute top-1.5 left-1.5 h-7 w-7 rounded-lg bg-panel/80 ring-1 ring-edge flex items-center justify-center">
              <Eqbars playing={audible} />
            </span>
          )}
          {album && (
            <span
              onClick={(e) => {
                e.stopPropagation()
                onPlay(ref.current)
              }}
              data-tip="Play — replaces the queue"
              className={cx(
                'tip-bottom absolute bottom-1.5 left-1.5 h-11 w-11 rounded-full bg-amber text-bg flex items-center justify-center transition-all duration-150 motion-safe:hover:scale-110 hover:shadow-[0_0_24px_rgb(var(--amber-rgb)_/_0.6)]',
                menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
            >
              <Play size={18} fill="currentColor" />
            </span>
          )}
          {album && (
            <span
              aria-label="More actions"
              onClick={onMenu}
              className={cx(
                'absolute bottom-1.5 right-1.5 h-8 w-8 rounded-lg bg-panel/80 ring-1 ring-edge text-dim hover:text-ink flex items-center justify-center transition-all',
                menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
            >
              <MoreHorizontal size={15} />
            </span>
          )}
        </div>
        <div
          className={cx(
            'pt-1.5 text-[12.5px] truncate text-left',
            playing ? 'text-gold' : 'text-ink'
          )}
        >
          {node.title}
        </div>
        {subtitle && (
          <div className="text-[11.5px] text-faint truncate text-left">{subtitle}</div>
        )}
      </button>
      {album && onHeart && (
        <HeartChip favorited={favorited === true} held={menuOpen} onHeart={onHeart} />
      )}
    </div>
  )
}

/** Row-cluster heart: hover-revealed control, permanently gold when set. */
function RowHeart({
  favorited,
  held,
  onHeart
}: {
  favorited: boolean
  held: boolean
  onHeart(): void
}): React.JSX.Element {
  return (
    <button
      aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
      data-row-heart={favorited ? 'on' : 'off'}
      onClick={(e) => {
        e.stopPropagation()
        onHeart()
      }}
      className={cx(
        'p-1.5 rounded-lg transition-all motion-safe:active:scale-90',
        favorited
          ? 'text-gold hover:text-ink'
          : cx(
              'text-dim hover:text-ink hover:bg-veil2',
              held ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )
      )}
    >
      <Heart size={13} fill={favorited ? 'currentColor' : 'none'} />
    </button>
  )
}

export function ContainerRow({
  node,
  playing,
  audible,
  menuOpen,
  favorited,
  onHeart,
  onEnter,
  onMenu
}: {
  node: MediaNode
  playing: boolean
  audible: boolean
  menuOpen: boolean
  /** With onHeart: the heart button in the row's action cluster (albums). */
  favorited?: boolean
  onHeart?(): void
  onEnter(): void
  onMenu(e: React.MouseEvent): void
}): React.JSX.Element {
  // Same rule as cards: only albums carry the ⋯ menu.
  const album = isAlbumClass(node.upnpClass)
  const muted = isMutedArt(node)
  return (
    <div
      className={cx(
        'group grid grid-cols-[44px_1fr_auto_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5 cursor-pointer transition-colors',
        playing ? 'row-playing bg-gold/10' : menuOpen ? 'bg-veil' : 'hover:bg-veil'
      )}
      onClick={onEnter}
      onContextMenu={album ? onMenu : undefined}
      data-library-row
    >
      <div className="h-10 w-10 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage
          src={node.artUrl}
          lazy
          className={cx('h-full w-full object-cover', muted && 'opacity-60 saturate-[.6]')}
          fallback={
            album ? (
              <Disc3 size={16} className="text-faint" />
            ) : (
              <Folder size={16} className="text-faint" />
            )
          }
        />
      </div>
      <div className="min-w-0">
        <div className={cx('text-[13.5px] truncate', playing ? 'text-gold' : 'text-ink')}>
          {node.title}
        </div>
        {node.artist && <div className="text-[12px] text-faint truncate">{node.artist}</div>}
      </div>
      {playing ? <Eqbars playing={audible} /> : <span />}
      {album && onHeart ? (
        <RowHeart favorited={favorited === true} held={menuOpen} onHeart={onHeart} />
      ) : (
        <span />
      )}
      {album ? (
        <button
          aria-label="More actions"
          onClick={onMenu}
          className={cx(
            'p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all',
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          <MoreHorizontal size={14} />
        </button>
      ) : (
        <span />
      )}
    </div>
  )
}

export function TrackRow({
  node,
  showArt,
  isCurrent,
  audible,
  queued,
  menuOpen,
  favorited,
  onHeart,
  onPlayNow,
  onMenu
}: {
  node: MediaNode
  /** Loose tracks in mixed folders get a thumb; album views carry the art in the header. */
  showArt: boolean
  /** This is what's playing right now (queue source live) — queue-row treatment. */
  isCurrent: boolean
  audible: boolean
  /** Already in the queue — a click jumps there instead of inserting. */
  queued: boolean
  menuOpen: boolean
  /** With onHeart: the heart button in the row's action cluster. */
  favorited?: boolean
  onHeart?(): void
  onPlayNow(el: HTMLElement | null): void
  onMenu(e: React.MouseEvent): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  return (
    <div
      ref={ref}
      className={cx(
        'group grid items-center gap-3 rounded-lg px-2 py-1.5 cursor-pointer transition-colors',
        showArt ? 'grid-cols-[26px_44px_1fr_auto_auto]' : 'grid-cols-[26px_1fr_auto_auto]',
        isCurrent ? 'row-playing bg-gold/10' : menuOpen ? 'bg-veil' : 'hover:bg-veil'
      )}
      onClick={() => onPlayNow(ref.current)}
      onContextMenu={onMenu}
      data-library-track
    >
      {/* left-justified: numbers sit flush with the header/art above */}
      <span className="font-mono text-[10.5px] text-faint tabular-nums">
        {isCurrent ? <Eqbars playing={audible} /> : (node.trackNumber ?? '')}
      </span>
      {showArt && (
        <div className="h-10 w-10 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
          <ArtImage src={node.artUrl} lazy fallback={<Disc3 size={16} className="text-faint" />} />
        </div>
      )}
      <div className="min-w-0">
        <div className={cx('text-[13.5px] truncate', isCurrent ? 'text-gold' : 'text-ink')}>
          {node.title}
        </div>
        {node.artist && <div className="text-[12px] text-faint truncate">{node.artist}</div>}
      </div>
      {/* per-button reveal (not on the wrapper): a set heart must stay
          visible on the resting row while play/⋯ remain hover-only */}
      <div className="flex items-center gap-0.5">
        {onHeart && (
          <RowHeart favorited={favorited === true} held={menuOpen} onHeart={onHeart} />
        )}
        <button
          aria-label="Play"
          data-tip={queued ? 'Play — already in the queue' : 'Play now'}
          onClick={(e) => {
            e.stopPropagation()
            onPlayNow(ref.current)
          }}
          className={cx(
            'tip-bottom p-1.5 rounded-lg text-dim hover:text-gold hover:bg-veil2 transition-all',
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          <Play size={14} />
        </button>
        <button
          aria-label="More actions"
          onClick={onMenu}
          className={cx(
            'p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all',
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      <span className="font-mono text-[11px] text-faint tabular-nums">
        {node.durationSecs != null ? fmtTime(node.durationSecs) : ''}
      </span>
    </div>
  )
}

/** A loose track as a card (Title views, mixed folders) — click = Play now. */
export function TrackCard({
  node,
  isCurrent,
  audible,
  queued,
  menuOpen,
  favorited,
  onHeart,
  onPlayNow,
  onMenu
}: {
  node: MediaNode
  isCurrent: boolean
  audible: boolean
  queued: boolean
  menuOpen: boolean
  /** With onHeart: the art-corner heart chip. */
  favorited?: boolean
  onHeart?(): void
  onPlayNow(el: HTMLElement | null): void
  onMenu(e: React.MouseEvent): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  return (
    <div
      ref={ref}
      onContextMenu={onMenu}
      data-library-track-card
      className={cx(
        'group relative text-left rounded-2xl p-2 pb-2.5 transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]',
        isCurrent ? 'bg-goldtile/70 tile-playing' : 'bg-raised/70 ring-1 ring-edge card-hover-glow',
        menuOpen && 'ring-1 ring-edge2 z-10 motion-safe:scale-[1.04] card-glow-held'
      )}
    >
      <button className="block w-full cursor-pointer" onClick={() => onPlayNow(ref.current)}>
        <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-panel/70 flex items-center justify-center">
          <ArtImage
            src={node.artUrl}
            lazy
            fallback={<Disc3 size={34} strokeWidth={1.2} className="text-faint" />}
          />
          {isCurrent && (
            <span className="absolute top-1.5 left-1.5 h-7 w-7 rounded-lg bg-panel/80 ring-1 ring-edge flex items-center justify-center">
              <Eqbars playing={audible} />
            </span>
          )}
          <span
            data-tip={queued ? 'Play — already in the queue' : 'Play now'}
            className={cx(
              'tip-bottom absolute bottom-1.5 left-1.5 h-11 w-11 rounded-full bg-amber text-bg flex items-center justify-center transition-all duration-150 motion-safe:hover:scale-110 hover:shadow-[0_0_24px_rgb(var(--amber-rgb)_/_0.6)]',
              menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <Play size={18} fill="currentColor" />
          </span>
          <span
            aria-label="More actions"
            onClick={onMenu}
            className={cx(
              'absolute bottom-1.5 right-1.5 h-8 w-8 rounded-lg bg-panel/80 ring-1 ring-edge text-dim hover:text-ink flex items-center justify-center transition-all',
              menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <MoreHorizontal size={15} />
          </span>
        </div>
        <div
          className={cx(
            'pt-1.5 text-[12.5px] truncate text-left',
            isCurrent ? 'text-gold' : 'text-ink'
          )}
        >
          {node.title}
        </div>
        {node.artist && (
          <div className="text-[11.5px] text-faint truncate text-left">{node.artist}</div>
        )}
      </button>
      {onHeart && (
        <HeartChip favorited={favorited === true} held={menuOpen} onHeart={onHeart} />
      )}
    </div>
  )
}
