import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Compass } from "lucide-react";
import {
  emptyPlayStats,
  foldPlayEvent,
  REDISCOVER_QUIET_DAYS,
  type MediaNode,
} from "@shared/model";
import { useStore } from "@/store";
import { EmptyState } from "@/components/chrome/EmptyState";
import { ContainerCard } from "@/components/library/LibraryCards";
import { RowMenu } from "@/components/media/RowMenu";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { useIndexPools } from "@/hooks/useIndexPools";
import { useWholeRecord } from "@/hooks/useWholeRecord";
import { shelvesFor, UNFINISHED_QUIET_DAYS, type ShelfAlbum } from "@/lib/rediscover";
import { albumMenuItems, type MediaMenuItem } from "@/lib/mediaMenus";
import { fromNode } from "@/lib/mediaRef";
import { openAlbumNode, playAlbumNode } from "@/lib/mediaActions";
import { cx, fmtCount } from "@/lib/format";
import { scrollToWithContext } from "@/lib/scroll";
import { Chip, GAP_WITHIN } from "@/components/chrome/Chrome";

/**
 * The History screen's REDISCOVER (0.8.0): sections of albums worth coming back
 * to (lib/rediscover). Browse view, so cards: the Library's own ContainerCard
 * and its grid, the card click opening the album in the Library and the corner
 * bloom playing it.
 *
 * ONE SCROLLER, the screen's (user call, 2026-09-11: "vertical, in a grid …
 * vertically contained"). A section shows COLLAPSED_ROWS rows of its grid and
 * grows STEP_ROWS at a time on ask — never its own scrollport: a second
 * scrollbar in the same column makes the wheel do different things a few pixels
 * apart, gives the screen more than one spot to remember, and clips the cards'
 * hover lift at every section edge. The cut lands on a row boundary at any width
 * because the grid's columns are computed from the width the cards actually get,
 * the same arithmetic `repeat(auto-fill, …)` does.
 *
 * GROWING IN STEPS, AND A HELD HEADING (user, 2026-09-11: opening a long list
 * leaves you "struggling to find the buttons to expand/reduce again"). Three
 * hundred albums in one press is seventy rows of cards with the way back at
 * either far end, so each ask adds a few rows, and the heading of the section
 * you are inside — with Collapse on it once that section has grown — is held at
 * the top edge.
 *
 * THE HELD HEADING IS THE TIMELINE'S GRAMMAR, not a painted bar: the label sits
 * on the bare ground above the scroller and the scroller's `fade-top` dissolves
 * the cards before they reach it, with the next section's heading pushing it
 * away as it arrives. A sticky heading inside the scroller had to carry its own
 * background, and that band read as a seam over the ambient wash (user,
 * 2026-09-11: "super aggressive and not in keeping with the app") — and a mask
 * on the scroller would dissolve a heading inside it anyway.
 *
 * EVERY HEADING IS DRAWN ABOVE THE SCROLLER, not only the held one (user,
 * 2026-09-11: the held titles must feel "SOLID, without any popping … no weird
 * 1-or-more pixel popping, no weird flickering as titles change"). The heading
 * rows in the list keep their place but are invisible; a layer over the
 * scroller carries one row per section, and each row rides on its twin's place
 * until that place reaches the label's home at the top edge, where it stays,
 * and the next row pushes it off as it arrives. Nothing is swapped, faded or
 * written at a handover, so there is no moment for a pop: the first section is
 * held from rest, the row that becomes held is the row already riding there,
 * and a heading never dissolves in the mask on its way up because it is not in
 * the scroller. A held heading that arrived on the first scroll — a bar fading
 * in at a threshold — popped by a frame's scroll every time, however the
 * threshold was measured; that is the day this replaced.
 */
const COLLAPSED_ROWS = 2;
/** Each ask adds this many rows: a section grows in steps rather than dropping
 *  three hundred albums into the page in one press. */
const STEP_ROWS = 4;

/** How many rows each section shows, for the session — like the other History choices. */
let rediscoverMem: Record<string, number> = {};

