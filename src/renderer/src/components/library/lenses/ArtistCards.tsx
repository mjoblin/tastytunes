import { useEffect, useRef } from "react";
import type { MediaNode } from "@shared/model";
import { ContainerCard } from "@/components/library/LibraryCards";
import { type LensActions } from "./lensShared";
import { type LensArtist } from "./useLensIndex";
import { useCardGrid, WINDOW_CARDS_ABOVE } from "./useCardGrid";

// The Artists lens as cards (0.13.0 round 12; Malcolm, 2026-10-25: "a degree of uniformity
// across the Album, Artist and Tracks sections ... only the Albums section gives a choice of
// displaying by rows or by cards"; his picks the same day on the decision page "Artists as
// Cards"). The cards are the Albums lens's own (ContainerCard: an artist container takes main's
// picture, the portrait crop, the ⋯ and no Play) in the Albums lens's grid (useCardGrid), with
// the line the artist's row says under the name. A click opens the artist's page
// (decisions/0012). The Library's one Rows or Cards choice decides the view, as it does for
// Albums and an artist's page.

/**
 * A lens artist is content identity, not a node: the ⋯ / right-click menu and Info want one, so
 * it is synthesized: the entity's server (or the first album's/track's) is what Info sums their
 * page from.
 */
export function lensArtistNode(a: LensArtist): MediaNode {
  const from = a.albums[0] ?? a.tracks[0];
  return {
    id: `lens-artist:${a.key}`,
    parentId: null,
    title: a.name,
    upnpClass: "object.container.person.musicArtist",
    isContainer: true,
    artUrl: a.artUrl,
    artist: null,
    album: null,
    year: null,
    trackNumber: null,
    durationSecs: null,
    ...(from?.serverUdn ? { serverUdn: from.serverUdn, serverName: from.serverName } : {}),
  };
}

/** What an artist's row and card say under the name: their albums, else their tracks. */
export const artistLine = (a: LensArtist): string =>
  a.albums.length > 0
    ? `${a.albums.length} album${a.albums.length === 1 ? "" : "s"}`
    : `${a.tracks.length} track${a.tracks.length === 1 ? "" : "s"}`;

