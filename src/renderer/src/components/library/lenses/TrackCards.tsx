import { useRef } from "react";
import type { MediaNode } from "@shared/model";
import { TrackCard } from "@/components/library/LibraryCards";
import type { CardDetails } from "@/components/library/useCardDetails";
import { cx } from "@/lib/format";
import { type LensActions, nodeKey } from "./lensShared";
import { CARD_GRID_SCROLLER, useCardGrid, WINDOW_CARDS_ABOVE } from "./useCardGrid";

// The Tracks lens as cards (0.13.0-rc.4; his picks on the decision page "Tracks as Cards",
// 2026-10-26: B, track cards following the Library's one Rows or Cards choice, and A, a card's
// click plays). The cards (TrackCard) sit in the lenses' one grid (useCardGrid), windowed past its
// threshold as the Albums and Artists lenses' are; the lens keeps its filter, facets, sort,
// selection and menus, and only the list becomes a grid.

export function TrackCards({
  tracks,
  actions,
  selected,
  subtitleOf,
  detailsOf,
  cardSize,
  cardGap,
  fillRows,
  scrollTop,
  onScrolled,
  onCardClick,
  onNavDrag,
  onMenu,
  roomBelow,
}: {
  /** In the lens's order, filtered. */
  tracks: readonly MediaNode[];
  actions: LensActions;
  /** The selection, by nodeKey. */
  selected: ReadonlySet<string>;
  /** What a card says under the title. */
  subtitleOf(t: MediaNode): string;
  /** A card's format line, while Settings › Layout shows it (useTrackCardDetails). */
  detailsOf?: ((t: MediaNode) => CardDetails) | null;
  cardSize: number;
  cardGap: number;
  fillRows: boolean;
  /** The grid's spot when the lens was last left, and its record as it scrolls. */
  scrollTop: number;
  onScrolled(top: number): void;
  /** The selection grammar's look at a click: true when it picked. */
  onCardClick(t: MediaNode, e: React.MouseEvent): boolean;
  onNavDrag(t: MediaNode, e: React.PointerEvent): void;
  onMenu(t: MediaNode, e: React.MouseEvent): void;
  /** The selection bar is up: room under the last row so it never covers a card. */
  roomBelow: boolean;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const windowed = tracks.length > WINDOW_CARDS_ABOVE;
  const { bodyRef, width, cols, win, gridColumns } = useCardGrid({
    scrollRef,
    count: tracks.length,
    cardSize,
    cardGap,
    fillRows,
    windowed,
    rowSelector: "[data-track-cards-row]",
    restoreTop: scrollTop,
  });
  const card = (t: MediaNode): React.JSX.Element => (
    <TrackCard
      key={nodeKey(t)}
      node={t}
      playing={actions.isCurrentTrack(t)}
      menuOpen={actions.menuNodeId === t.id}
      selected={selected.has(nodeKey(t))}
      favorited={actions.nodeFavorited(t)}
      subtitle={subtitleOf(t)}
      details={detailsOf?.(t)}
      onClick={(e) => onCardClick(t, e)}
      onPlayNow={(el) => actions.playTrack(t, el)}
      onHeart={() => actions.heartNode(t)}
      onMenu={(e) => onMenu(t, e)}
      onNavDrag={(e) => onNavDrag(t, e)}
    />
  );
  return (
    <div
      ref={scrollRef}
      data-lens-track-cards
      onScroll={(e) => onScrolled(e.currentTarget.scrollTop)}
      // the page's side padding, spanned so a hovered card's growth and glow keep it (the Albums
      // lens's grid does the same)
      className={cx("min-h-0 flex-1 overflow-y-auto px-8 -mx-8", roomBelow ? "pb-24" : "pb-2")}
      style={CARD_GRID_SCROLLER}
    >
      <div ref={bodyRef}>
        {windowed && width === 0 ? null : windowed ? (
          <div style={{ paddingTop: 8, overflowAnchor: "none" }}>
            {win.padTop > 0 && <div style={{ height: win.padTop }} />}
            {Array.from({ length: win.last - win.first + 1 }, (_, i) => win.first + i).map((r) => (
              <div
                key={r}
                data-track-cards-row
                style={{
                  display: "grid",
                  gridTemplateColumns: gridColumns(cols),
                  gap: cardGap,
                  marginBottom: cardGap,
                }}
              >
                {tracks.slice(r * cols, (r + 1) * cols).map(card)}
              </div>
            ))}
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
            {tracks.map(card)}
          </div>
        )}
      </div>
    </div>
  );
}