/** A twin this close below the label's home counts as having reached it: rects
 *  are fractional, and a title parked by a scroll can sit a hair under the line.
 *  Generous is harmless — a held row rides on its twin while the twin is still
 *  below home, so the row draws where the title is either way. */
const HOME_SLACK_PX = 1;
/** The scroller's mask, in px from its top edge: content is hidden above CLEAR
 *  and whole below SOLID. CLEAR covers the label's ink (the label box sits at
 *  ~8–24px of its 32px row); SOLID is as low as the first section's detail line
 *  at rest allows, since the mask is on at rest and a ramp reaching that line
 *  would leave it half-dissolved on a still screen. The Timeline's ramp is
 *  longer (the defaults in styles.css): nothing sits that close under its label. */
const FADE_CLEAR_PX = 24;
const FADE_SOLID_PX = 36;

const day = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric" });
const ago = (ms: number, now: number): string => {
  const days = Math.floor((now - ms) / 86_400_000);
  return days < 14 ? `${days} days ago` : days < 60 ? `${Math.floor(days / 7)} weeks ago` : day(ms);
};

/** How many cards a row holds: the count `repeat(auto-fill, …)` fits, from the
 *  width the grid actually has — its own box, since the room a hovered card
 *  needs sits on the SCROLLPORT. Re-read on resize, so the cut holds at any width.
 *  A CALLBACK REF, not an effect over a ref: on a first visit every section
 *  mounts empty, before the record has loaded, so an effect that looked for the
 *  grid once found nothing and the count stayed at one — a section then showed
 *  two albums side by side and offered the rest as "more" (user, 2026-09-11:
 *  "why did I have to click that? there was already room to show those"). The
 *  ref runs whenever the grid comes or goes, so a grid that arrives with the
 *  data is measured the moment it exists. */
function useColumns(
  cardSize: number,
  gap: number,
): [attach: (node: HTMLElement | null) => void, columns: number] {
  const [cols, setCols] = useState(1);
  const obs = useRef<ResizeObserver | null>(null);
  const attach = useCallback(
    (node: HTMLElement | null): void => {
      obs.current?.disconnect();
      obs.current = null;
      if (!node) return;
      const read = (w: number): void =>
        setCols(Math.max(1, Math.floor((w + gap) / (cardSize + gap))));
      read(node.clientWidth);
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) read(e.contentRect.width);
      });
      ro.observe(node);
      obs.current = ro;
    },
    [cardSize, gap],
  );
  useEffect(() => () => obs.current?.disconnect(), []);
  return [attach, cols];
}

interface SectionDef {
  id: string;
  title: string;
  detail: string;
  /** What the section says while it holds nothing — it stands either way. */
  empty: string;
  albums: ShelfAlbum[];
  note?: (album: ShelfAlbum) => string;
}