/** The A-Z rail: fast travel through a long list in name order (the rows' column, the cards). */
export function AzRail({
  letters,
  onJump,
  className,
}: {
  letters: readonly string[];
  onJump(letter: string): void;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      data-az-rail
      className={
        className ?? "shrink-0 flex flex-col items-center justify-center gap-px pl-0.5 select-none"
      }
    >
      {letters.map((l) => (
        <button
          key={l}
          onClick={() => onJump(l)}
          className="px-1 text-[9.5px] leading-[13px] font-mono text-faint hover:text-gold transition-colors"
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** How far below the grid's top a revealed card lands: a little of the row above in view. */
const REVEAL_PAD = 48;
/** The rail's room at the grid's right edge, inside the scroller's padding. */
const RAIL_ROOM = 24;
/** The page's own side padding, which the scroller spans so a card's hover glow keeps it. */
const PAGE_PAD = 32;

export function ArtistCards({
  artists,
  actions,
  playingKey,
  cardSize,
  cardGap,
  fillRows,
  onOpenArtistPage,
  letterStarts,
  scrollTop,
  onScrolled,
  reveal,
  onRevealed,
}: {
  /** In the lens's order, filtered. */
  artists: readonly LensArtist[];
  actions: LensActions;
  playingKey: string | null;
  cardSize: number;
  cardGap: number;
  fillRows: boolean;
  onOpenArtistPage?(name: string): void;
  /** Each letter's first artist, in name order; null hides the rail (another order). */
  letterStarts: ReadonlyMap<string, number> | null;
  /** The grid's spot when the lens was last left, and its record as it scrolls. */
  scrollTop: number;
  onScrolled(top: number): void;
  /** An artist asked for (the artist page's Artists crumb, a landing by link): their card is
   *  brought into view in place of the remembered spot, as the columns reveal the row. */
  reveal: string | null;
  onRevealed(): void;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const windowed = artists.length > WINDOW_CARDS_ABOVE;
  const revealAt = reveal ? artists.findIndex((a) => a.key === reveal) : -1;
  const { bodyRef, width, cols, win, gridColumns } = useCardGrid({
    scrollRef,
    count: artists.length,
    cardSize,
    cardGap,
    fillRows,
    windowed,
    rowSelector: "[data-artist-cards-row]",
    restoreTop: revealAt >= 0 ? 0 : scrollTop,
  });
  // the asked-for card lands a little below the grid's top once the grid can place it (its
  // columns measured), and the ask is consumed when applied; the geometry is read at that
  // moment (through `at`), never a reason to land again
  const placed = width > 0;
  const at = useRef({ windowed, win, cols, onRevealed });
  at.current = { windowed, win, cols, onRevealed };
  useEffect(() => {
    if (revealAt < 0 || !placed) return;
    const raf = requestAnimationFrame(() => {
      const sc = scrollRef.current;
      if (!sc) return;
      const g = at.current;
      const top = g.windowed
        ? g.win.offsetOf(Math.floor(revealAt / g.cols))
        : (sc.querySelectorAll<HTMLElement>("[data-library-card]")[revealAt]?.offsetTop ?? 0);
      sc.scrollTo({ top: Math.max(0, top - REVEAL_PAD) });
      g.onRevealed();
    });
    return () => cancelAnimationFrame(raf);
  }, [revealAt, placed]);
  const card = (a: LensArtist): React.JSX.Element => (
    <ContainerCard
      key={a.key}
      node={lensArtistNode(a)}
      playing={a.key === playingKey}
      menuOpen={actions.menuNodeId === `lens-artist:${a.key}`}
      subtitle={artistLine(a)}
      onEnter={() => onOpenArtistPage?.(a.name)}
      onPlay={() => {}}
      onMenu={(e) => actions.openMenu(lensArtistNode(a), e)}
    />
  );
  /** A letter's first artist at the grid's top: its row's place, measured or estimated. */
  const jump = (letter: string): void => {
    const at = letterStarts?.get(letter);
    const sc = scrollRef.current;
    if (at == null || !sc) return;
    if (windowed) {
      sc.scrollTo({ top: win.offsetOf(Math.floor(at / cols)) });
      return;
    }
    const el = sc.querySelectorAll<HTMLElement>("[data-library-card]")[at];
    if (el) sc.scrollTo({ top: Math.max(0, el.offsetTop - 8) });
  };
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-lens-artist-cards
        onScroll={(e) => onScrolled(e.currentTarget.scrollTop)}
        className="h-full overflow-y-auto pb-2"
        style={{
          marginInline: -PAGE_PAD,
          paddingLeft: PAGE_PAD,
          paddingRight: PAGE_PAD + (letterStarts ? RAIL_ROOM : 0),
        }}
      >
        <div ref={bodyRef}>
          {artists.length === 0 ? (
            <div className="text-[15px] text-faint pt-4 px-1">Nothing matches that filter.</div>
          ) : windowed && width === 0 ? null : windowed ? (
            // the Albums lens's windowed rows: 8 px above the first, room for a hovered card's
            // growth and ring under the scroller's top edge
            <div style={{ paddingTop: 8, overflowAnchor: "none" }}>
              {win.padTop > 0 && <div style={{ height: win.padTop }} />}
              {Array.from({ length: win.last - win.first + 1 }, (_, i) => win.first + i).map(
                (r) => (
                  <div
                    key={r}
                    data-artist-cards-row
                    style={{
                      display: "grid",
                      gridTemplateColumns: gridColumns(cols),
                      gap: cardGap,
                      marginBottom: cardGap,
                    }}
                  >
                    {artists.slice(r * cols, (r + 1) * cols).map(card)}
                  </div>
                ),
              )}
              {win.padBottom > 0 && <div style={{ height: win.padBottom }} />}
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: gridColumns("auto-fill"),
                gap: cardGap,
                paddingTop: 8,
              }}
            >
              {artists.map(card)}
            </div>
          )}
        </div>
      </div>
      {letterStarts && (
        // over the scroller's right padding, clear of its scrollbar, so it stays as the grid
        // scrolls
        <AzRail
          letters={[...letterStarts.keys()]}
          onJump={jump}
          className="absolute top-0 bottom-0 right-0 flex flex-col items-center justify-center gap-px select-none"
        />
      )}
    </div>
  );
}
