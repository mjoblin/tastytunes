import { useRef } from "react";
import { Disc3, Folder, Heart, MoreHorizontal, Play } from "lucide-react";
import { trackPosition, type MediaNode } from "@shared/model";
import { cx } from "@/lib/format";
import { isAlbumClass, isArtistClass, isMutedArt } from "@/lib/media";
import { RowAction } from "@/components/media/RowAction";
import { RowHeart } from "@/components/media/RowHeart";
import { ArtImage } from "@/components/media/ArtImage";
import { MediaArt } from "@/components/media/MediaArt";
import { DrBadge } from "@/components/media/Waveform";
import { FACT_SEP } from "@/lib/mediaFacts";
import { DurationCell } from "@/components/media/DurationCell";
import { Eqbars } from "@/components/media/Eqbars";
import { artUrlAt } from "@shared/artUrl";

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
  onHeart,
}: {
  favorited: boolean;
  /** The card's menu is open — match the other chips' held visibility. */
  held: boolean;
  onHeart(): void;
}): React.JSX.Element {
  return (
    <span
      data-tip={favorited ? "Remove from favorites" : "Add to favorites"}
      data-card-heart={favorited ? "on" : "off"}
      onClick={(e) => {
        e.stopPropagation();
        onHeart();
      }}
      className={cx(
        // 14px = the card's p-2 plus the chips' 6px inset from the art corner
        "tip-bottom tip-end absolute top-3.5 right-3.5 z-10 h-8 w-8 rounded-lg bg-panel/80 ring-1 ring-edge flex items-center justify-center transition-all motion-safe:active:scale-90 cursor-pointer",
        favorited
          ? "text-gold opacity-100"
          : cx(
              "text-dim hover:text-ink",
              held ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            ),
      )}
    >
      <Heart size={14} fill={favorited ? "currentColor" : "none"} />
    </span>
  );
}