export function HistoryRediscover({
  streamer,
}: {
  /** The rail's streamer facet: null is every streamer. */
  streamer: string | null;
}): React.JSX.Element {
  const { events, years, allLoaded } = useWholeRecord(streamer);
  const recordOn = useStore((s) => s.settings.listeningRecord);
  const pools = useIndexPools(true);
  // the spot is remembered like every other screen's, and the heading layer
  // measures the scroller itself: one callback ref feeds both (the Timeline's)
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const rememberScroll = useScrollMemory("history:rediscover");

  // THE HEADING LAYER (see the top of the file): one row per section, above the
  // scroller, each riding on the place its invisible twin holds in the list.
  // Measured from the DOM per scroll frame; the transforms never go through
  // React. `held` is React state only for what may land a frame late without
  // moving anything: the Collapse chip, the pointer, the tip.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  /** The list's top padding: the label's inset in its row, less the title's
   *  inset in its heading row, so the first twin rests exactly at the label's
   *  home. Read from the DOM, never written down twice. */
  const [listPad, setListPad] = useState(0);
  const listPadRef = useRef(0);
  const measure = useCallback((): void => {
    const sc = scrollEl.current;
    const frame = frameRef.current;
    if (!sc || !frame) return;
    const rows = Array.from(frame.querySelectorAll<HTMLElement>("[data-rediscover-row]"));
    const twins = Array.from(sc.querySelectorAll<HTMLElement>("[data-rediscover-section]"));
    const n = Math.min(rows.length, twins.length);
    if (n === 0) return;
    // RECTS, not offsetTop: offsetTop is rounded to whole pixels while every
    // other position here is fractional, and that leftover half pixel is a
    // visible step (user, 2026-09-11: "a very small pop down"). A row's rects
    // move together with its transform, so their difference is the label's
    // inset whatever the transform is doing — and a row hidden by visibility
    // still has them (display:none would read 0, and once did).
    const titleOf = (twin: HTMLElement): HTMLElement => {
      const head = twin.querySelector<HTMLElement>("[data-rediscover-heading]");
      // the TITLE's box, not the heading row's: the row is a baseline flex with
      // the count beside it, and the label must meet the title itself
      return (head?.firstElementChild as HTMLElement | null) ?? head ?? twin;
    };
    const label0 = rows[0].querySelector<HTMLElement>("[data-rediscover-top]");
    const inset = label0
      ? label0.getBoundingClientRect().top - rows[0].getBoundingClientRect().top
      : 0;
    const head0 = twins[0].querySelector<HTMLElement>("[data-rediscover-heading]");
    const twinInset = head0
      ? titleOf(twins[0]).getBoundingClientRect().top - head0.getBoundingClientRect().top
      : 0;
    const pad = Math.max(0, inset - twinInset);
    listPadRef.current = pad;
    setListPad((prev) => (Math.abs(prev - pad) < 0.5 ? prev : pad));
    const home = sc.getBoundingClientRect().top + inset;
    const rowH = rows[0].offsetHeight;
    // where each twin's title sits, relative to the label's home
    const ride = twins.slice(0, n).map((t) => titleOf(t).getBoundingClientRect().top - home);
    // THE HELD SECTION IS THE LAST WHOSE TITLE HAS REACHED HOME — and the first
    // section whatever its title is doing, so there is no state in which nothing
    // is held: the first row is the first heading from rest, not a bar that
    // arrives once the scroll begins (arriving was the pop, every time).
    let h = 0;
    for (let i = 1; i < n; i++) if (ride[i] <= HOME_SLACK_PX) h = i;
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      if (i < h) {
        // passed: pushed off by the one that took over, and kept off
        row.style.visibility = "hidden";
        row.style.transform = "";
        continue;
      }
      // The held row rides on its twin until the twin reaches home, then stays;
      // the next twin pushes it off by exactly the row's height as it arrives,
      // so the two never overlap and the next row becomes the held one at the
      // very place it already is. Rows beyond ride on their twins, clipped by
      // the frame as the twins are by the scroller.
      const push = i === h && i + 1 < n ? Math.max(0, rowH - ride[i + 1]) : 0;
      const y = (i === h ? Math.max(0, ride[i]) : ride[i]) - push;
      row.style.visibility = "";
      row.style.transform = y !== 0 ? `translateY(${y}px)` : "";
    }
    const id = twins[h].dataset.rediscoverSection ?? null;
    setHeld((prev) => (prev === id ? prev : id));
  }, []);
  const rafRef = useRef(0);
  const onScroll = (): void => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      measure();
    });
  };
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  // the twins move without a scroll too — a section grows, the window narrows
  // and the grid reflows, the fonts land — so the layer follows the list's box
  const sizeObs = useRef<ResizeObserver | null>(null);
  const attachScroller = useCallback(
    (node: HTMLDivElement | null) => {
      scrollEl.current = node;
      rememberScroll(node);
      sizeObs.current?.disconnect();
      sizeObs.current = null;
      if (node) {
        const obs = new ResizeObserver(() => measure());
        obs.observe(node);
        if (node.firstElementChild) obs.observe(node.firstElementChild);
        sizeObs.current = obs;
      }
    },
    [rememberScroll, measure],
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60 * 60_000);
    return () => clearInterval(t);
  }, []);
  // the play counts for the rail's streamer, folded with the record's own fold
  const stats = useMemo(() => {
    const s = emptyPlayStats();
    for (const e of [...events].sort((a, b) => a.at - b.at)) foldPlayEvent(s, e);
    return s;
  }, [events]);
  const shelves = useMemo(
    () => (pools ? shelvesFor(pools, stats, now) : null),
    [pools, stats, now],
  );

  // HOW FAR EACH SECTION IS OPENED lives here, not in the section: the held
  // heading offers Collapse for whichever section it is showing.
  const [rowsById, setRowsById] = useState<Record<string, number>>(() => ({ ...rediscoverMem }));
  const setRows = useCallback((id: string, next: number): void => {
    rediscoverMem = { ...rediscoverMem, [id]: next };
    setRowsById({ ...rediscoverMem });
  }, []);

  const [menu, setMenu] = useState<{
    key: string;
    title: string;
    x: number;
    y: number;
    items: MediaMenuItem[];
  } | null>(null);
  const openMenu = (album: MediaNode, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      key: `${album.serverUdn}|${album.id}`,
      title: album.title,
      x: e.clientX,
      y: e.clientY,
      items: albumMenuItems(fromNode(album, album.serverUdn, album.serverName), {
        playNow: () => void playAlbumNode(album),
        openInLibrary: () => openAlbumNode(album),
      }),
    });
  };

  const sections: SectionDef[] = useMemo(() => {
    if (!shelves) return [];
    const since = stats.since;
    const started = since != null ? day(since) : null;
    return [
      {
        id: "unfinished",
        title: "Started, never finished",
        detail: `Albums you began and left before the middle, and haven't touched for ${UNFINISHED_QUIET_DAYS} days.`,
        empty:
          "Nothing here yet. An album you start and leave before its middle comes back here after a week.",
        albums: shelves.unfinished,
        note: (s) =>
          `${s.reached} of ${s.tracks} heard${s.lastAt ? `, ${ago(s.lastAt, now)}` : ""}`,
      },
      {
        id: "more",
        title: "More from artists you play",
        detail: "Albums you haven't played by the artists you play most.",
        empty: "Play a few albums and the rest of those artists' albums show up here.",
        albums: shelves.moreFrom,
      },
      {
        id: "quiet",
        title: "Not heard in a while",
        detail: "Albums you played and then left for three months.",
        empty:
          started != null && since != null
            ? `Albums you played and then left for three months gather here. Your listening history began ${started}, so the first can arrive on ${day(since + REDISCOVER_QUIET_DAYS * 86_400_000)}.`
            : "Albums you played and then left for three months gather here.",
        albums: shelves.quiet,
        note: (s) => `Last played ${day(s.lastAt)}`,
      },
      {
        id: "never",
        title: "Never played",
        detail:
          started != null
            ? `Albums with no recorded play since ${started}, when your listening history began.`
            : "Albums with no recorded play yet.",
        empty:
          started != null
            ? `Every album in your library has been played since ${started}.`
            : "Every album in your library has been played.",
        albums: shelves.neverPlayed,
      },
    ];
  }, [shelves, stats.since, now]);

  // the content moved: what is under the edge may have changed with it. A
  // LAYOUT effect, so a fresh row set is placed before it is painted — after
  // paint, every row stacks at the top for one frame.
  useLayoutEffect(() => measure(), [measure, rowsById, sections, listPad]);

  if (years != null && years.length === 0) {
    return (
      <EmptyState
        icon={Compass}
        title="Nothing to rediscover yet"
        caption={
          recordOn
            ? "Sections fill once the listening record has plays in it."
            : "The listening record is off. Turn it on in Settings › History and the sections will follow."
        }
      />
    );
  }
  if (!shelves) {
    return (
      <EmptyState
        icon={Compass}
        title="Waiting for a library index"
        caption="Rediscover reads your library's index. It appears once a media server has been indexed."
      />
    );
  }

  const heldGrown = held != null && (rowsById[held] ?? COLLAPSED_ROWS) > COLLAPSED_ROWS;

  return (
    <div className="h-full flex flex-col">
      {menu && (
        <RowMenu
          title={menu.title}
          at={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={menu.items}
        />
      )}
      {/* overflow-hidden: a heading row pushed off the top is clipped at the
          list's edge, as a scroll container clips its own sticky header. The RING
          ROOM (-mx-4, the scroller's px-4) lives out here, so the cards' hover
          lift and glow still have room inside the scrollport. */}
      <div
        ref={frameRef}
        data-rediscover-held={held ?? undefined}
        className="relative flex-1 min-w-0 min-h-0 overflow-hidden -mx-4"
      >
        {/* THE HEADING LAYER: one row per section, the same face as the heading
            row in the list (whose own is invisible), placed by measure(). Only
            the held row's title and Collapse take the pointer. h-8: the ROW keeps
            ONE height whether or not Collapse is on it, so the label never moves
            when a section grows. px-5 meets the scroller's px-4 + the heading's
            px-1, so a row sits on its twin to the pixel. */}
        {sections.map((s) => {
          const isHeld = held === s.id;
          return (
            <div
              key={s.id}
              data-rediscover-row={s.id}
              className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-5 h-8"
            >
              {/* THE TITLE TAKES THE POINTER and sends the section back to its
                  first row (user, 2026-09-11: the click fell through to the card
                  under it). The container-scoped helper, never scrollIntoView —
                  and it jumps instead of gliding under reduced motion. The
                  heading row lands at the list's top padding, which is where the
                  title meets the label's home, so the row does not move. */}
              <button
                onClick={() =>
                  scrollToWithContext(
                    scrollEl.current?.querySelector<HTMLElement>(
                      `[data-rediscover-section="${s.id}"] [data-rediscover-heading]`,
                    ) ?? null,
                    listPadRef.current,
                    0,
                  )
                }
                // measure() reads this element's inset in its row
                data-rediscover-top={s.id}
                // the section's RULE rides the tip, with the click hint after
                // it: the detail line explains the list once, on arrival, and a
                // held heading that repeats it spends a card row's height on
                // text that never changes (user call, 2026-09-11)
                data-tip={`${s.detail} Click to go back to the top.`}
                // NOT BRIGHTENED while held (user call, 2026-09-11): the row IS
                // the heading, in the heading's own colour, held or riding.
                // Hover still lifts to ink: :hover outranks .microlabel, where
                // the bare utility would tie and lose to it.
                className={cx(
                  "tip-bottom tip-wide microlabel hover:text-ink transition-colors",
                  // only the held row: a riding row must not take clicks
                  isHeld && "pointer-events-auto",
                )}
              >
                {s.title}
              </button>
              {s.albums.length > 0 && (
                <span className="text-[11px] text-faint tabular-nums">
                  {fmtCount(s.albums.length)}
                </span>
              )}
              {isHeld && (!allLoaded || heldGrown) && (
                <div className="ml-auto flex items-center gap-3">
                  {/* the other tabs say this on their toolbar line; this tab's
                      top line is the held heading */}
                  {!allLoaded && (
                    <span className="microlabel motion-safe:animate-pulse">reading…</span>
                  )}
                  {heldGrown && (
                    <div className="pointer-events-auto">
                      <Chip
                        onClick={() => setRows(s.id, COLLAPSED_ROWS)}
                        data-rediscover-collapse={s.id}
                        className={GAP_WITHIN}
                      >
                        <ChevronUp size={14} />
                        Collapse
                      </Chip>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {/* fade-top ALWAYS ON, unlike the Timeline's: a heading is held from
            rest, so what sits under it at rest — the first heading's invisible
            twin — is exactly what the mask is for. Its stops are this list's
            own (FADE_CLEAR_PX / FADE_SOLID_PX). */}
        <div
          ref={attachScroller}
          onScroll={onScroll}
          className="h-full overflow-y-auto px-4 pb-8 fade-top"
          // the first twin rests exactly at the label's home, so the first row is
          // simply the first heading; measure() keeps this in step with the rows'
          // geometry rather than two numbers agreeing
          style={
            {
              paddingTop: listPad,
              "--fade-top-clear": `${FADE_CLEAR_PX}px`,
              "--fade-top-solid": `${FADE_SOLID_PX}px`,
            } as React.CSSProperties
          }
          data-history-rediscover
        >
          <div className="space-y-8">
            {sections.map((s) => (
              <Section
                key={s.id}
                def={s}
                rows={rowsById[s.id] ?? COLLAPSED_ROWS}
                setRows={(next) => setRows(s.id, next)}
                onMenu={openMenu}
                menuKey={menu?.key}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  def,
  rows,
  setRows,
  onMenu,
  menuKey,
}: {
  def: SectionDef;
  rows: number;
  setRows(next: number): void;
  onMenu(album: MediaNode, e: React.MouseEvent): void;
  menuKey: string | undefined;
}): React.JSX.Element {
  const { id, title, detail, empty, albums, note } = def;
  const cardSize = useStore((s) => s.settings.presetCardSize);
  const gap = useStore((s) => s.settings.presetGap);
  const fill = useStore((s) => s.settings.presetFillRows);
  const [gridRef, columns] = useColumns(cardSize, gap);
  const shown = albums.slice(0, columns * rows);
  const remaining = albums.length - shown.length;
  /** What the next ask would reveal — the control says the true number. */
  const step = Math.min(remaining, columns * STEP_ROWS);
  const grown = rows > COLLAPSED_ROWS;

  return (
    <section data-rediscover-section={id}>
      {/* THE TWIN: invisible, never removed. It holds the heading's place in the
          list; the heading itself is the layer's row riding on this box (see the
          top of the file). visibility, not opacity: out of the reading order,
          since the row carries the text. */}
      <div data-rediscover-heading className="invisible flex items-baseline gap-2 px-1">
        <div className="microlabel">{title}</div>
        {albums.length > 0 && (
          <span className="text-[11px] text-faint tabular-nums">{fmtCount(albums.length)}</span>
        )}
      </div>
      {/* mt-2, not mt-1: the scroller's mask is on at rest, and its ramp
          (FADE_SOLID_PX) reaches down to just above this line's ink */}
      <div className="mt-2 px-1 text-[12px] text-faint max-w-xl">{detail}</div>
      {albums.length === 0 ? (
        <div className="mt-3 px-1 text-[13px] text-dim max-w-xl" data-rediscover-empty={id}>
          {empty}
        </div>
      ) : (
        <>
          {/* the Library's own album grid, and NO padding of its own: the room a
              hovered card needs belongs to the scrollport (a box here would only
              push the cards into the clip), and this box is then exactly the
              width its columns are measured from */}
          <div
            ref={gridRef}
            className="mt-2 grid"
            style={{
              gap,
              gridTemplateColumns: fill
                ? `repeat(auto-fill, minmax(${cardSize}px, 1fr))`
                : `repeat(auto-fill, ${cardSize}px)`,
            }}
          >
            {shown.map((s) => {
              const key = `${s.album.serverUdn}|${s.album.id}`;
              return (
                <ContainerCard
                  key={key}
                  node={s.album}
                  playing={false}
                  menuOpen={menuKey === key}
                  note={note?.(s)}
                  onEnter={() => openAlbumNode(s.album)}
                  onPlay={() => void playAlbumNode(s.album)}
                  onMenu={(e) => onMenu(s.album, e)}
                />
              );
            })}
          </div>
          {(remaining > 0 || grown) && (
            // mt-4: a hovered card in the last row lifts and glows over what sits
            // right under it (the card takes z-10 while hovered), so the control
            // keeps its distance — and it is the app's chip, not a text link
            <div className="mt-4 px-1">
              <Chip
                onClick={() =>
                  remaining > 0 ? setRows(rows + STEP_ROWS) : setRows(COLLAPSED_ROWS)
                }
                data-rediscover-more={id}
                className={GAP_WITHIN}
              >
                {remaining > 0 ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                {remaining > 0 ? `Show ${fmtCount(step)} more` : "Collapse"}
              </Chip>
            </div>
          )}
        </>
      )}
    </section>
  );
}