export function ContainerCard({
  node,
  playing,
  menuOpen,
  favorited,
  badge,
  onHeart,
  onEnter,
  onPlay,
  onMenu,
}: {
  node: MediaNode;
  /** The playing track belongs to this album (and the queue source is live). */
  playing: boolean;
  /** This card's ⋯ menu or preset picker is open — hold the hover treatment. */
  menuOpen: boolean;
  /** With onHeart: the art-corner heart chip (albums only make sense). */
  favorited?: boolean;
  /** Provenance chip on the subtitle line (lens grids pooling several servers). */
  badge?: string;
  onHeart?(): void;
  onEnter(): void;
  onPlay(el: HTMLElement | null): void;
  onMenu(e: React.MouseEvent): void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  // Queue/preset verbs only make sense on albums — plain folders (USB
  // volumes, Asset's virtual views) get no chips and no menu. ARTIST
  // containers carry the ⋯ (their menu holds only the search-everywhere
  // pivot — see ItemMenu) but never the play chip.
  const album = isAlbumClass(node.upnpClass);
  const menuable = album || isArtistClass(node.upnpClass);
  const muted = isMutedArt(node);
  const subtitle = [node.artist, node.year].filter(Boolean).join(" · ");
  return (
    // Preset-card idiom: inset tile, hover grow + lift + glow; the highlight
    // wraps the gray tile so it stays legible over gold/orange covers.
    <div
      ref={ref}
      onContextMenu={menuable ? onMenu : undefined}
      data-library-card
      className={cx(
        "group relative text-left rounded-2xl p-2 pb-2.5 transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]",
        playing ? "bg-goldtile/70 tile-playing" : "bg-raised/50 ring-1 ring-edge card-hover-glow",
        // held while this card's ⋯ menu / preset picker is open — the pointer
        // has left, but the card is still what's being acted on: keep the
        // full hover treatment (grow + glow), not just a ring
        menuOpen && "ring-1 ring-edge2 z-10 motion-safe:scale-[1.04] card-glow-held",
      )}
    >
      {/* the card CENTER always enters — play/menu are corner chips on the
          art, never intercepting the open gesture (unlike preset cards,
          whose whole-card click IS the play action) */}
      <button className="block w-full cursor-pointer" onClick={onEnter}>
        {/* the art well is a veil LIFT over the card, not a panel hole: the same
            theme-flipping tint either way, so the ambient wash reads through
            the well as it does through the shell (panel is darker than the
            shell in the dark theme and lighter in the light one — a hole on
            the faceplate, a plateau on paper) */}
        <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-veil flex items-center justify-center">
          <ArtImage
            src={artUrlAt(node.artUrl, 240)}
            fallbackArt={
              album ? { artist: node.albumArtist ?? node.artist, album: node.title } : undefined
            }
            lazy
            className={cx("h-full w-full object-cover", muted && "opacity-60 saturate-[.6]")}
            fallback={
              album ? (
                <Disc3 size={34} strokeWidth={1.2} className="text-dim" />
              ) : (
                <Folder size={34} strokeWidth={1.2} className="text-dim" />
              )
            }
          />
          {muted && node.artUrl && (
            <div className="absolute inset-0 pointer-events-none bg-panel/30" />
          )}
          {playing && (
            <span className="absolute top-1.5 left-1.5 h-7 w-7 rounded-lg bg-panel/80 ring-1 ring-edge flex items-center justify-center">
              <Eqbars />
            </span>
          )}
          {album && (
            <span
              onClick={(e) => {
                e.stopPropagation();
                onPlay(ref.current);
              }}
              data-tip="Play — replaces the queue"
              className={cx(
                "tip-bottom absolute bottom-1.5 left-1.5 h-11 w-11 rounded-full bg-amber text-bg flex items-center justify-center transition-all duration-150 motion-safe:hover:scale-110 hover:shadow-[0_0_24px_rgb(var(--amber-rgb)_/_0.6)]",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            >
              <Play size={18} fill="currentColor" />
            </span>
          )}
          {menuable && (
            <span
              aria-label="More actions"
              onClick={onMenu}
              className={cx(
                "absolute bottom-1.5 right-1.5 h-8 w-8 rounded-lg bg-panel/80 ring-1 ring-edge text-dim hover:text-ink flex items-center justify-center transition-all",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            >
              <MoreHorizontal size={15} />
            </span>
          )}
        </div>
        <div
          className={cx(
            "pt-1.5 text-[12.5px] truncate text-left",
            playing ? "text-gold" : "text-ink",
          )}
        >
          {node.title}
        </div>
        {(subtitle || badge) && (
          <div className="flex items-center gap-1.5 min-w-0">
            {subtitle && (
              <div className="text-[11.5px] text-faint truncate text-left">{subtitle}</div>
            )}
            {badge && (
              <span
                data-card-badge={badge}
                className="shrink-0 text-[9.5px] px-1.5 py-px rounded-full ring-1 ring-edge text-faint"
              >
                {badge}
              </span>
            )}
          </div>
        )}
      </button>
      {album && onHeart && (
        <HeartChip favorited={favorited === true} held={menuOpen} onHeart={onHeart} />
      )}
    </div>
  );
}

/** Row-cluster heart: hover-revealed control, permanently gold when set. */

export function ContainerRow({
  node,
  playing,
  menuOpen,
  favorited,
  badge,
  dr,
  onArtistLink,
  onHeart,
  onEnter,
  onMenu,
}: {
  node: MediaNode;
  playing: boolean;
  menuOpen: boolean;
  /** With onHeart: the heart button in the row's action cluster (albums). */
  favorited?: boolean;
  /** Provenance chip beside the subline (lens listings pooling several servers). */
  badge?: string;
  /** EXPERIMENT (0.7): the album's recorded TT-DR for the data cluster;
   *  null renders the reserved cell empty (absence as absence). */
  dr?: number | null;
  /** The album artist as a link (rows are the data view: names navigate;
   *  the row itself keeps opening the album). */
  onArtistLink?(): void;
  onHeart?(): void;
  onEnter(): void;
  onMenu(e: React.MouseEvent): void;
}): React.JSX.Element {
  // Same rule as cards: albums carry the full ⋯ menu; ARTISTS carry it too now
  // (theirs holds only the search-everywhere pivot — see ItemMenu). Plain
  // folders stay menu-less: a folder is filing, and none of the verbs apply.
  const album = isAlbumClass(node.upnpClass);
  const menuable = album || isArtistClass(node.upnpClass);
  const muted = isMutedArt(node);
  return (
    <div
      className={cx(
        "group grid grid-cols-[44px_1fr_auto_auto_auto_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5 cursor-pointer transition-colors",
        playing ? "row-playing bg-gold/10" : menuOpen ? "bg-veil" : "hover:bg-veil",
      )}
      onClick={onEnter}
      onContextMenu={menuable ? onMenu : undefined}
      data-library-row
    >
      <MediaArt
        src={artUrlAt(node.artUrl, 240)}
        kind={album ? "album" : isArtistClass(node.upnpClass) ? "artist" : "folder"}
        className={muted ? "opacity-60 saturate-[.6]" : undefined}
      />
      <div className="min-w-0">
        <div className={cx("text-[13.5px] truncate", playing ? "text-gold" : "text-ink")}>
          {node.title}
        </div>
        {(node.artist || badge) && (
          <div className="flex items-center gap-1.5 min-w-0">
            {node.artist &&
              (onArtistLink ? (
                <button
                  data-tip="Go to artist"
                  aria-label={`Go to artist ${node.artist}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onArtistLink();
                  }}
                  className="tip-bottom text-[12px] text-faint truncate hover:text-dim hover:underline underline-offset-2 transition-colors"
                >
                  {node.artist}
                </button>
              ) : (
                <div className="text-[12px] text-faint truncate">{node.artist}</div>
              ))}
            {badge && (
              <span
                data-card-badge={badge}
                className="shrink-0 text-[9.5px] px-1.5 py-px rounded-full ring-1 ring-edge text-faint"
              >
                {badge}
              </span>
            )}
          </div>
        )}
      </div>
      {/* The rows view is the data view: year and DR ride RESERVED cells on
          album rows (the duration-cell principle — alignment holds whether or
          not a value exists; empty tracks collapse on non-album rows). */}
      {album && (
        <div className="w-9 text-right font-mono text-[11px] text-faint tabular-nums">
          {node.year ?? ""}
        </div>
      )}
      {album && (
        <div className="flex w-12 justify-end font-mono text-[10.5px]">
          {dr != null && <DrBadge dr={dr} className="" />}
        </div>
      )}
      {playing ? <Eqbars /> : <span />}
      {album && onHeart ? (
        <RowHeart favorited={favorited === true} held={menuOpen} onHeart={onHeart} />
      ) : (
        <span />
      )}
      {menuable ? (
        <button
          aria-label="More actions"
          onClick={onMenu}
          className={cx(
            "p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all",
            menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <MoreHorizontal size={14} />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/** Every TrackRow column set as a literal class (Tailwind's scanner needs the
 *  whole string): position · art · title · actions · [DR] · duration. */
const TRACK_GRID: Record<string, string> = {
  "pos-art-dr": "grid-cols-[26px_44px_1fr_auto_auto_auto]",
  "pos-art": "grid-cols-[26px_44px_1fr_auto_auto]",
  "pos-dr": "grid-cols-[26px_1fr_auto_auto_auto]",
  pos: "grid-cols-[26px_1fr_auto_auto]",
  "art-dr": "grid-cols-[44px_1fr_auto_auto_auto]",
  art: "grid-cols-[44px_1fr_auto_auto]",
  dr: "grid-cols-[1fr_auto_auto_auto]",
  "": "grid-cols-[1fr_auto_auto]",
};

export function TrackRow({
  node,
  showArt,
  isCurrent,
  queued,
  menuOpen,
  favorited,
  onHeart,
  onPlayNow,
  onMenu,
  selected = false,
  onRowClick,
  onNavDrag,
  onAlbumLink,
  onArtistLink,
  note,
  artistLabel,
  dr,
  showPosition = true,
  selStart = true,
  selEnd = true,
}: {
  node: MediaNode;
  /** Loose tracks in mixed folders get a thumb; album views carry the art in the header. */
  showArt: boolean;
  /** This is what's playing right now (queue source live) — queue-row treatment. */
  isCurrent: boolean;
  /** Already in the queue — a click jumps there instead of inserting. */
  queued: boolean;
  menuOpen: boolean;
  /** With onHeart: the heart button in the row's action cluster. */
  favorited?: boolean;
  onHeart?(): void;
  onPlayNow(el: HTMLElement | null): void;
  onMenu(e: React.MouseEvent): void;
  /** Part of the current multi-selection (⌘/⇧-click). */
  selected?: boolean;
  /** Selection first: true = the click was a chord and must not play. */
  onRowClick?(e: React.MouseEvent): boolean;
  /** Drag-to-rail: the press that may become a drag (wired only while the
   *  row is selected — the drag carries the selection). */
  onNavDrag?(e: React.PointerEvent): void;
  /** Contiguous-selection run edges — a run draws ONE border, so a row whose
   *  neighbor is also selected drops the shared side. */
  selStart?: boolean;
  selEnd?: boolean;
  /** Search results: the album name renders as a link that navigates there
   *  (the row itself keeps the app-wide click contract: tracks play). */
  onAlbumLink?(): void;
  /** Search results: the artist name links to the artist entity. */
  onArtistLink?(): void;
  /**
   * A quiet note after the title — the ONE case is a track whose format
   * differs from its album's headline ("MP3 · 320 kbps" in a FLAC album);
   * rows that match the album carry nothing (albumFormat decides).
   */
  note?: string | null;
  /**
   * What the second line says instead of the raw `artist` — the album
   * context's "Daft Punk feat. Julian Casablancas" (performerLine). Absent
   * = the packed string, which is the honest default everywhere else.
   */
  artistLabel?: string | null;
  /** EXPERIMENT (0.7): the track's recorded TT-DR for the data cluster —
   *  pass it (null included) to reserve the cell; leave it undefined and
   *  the row has no DR column (album listings, search results). */
  dr?: number | null;
  /** The Tracks lens turns the number off: a track's position within ITS
   *  album reads as noise in a flat list across albums. The cell stays —
   *  the playing eqbars still live there (the flat-row rule). */
  showPosition?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={ref}
      className={cx(
        "group relative grid items-center gap-3 rounded-lg px-2 py-1.5 cursor-pointer transition-colors",
        TRACK_GRID[
          [showPosition && "pos", showArt && "art", dr !== undefined && "dr"]
            .filter(Boolean)
            .join("-")
        ],
        isCurrent
          ? "row-playing bg-gold/10"
          : selected
            ? "bg-veil2"
            : menuOpen
              ? "bg-veil"
              : "hover:bg-veil",
        !isCurrent && selected && !selStart && "rounded-t-none",
        !isCurrent && selected && !selEnd && "rounded-b-none",
      )}
      onClick={(e) => {
        if (onRowClick?.(e)) return;
        onPlayNow(ref.current);
      }}
      onPointerDown={onNavDrag}
      onContextMenu={onMenu}
      data-library-track={node.title}
    >
      {!isCurrent && selected && (
        <span
          aria-hidden
          data-sel-run
          className={cx(
            "pointer-events-none absolute inset-0 rounded-[inherit] border-edge2",
            selStart && selEnd
              ? "border"
              : selStart
                ? "border-x border-t"
                : selEnd
                  ? "border-x border-b"
                  : "border-x",
          )}
        />
      )}
      {/* left-justified: numbers sit flush with the header/art above. The
          cell leaves with its number (the Tracks lens) rather than sitting
          as a phantom gutter; the playing eqbars then move inline before the
          title, the floating-row placement. */}
      {showPosition && (
        <span className="font-mono text-[10.5px] text-faint tabular-nums">
          {isCurrent ? <Eqbars /> : (trackPosition(node) ?? "")}
        </span>
      )}
      {showArt && <MediaArt src={node.artUrl} kind="track" />}
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          {isCurrent && !showPosition && <Eqbars />}
          <div className={cx("text-[13.5px] truncate", isCurrent ? "text-gold" : "text-ink")}>
            {node.title}
          </div>
          {note && (
            <span
              className="shrink-0 font-mono text-[10px] text-faint tabular-nums ring-1 ring-edge rounded px-1 leading-4"
              data-track-note
            >
              {note}
            </span>
          )}
        </div>
        {(node.artist || (onAlbumLink && node.album)) && (
          <div className="text-[12px] text-faint truncate">
            {node.artist &&
              (onArtistLink ? (
                <button
                  data-tip="Go to artist"
                  aria-label={`Go to artist ${node.artist}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onArtistLink();
                  }}
                  className="tip-bottom hover:text-dim hover:underline underline-offset-2 transition-colors"
                >
                  {artistLabel ?? node.artist}
                </button>
              ) : (
                (artistLabel ?? node.artist)
              ))}
            {onAlbumLink && node.album && (
              <>
                {node.artist ? FACT_SEP : ""}
                <button
                  data-tip="Go to album"
                  aria-label={`Go to album ${node.album}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAlbumLink();
                  }}
                  className="tip-bottom hover:text-dim hover:underline underline-offset-2 transition-colors"
                >
                  {node.album}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {/* per-button reveal (not on the wrapper): a set heart must stay
          visible on the resting row while play/⋯ remain hover-only */}
      <div className="flex items-center gap-0.5">
        <RowAction
          icon={Play}
          label="Play"
          tip={
            queued ? "Play — already in the queue" : "Play now — slots in after the current track"
          }
          pinned={menuOpen}
          onClick={() => onPlayNow(ref.current)}
        />
        <RowAction icon={MoreHorizontal} label="More actions" pinned={menuOpen} onClick={onMenu} />
        {/* heart last: persistent state sits beside the duration, not adrift
            behind the hover-only actions (see QueueRow) */}
        {onHeart && <RowHeart favorited={favorited === true} held={menuOpen} onHeart={onHeart} />}
      </div>
      {/* the Tracks lens's data cluster: a RESERVED DR cell (the duration-cell
          principle) — alignment holds whether or not a value exists */}
      {dr !== undefined && (
        <div className="flex w-12 justify-end font-mono text-[10.5px]" data-track-dr>
          {dr != null && <DrBadge dr={dr} className="" />}
        </div>
      )}
      <DurationCell secs={node.durationSecs} />
    </div>
  );
}

/** A loose track as a card (Title views, mixed folders) — click = Play now. */
