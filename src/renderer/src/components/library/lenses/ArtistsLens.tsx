import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, LayoutGrid, MoreHorizontal, Rows3 } from "lucide-react";
import {
  albumFormat,
  type AppSettings,
  discGroups,
  type MediaIndexPools,
  nameSortKey,
  performerLine,
  sameArt,
  trackInAlbumOf,
} from "@shared/model";
import { cx, fmtTime, matchesFilter } from "@/lib/format";
import { useStore } from "@/store";
import { scrollToVisible } from "@/lib/scroll";
import { useWindowedList } from "@/hooks/useWindowedList";
import { isAlbumClass } from "@/lib/media";
import { MediaArt } from "@/components/media/MediaArt";
import { ArtistArt } from "@/components/media/ArtistArt";
import { FilterInput } from "@/components/controls/FilterInput";
import { Chip, GAP_BETWEEN, GAP_WITHIN, HeaderChip } from "@/components/chrome/Chrome";
import { SortChip } from "@/components/controls/SortChip";
import { usePlayStats } from "@/lib/playStats";
import { TrackRow } from "@/components/library/LibraryCards";
import { Eqbars } from "@/components/media/Eqbars";
import { type LensActions, lc, nodeKey, orderArtists, RECORD_SORTS } from "./lensShared";
import {
  useLensTrackSelection,
  LensTrackSelectionBar,
  LensTrackMenu,
} from "./useLensTrackSelection";
import { useLensIndex } from "./useLensIndex";
import { ArtistCards, AzRail, artistLine, lensArtistNode } from "./ArtistCards";

// The Artists lens, split out of LibraryLenses.tsx (2026-09-13, the lenses round: three lenses of
// 600 to 800 lines shared one file); what the lenses share lives in ./lensShared.

// Session memory: selections, the artist filter, and each column's scroll
// spot survive the round trip through an album leaf (and screen switches).
// The With-albums toggle lives in settings (view defaults persist,
// 2026-08-06); this is the session's workspace — spot, filter, scroll.
let artistsMem: {
  artist: string | null;
  album: string | null;
  filter: string;
  /** Each column's spot, and the cards grid's (0.13.0 round 12). */
  scroll: { artists: number; albums: number; tracks: number; cards: number };
  /** An artist to scroll into a comfortable spot on the next render (set by
   *  focusArtistsLens; consumed once). */
  reveal: string | null;
} = {
  artist: null,
  album: null,
  filter: "",
  scroll: { artists: 0, albums: 0, tracks: 0, cards: 0 },
  reveal: null,
};

/** Point the Artists lens at an artist before opening it — the Tracks and
 *  Albums lenses' artist links. Keys match the lens's own: the lowercased,
 *  trimmed name. The lens then REVEALS the row near the top of its column. */
export function focusArtistsLens(name: string): void {
  artistsMem = { ...artistsMem, artist: lc(name), album: null, reveal: lc(name) };
}

/** How far from the column's top a revealed artist lands — about a row and
 *  a half of context above it, so the eye reads where it is rather than
 *  finding the row pinned to the edge (user call, 2026-09-01). */
const REVEAL_PAD = 84;
/** Past this many artists the column renders only the rows near the viewport
 *  (useWindowedList); below it, every row, exactly as before (0.11.0 sweep, for review). */
const WINDOW_ARTISTS_ABOVE = 150;

/** A row's name fades out under its floating buttons (two 26px buttons, 10px apart, 8px in
 *  from the row's edge; the artist and album rows alike): from the column's right edge, clear
 *  for the buttons, then a 20px fade. A playing artist row's column already stops at the
 *  eqbars (14px and the 10px gap), so its fade starts that much sooner (an album row's eqbars
 *  ride inside its title). Literal strings, so Tailwind sees each one. */
const NAME_FADE = {
  idle: {
    on: "[mask-image:linear-gradient(to_left,transparent_64px,black_84px)]",
    hover: "group-hover:[mask-image:linear-gradient(to_left,transparent_64px,black_84px)]",
  },
  playing: {
    on: "[mask-image:linear-gradient(to_left,transparent_40px,black_60px)]",
    hover: "group-hover:[mask-image:linear-gradient(to_left,transparent_40px,black_60px)]",
  },
} as const;

/** An artist's letter on the A-Z rail ("The Cure" files under C; non-letters under #). */
const letterOf = (name: string): string => {
  const c = nameSortKey(name)[0]?.toUpperCase() ?? "#";
  return c >= "A" && c <= "Z" ? c : "#";
};

const ARTIST_SORTS: Array<{ value: AppSettings["lensArtistsSort"]; label: string }> = [
  { value: "name", label: "Name" },
  { value: "plays", label: "Most played" },
  // an artist's newest album in the Recently added order (lensShared orderArtists)
  { value: "added", label: "Recently added" },
];

/**
 * The miller view (vibin's Artists screen, adapted): Artists | Albums |
 * Tracks columns; clicking columns 1–2 is SELECTION (columns to the right
 * repopulate in place), never navigation. Column 3 keeps the app-wide track
 * click contract: a bare click PLAYS (queue-aware) — there is deliberately
 * no "selected track" concept. Artist identity is content identity: entity
 * nodes and plain artist strings merge by normalized name, so servers
 * without person entities (the USB stick) still get real artist rows.
 */
export function ArtistsLens({
  pools,
  actions,
  onOpenArtistPage,
  cards,
  cardSize,
  cardGap,
  fillRows,
  onToggleLayout,
}: {
  pools: MediaIndexPools[];
  actions: LensActions;
  /** The artist's page (ArtistPage, 2026-10-11): the columns stay the browser, the page is
   *  one step in from the selected artist (the Albums heading's link, a double-click), and
   *  the cards' click. */
  onOpenArtistPage?(name: string): void;
  /** The Library's one Rows or Cards choice (libraryLayout; his pick, 2026-10-25): rows are the
   *  three columns, cards the grid (ArtistCards). */
  cards: boolean;
  cardSize: number;
  cardGap: number;
  fillRows: boolean;
  /** Flips libraryLayout, as the Albums lens's chip does. */
  onToggleLayout?: () => void;
}): React.JSX.Element {
  const [mem, setMemState] = useState(artistsMem);
  const setMem = (patch: Partial<typeof artistsMem>): void => {
    artistsMem = { ...artistsMem, ...patch };
    setMemState(artistsMem);
  };
  const albumsOnly = useStore((s) => s.settings.lensArtistsAlbumsOnly);
  const saveSettings = useStore((s) => s.saveSettings);
  // THE ORDER (0.13.0 round 12): by name, the most played, or the newest arrival; Most played
  // exists only while the listening record's stats do (the Albums lens's rule), a persisted one
  // falling back to name until they return
  const sortSetting = useStore((s) => s.settings.lensArtistsSort);
  const reversed = useStore((s) => s.settings.lensArtistsSortReversed);
  const play = usePlayStats();
  const artistSorts = play.ready
    ? ARTIST_SORTS
    : ARTIST_SORTS.filter((o) => !RECORD_SORTS.has(o.value));
  const sort = !play.ready && RECORD_SORTS.has(sortSetting) ? "name" : sortSetting;

  // what the lenses derive from the pools, once per snapshot (useLensIndex)
  const index = useLensIndex(pools);

  const artists = index.artists;

  // THE ARTIST YOU ASKED FOR IS ALWAYS IN THE COLUMN. Albums only is the
  // standing preference for browsing; a landing (Elsewhere's Go to artist, a
  // track's name link, the Queue) names one artist, and a credit-only name
  // hidden by the filter left the lens open on nothing (user, 2026-09-12:
  // Ellie Goulding, "credited on 1 track"). The selection is the exception,
  // so the setting is untouched and the row leaves with the next selection.
  const baseArtists = useMemo(
    () =>
      albumsOnly ? artists.filter((a) => a.albums.length > 0 || a.key === mem.artist) : artists,
    [artists, albumsOnly, mem.artist],
  );
  const shownArtists = useMemo(
    () =>
      orderArtists(
        mem.filter ? baseArtists.filter((a) => matchesFilter(mem.filter, [a.name])) : baseArtists,
        sort,
        reversed,
        // an artist's plays are the fold of every track they perform (useLensIndex's tracks)
        (a) => (sort === "plays" ? play.album(a.tracks).plays : 0),
      ),
    [baseArtists, mem.filter, sort, reversed, play],
  );

  // Album tracks by content identity: same server + same album title.
  const tracksByAlbum = index.tracksByAlbum;

  // Resolve the selection against the FILTERED list: filtering the selected
  // artist out empties the albums/tracks columns rather than showing content
  // for a row that isn't on screen; clearing the filter brings it back.
  const selectedArtist = shownArtists.find((a) => a.key === mem.artist) ?? null;
  const selectedAlbum = selectedArtist?.albums.find((a) => nodeKey(a) === mem.album) ?? null;
  // Two EDITIONS of one album (same title, artist, year, server — a 16/44.1
  // and a 24/44.1 folder) are two album rows; when the selected artist has
  // such twins, a track belongs to the edition whose ART it shares (Asset
  // stamps tracks with their folder's cover). Only then — a lone album must
  // not lose tracks over a server that gives tracks their own art.
  const twinTitled =
    selectedAlbum != null &&
    (selectedArtist?.albums ?? []).filter(
      (a) => a.serverUdn === selectedAlbum.serverUdn && lc(a.title) === lc(selectedAlbum.title),
    ).length > 1;
  const albumTracks = selectedAlbum
    ? (tracksByAlbum.get(`${selectedAlbum.serverUdn}|${lc(selectedAlbum.title)}`) ?? []).filter(
        (t) =>
          // same-titled album on the same server by ANOTHER artist stays out —
          // judged by album artist / performers, so a featured track ("Daft
          // Punk; Julian Casablancas" on Daft Punk's album) stays IN.
          trackInAlbumOf(t, selectedAlbum.artist) &&
          (!twinTitled || sameArt(t.artUrl, selectedAlbum.artUrl)),
      )
    : null;
  // an artist with no albums shows their loose tracks directly (vibin rule)
  const looseTracks =
    selectedArtist && selectedArtist.albums.length === 0 ? selectedArtist.tracks : null;
  // headline format + per-row deviation notes, decided together so they agree
  const albumFmt = albumFormat(albumTracks ?? []);

  // Track-column multi-select — the queue/Library grammar on its third
  // surface. Keyed by nodeKey so twin editions stay distinct; cleared when
  // the artist or album selection moves, and by Esc (the app-wide release).
  const visibleTracks = useMemo(() => albumTracks ?? looseTracks ?? [], [albumTracks, looseTracks]);
  // the tracks column's selection, its drag to the nav and its plural menu:
  // useLensTrackSelection, shared with the other track lens (2026-09-13)
  const sel = useLensTrackSelection({ tracks: visibleTracks, actions });
  const { selT, setSelT, trackRowClick } = sel;

  // A-Z fast travel: letter anchors in the artists column.
  const artistsColRef = useRef<HTMLDivElement | null>(null);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  // a long column renders the rows near its viewport; a row's place comes from its index
  // (win.offsetOf), so the A-Z travel, the reveal and keeping the selection in sight do
  // not need the row to be on the page
  const win = useWindowedList({
    scrollRef: artistsColRef,
    count: shownArtists.length,
    itemSelector: "[data-lens-artist-row]",
    estimate: 52,
    overscan: 12,
    enabled: shownArtists.length > WINDOW_ARTISTS_ABOVE,
  });
  /** Scroll the column so artist `index` sits `pad` px below its top. */
  const scrollColTo = (index: number, pad: number): number => {
    const col = artistsColRef.current;
    const top = Math.max(0, win.offsetOf(index) - pad);
    col?.scrollTo({ top });
    return top;
  };
  // When the filter reshapes the artist list, keep the selection in sight —
  // clearing "beatles" pops hundreds of rows back in ABOVE the selected one.
  // Skips the mount run (the saved column scroll is restoring then).
  const listSettled = useRef(false);
  useEffect(() => {
    if (!listSettled.current) {
      listSettled.current = true;
      return;
    }
    // a pending reveal (arrival by link) owns the column's first scroll
    if (artistsMem.reveal) return;
    if (!mem.artist) return;
    const at = shownArtists.findIndex((a) => a.key === mem.artist);
    if (at < win.first || at > win.last) {
      if (at >= 0) scrollColTo(at, REVEAL_PAD);
    } else if (selectedRowRef.current) scrollToVisible(selectedRowRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownArtists]);
  const albumsColRef = useRef<HTMLDivElement | null>(null);
  const tracksColRef = useRef<HTMLDivElement | null>(null);
  // Restore each column's remembered spot once, after first paint.
  useEffect(() => {
    requestAnimationFrame(() => {
      // the artists column defers to a pending reveal (below): under
      // StrictMode's double mount a second restore used to land AFTER the
      // reveal's frame and put the old scroll back (user, 2026-09-01: "same
      // as before" in the dev build while the built app passed)
      if (!artistsMem.reveal) artistsColRef.current?.scrollTo({ top: artistsMem.scroll.artists });
      albumsColRef.current?.scrollTo({ top: artistsMem.scroll.albums });
      tracksColRef.current?.scrollTo({ top: artistsMem.scroll.tracks });
    });
  }, []);
  // A focused artist (arrived by link) is revealed a comfortable way down
  // from the column's top, then the ask is consumed — a later visit keeps
  // the remembered scroll like any other. Container-scoped (never
  // scrollIntoView).
  useEffect(() => {
    const key = artistsMem.reveal;
    if (!key) return;
    const at = shownArtists.findIndex((a) => a.key === key);
    if (!artistsColRef.current || at < 0) return;
    requestAnimationFrame(() => {
      // consumed when APPLIED, not when scheduled — a repeated effect run
      // (StrictMode) schedules the same landing again, harmlessly
      if (artistsMem.reveal !== key) return;
      artistsMem.scroll.artists = scrollColTo(at, REVEAL_PAD);
      artistsMem.reveal = null;
    });
    // a reveal is asked once and lands when the list it names has rendered; the window's
    // geometry (scrollColTo) is read at that moment, never a reason to land again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownArtists]);
  // each letter's first artist, by index (a windowed column may not hold the row); in name
  // order only, the rail's letters meaning nothing in another
  const letterStarts = useMemo(() => {
    if (sort !== "name") return null;
    const m = new Map<string, number>();
    shownArtists.forEach((a, i) => {
      const l = letterOf(a.name);
      if (!m.has(l)) m.set(l, i);
    });
    return m;
  }, [shownArtists, sort]);
  const jumpToLetter = (letter: string): void => {
    const at = letterStarts?.get(letter);
    if (at != null) scrollColTo(at, 0);
  };

  // A NEW ORDER STARTS AT ITS TOP: the column and the grid forget their spot (the grid is keyed
  // by the order below, so it mounts fresh at the top)
  const toTop = (): void => {
    artistsMem.scroll.artists = 0;
    artistsMem.scroll.cards = 0;
    artistsColRef.current?.scrollTo({ top: 0 });
  };

  // Playing-artist highlight is content identity, like everything else.
  const playingArtistKey = actions.playingArtist ? lc(actions.playingArtist) : null;

  const colHeading = (
    label: string,
    detail?: string,
    link?: React.ReactNode,
  ): React.JSX.Element => (
    <div className="shrink-0 pb-1.5 mb-1.5 border-b border-edge flex items-baseline gap-2">
      <span className="microlabel">{label}</span>
      {detail && <span className="font-mono text-[10.5px] text-faint tabular-nums">{detail}</span>}
      {link}
    </div>
  );

  return (
    <div
      data-lens-artists
      className="h-full min-h-0 flex flex-col"
      onClick={(e) => {
        // blank-space click clears the selection (the Finder rule)
        if (selT.size === 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        const t = e.target as HTMLElement;
        // portaled dismiss clicks are their own gesture (the queue's rule)
        if (!e.currentTarget.contains(t)) return;
        if (
          t.closest(
            "button, input, a, [data-library-track], [data-lens-artist-row], [data-lens-album-row], [data-lens-selection-bar]",
          )
        )
          return;
        setSelT(new Set());
      }}
    >
      {/* the filter sits ABOVE the columns (left — over the artists column
          it scopes), so all three columns' headings and rows stay aligned */}
      <div className={`shrink-0 pb-3 flex items-center ${GAP_BETWEEN}`}>
        <FilterInput
          value={mem.filter}
          onChange={(filter) => setMem({ filter })}
          shown={shownArtists.length}
          total={artists.length}
        />
        <Chip
          state={albumsOnly ? "active" : "idle"}
          aria-pressed={albumsOnly}
          data-tip="Hide artists that only have loose tracks"
          data-lens-albums-only
          className="tip-bottom shrink-0"
          onClick={() => void saveSettings({ lensArtistsAlbumsOnly: !albumsOnly })}
        >
          With albums
        </Chip>
        {/* layout beside sort, alone on the right: the Albums lens's pairing */}
        <div className={`ml-auto flex items-center ${GAP_WITHIN} shrink-0`}>
          {onToggleLayout && (
            <HeaderChip
              data-tip={cards ? "Artists as rows" : "Artists as cards"}
              aria-label={cards ? "Artists as rows" : "Artists as cards"}
              data-lens-artists-layout={cards ? "cards" : "rows"}
              onClick={onToggleLayout}
              className="no-drag tip-bottom p-2 motion-safe:active:scale-90"
            >
              {cards ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
            </HeaderChip>
          )}
          <SortChip
            sorts={artistSorts}
            neutral="name"
            value={sort}
            reversed={reversed}
            onChange={(v) => {
              toTop();
              void saveSettings({ lensArtistsSort: v, lensArtistsSortReversed: false });
            }}
            onToggleReverse={() => {
              toTop();
              void saveSettings({ lensArtistsSortReversed: !reversed });
            }}
          />
        </div>
      </div>
      {cards ? (
        <ArtistCards
          key={`${sort}|${reversed}`}
          artists={shownArtists}
          actions={actions}
          playingKey={playingArtistKey}
          cardSize={cardSize}
          cardGap={cardGap}
          fillRows={fillRows}
          onOpenArtistPage={onOpenArtistPage}
          letterStarts={letterStarts}
          scrollTop={artistsMem.scroll.cards}
          onScrolled={(top) => {
            artistsMem.scroll.cards = top;
          }}
          reveal={artistsMem.reveal}
          onRevealed={() => {
            artistsMem.reveal = null;
          }}
        />
      ) : (
        <div className="min-h-0 flex-1 flex gap-6">
          {/* Artists ------------------------------------------------------- */}
          {/* proportional columns: fixed widths starved the tracks column (and
          its titles) at normal window sizes — tracks gets the largest share */}
          <div className="w-[24%] min-w-[220px] max-w-[320px] shrink-0 min-h-0 flex flex-col">
            {colHeading(
              "Artists",
              mem.filter || albumsOnly
                ? `${shownArtists.length}/${artists.length}`
                : String(artists.length),
            )}
            <div className="min-h-0 flex-1 flex gap-1">
              <div
                ref={artistsColRef}
                onScroll={(e) => {
                  artistsMem.scroll.artists = e.currentTarget.scrollTop;
                }}
                // px/py with matching negative margins: room INSIDE the scrollport
                // for the rings and the row-playing glow (box-shadows clip at the
                // padding box) without shifting the rows off the heading's edge
                className="relative min-h-0 flex-1 overflow-y-auto px-1.5 -mx-1.5 py-1 -my-1"
              >
                {win.padTop > 0 && <div style={{ height: win.padTop }} />}
                {shownArtists.slice(win.first, win.last + 1).map((a) => {
                  const selected = a.key === mem.artist;
                  const playing = a.key === playingArtistKey;
                  const menuOpen = actions.menuNodeId === `lens-artist:${a.key}`;
                  return (
                    <div
                      key={a.key}
                      ref={(el) => {
                        if (selected && el) selectedRowRef.current = el;
                      }}
                      data-artist-row={a.name}
                      onClick={() => setMem({ artist: selected ? null : a.key, album: null })}
                      // a double-click opens the artist's page (the page re-selects the
                      // artist, so the two clicks' toggle never shows on the way back)
                      onDoubleClick={() => onOpenArtistPage?.(a.name)}
                      // right-click = the ⋯ (the app-wide rule): the artist menu — the
                      // pivot and Info. A lens artist is content identity, not a
                      // node, so one is synthesized: the entity's server (or the first
                      // album's) is what Info sums their page from.
                      onContextMenu={(e) => {
                        e.preventDefault();
                        actions.openMenu(lensArtistNode(a), e);
                      }}
                      data-lens-artist-row={a.key}
                      className={cx(
                        // the eqbars' column only while the artist plays: the row's buttons float
                        // (below), so a name has the row's whole width at rest
                        "group relative grid items-center gap-2.5 rounded-lg px-2 py-1.5 cursor-pointer transition-colors",
                        playing ? "grid-cols-[44px_1fr_auto]" : "grid-cols-[44px_1fr]",
                        // SELECTED is "open here" — the Playlists sidebar's amber, so it
                        // reads apart from gold (= playing); a row that is both keeps
                        // the playing signals (gold title, eqbars) on the amber fill
                        // (user, 2026-09-02: the selection "didn't look distinctive").
                        // PLAYING is the app-wide row treatment — fill, ring and glow
                        // (row-playing), the same as ContainerRow and every track row —
                        // and it rides on top of the selection: a fill and an edge.
                        playing && "row-playing",
                        selected ? "bg-amberdim" : playing ? "bg-gold/10" : "hover:bg-veil",
                      )}
                    >
                      <ArtistArt name={a.name} src={a.ownArt} cover={a.artUrl} />
                      {/* under the floating buttons the name fades out rather than reflowing
                      (the column is narrow: reserved buttons cut names to a few letters) */}
                      <div
                        className={cx(
                          "min-w-0",
                          NAME_FADE[playing ? "playing" : "idle"][menuOpen ? "on" : "hover"],
                        )}
                      >
                        <div
                          className={cx(
                            "text-[13.5px] truncate",
                            playing ? "text-gold" : selected ? "text-amber" : "text-ink",
                          )}
                        >
                          {a.name}
                        </div>
                        <div className="text-[12px] text-dim truncate">{artistLine(a)}</div>
                      </div>
                      {playing && (
                        <div
                          className={cx(
                            menuOpen ? "opacity-0" : "group-hover:opacity-0 group-kbd:opacity-0",
                          )}
                        >
                          <Eqbars />
                        </div>
                      )}
                      {/* THE ROW'S BUTTONS FLOAT over its end, shown on hover and while its menu
                      is open: the ↗ to the artist's page, as an album row's ↗ opens the album
                      (user, 2026-10-11: a click here selects, the ↗ goes there), and the ⋯,
                      the same artist menu the right-click opens */}
                      <div
                        className={cx(
                          "absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2.5 transition-opacity",
                          menuOpen
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 group-kbd:opacity-100",
                        )}
                      >
                        {onOpenArtistPage && (
                          <button
                            aria-label={`Open artist page for ${a.name}`}
                            data-tip="Open artist page"
                            data-lens-open-artist={a.name}
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenArtistPage(a.name);
                            }}
                            className="tip-bottom p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-colors"
                          >
                            <ArrowUpRight size={14} />
                          </button>
                        )}
                        <button
                          aria-label="More actions"
                          data-lens-artist-menu
                          onClick={(e) => {
                            e.stopPropagation();
                            actions.openMenu(lensArtistNode(a), e);
                          }}
                          className="p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-colors"
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {win.padBottom > 0 && <div style={{ height: win.padBottom }} />}
              </div>
              {/* the A-Z rail: fast travel for a long first column, in name order */}
              {letterStarts && <AzRail letters={[...letterStarts.keys()]} onJump={jumpToLetter} />}
            </div>
          </div>

          {/* Albums -------------------------------------------------------- */}
          <div className="w-[28%] min-w-[250px] max-w-[400px] shrink-0 min-h-0 flex flex-col">
            {colHeading(
              "Albums",
              selectedArtist ? String(selectedArtist.albums.length) : undefined,
              selectedArtist && onOpenArtistPage && (
                // THE WAY IN to the artist's page: over the column the page expands on (its
                // albums as cards, the tracks they appear on, the picture and summary)
                <button
                  data-lens-artist-page
                  onClick={() => onOpenArtistPage(selectedArtist.name)}
                  className="ml-auto text-[11.5px] text-amber hover:brightness-110 transition-all"
                >
                  Artist page →
                </button>
              ),
            )}
            <div
              ref={albumsColRef}
              onScroll={(e) => {
                artistsMem.scroll.albums = e.currentTarget.scrollTop;
              }}
              className="min-h-0 flex-1 overflow-y-auto px-1.5 -mx-1.5 py-1 -my-1"
              data-lens-albums-col
            >
              {!selectedArtist ? (
                <div className="text-[12.5px] text-faint pt-2 px-1">Pick an artist.</div>
              ) : selectedArtist.albums.length === 0 ? (
                <div className="text-[12.5px] text-faint pt-2 px-1">No albums</div>
              ) : (
                selectedArtist.albums.map((alb) => {
                  const selected = nodeKey(alb) === mem.album;
                  const playing = actions.isPlayingAlbum(alb);
                  const menuOpen = actions.menuNodeId === alb.id;
                  const badge = index.copyBadge(alb);
                  return (
                    <div
                      key={nodeKey(alb)}
                      data-lens-album-row={alb.title}
                      onClick={() => setMem({ album: selected ? null : nodeKey(alb) })}
                      onPointerDown={(e) => {
                        if ((e.target as HTMLElement).closest("button")) return;
                        actions.dragAlbum([alb], e, alb.title);
                      }}
                      className={cx(
                        // the row's buttons float (below), as the artist rows' do: a title has
                        // the row's whole width at rest
                        "group relative grid grid-cols-[44px_1fr] items-center gap-2.5 rounded-lg px-2 py-1.5 cursor-pointer transition-colors",
                        // SELECTED is "open here" — the Playlists sidebar's amber, so it
                        // reads apart from gold (= playing); a row that is both keeps
                        // the playing signals (gold title, eqbars) on the amber fill
                        // (user, 2026-09-02: the selection "didn't look distinctive").
                        // PLAYING is the app-wide row treatment — fill, ring and glow
                        // (row-playing), the same as ContainerRow and every track row —
                        // and it rides on top of the selection: a fill and an edge.
                        playing && "row-playing",
                        selected ? "bg-amberdim" : playing ? "bg-gold/10" : "hover:bg-veil",
                      )}
                    >
                      <MediaArt src={alb.artUrl} kind="album" />
                      <div className={cx("min-w-0", NAME_FADE.idle[menuOpen ? "on" : "hover"])}>
                        <div
                          className={cx(
                            "flex items-center gap-2 text-[13.5px]",
                            playing ? "text-gold" : selected ? "text-amber" : "text-ink",
                          )}
                        >
                          {/* no position cell in this list, so the playing marker
                          rides inline before the title (the floating skin's
                          rule) — artist row and track row both carry one, and
                          the album between them answers WHICH album sounds */}
                          {playing && <Eqbars />}
                          <span className="truncate">{alb.title}</span>
                        </div>
                        <div className="flex items-center gap-1.5 min-w-0 text-[12px] text-dim">
                          {alb.year && <span>{alb.year}</span>}
                          {badge && (
                            <span
                              data-card-badge={badge}
                              className="ml-auto shrink-0 text-[9.5px] px-1.5 py-px rounded-full ring-1 ring-edge"
                            >
                              {badge}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* THE ROW'S BUTTONS FLOAT over its end, shown on hover and while its menu
                      is open (user, 2026-10-11: "do the same for the album rows too"), the
                      title fading under them: the ↗ opens the album, the ⋯ its menu (a plain
                      folder has none; its slot stays, so every ↗ sits on one line) */}
                      <div
                        className={cx(
                          "absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2.5 transition-opacity",
                          menuOpen
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 group-kbd:opacity-100",
                        )}
                      >
                        <button
                          aria-label={`Open album ${alb.title}`}
                          data-tip="Open album"
                          data-lens-open-album={alb.title}
                          onClick={(e) => {
                            e.stopPropagation();
                            actions.openAlbum(alb);
                          }}
                          className="tip-bottom p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-colors"
                        >
                          <ArrowUpRight size={14} />
                        </button>
                        {isAlbumClass(alb.upnpClass) ? (
                          <button
                            aria-label="More actions"
                            onClick={(e) => {
                              e.stopPropagation();
                              actions.openMenu(alb, e);
                            }}
                            className="p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-colors"
                          >
                            <MoreHorizontal size={14} />
                          </button>
                        ) : (
                          <span className="w-[26px]" />
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Tracks -------------------------------------------------------- */}
          <div className="relative flex-1 min-w-0 min-h-0 flex flex-col">
            {colHeading(
              "Tracks",
              selectedAlbum
                ? [
                    String(albumTracks?.length ?? 0),
                    fmtTime((albumTracks ?? []).reduce((acc, t) => acc + (t.durationSecs ?? 0), 0)),
                    // the album's format at a glance (from the tracks' <res>);
                    // rows that differ from it carry their own note below
                    albumFmt.label,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : looseTracks
                  ? String(looseTracks.length)
                  : undefined,
            )}
            <LensTrackSelectionBar sel={sel} className="bottom-2 inset-x-0 z-20" />
            <div
              ref={tracksColRef}
              onScroll={(e) => {
                artistsMem.scroll.tracks = e.currentTarget.scrollTop;
              }}
              className={cx(
                "min-h-0 flex-1 overflow-y-auto px-1.5 -mx-1.5 -my-1",
                // the floating bar overlaps the last rows at full scroll —
                // selection mode adds scroll-room so every row can clear it
                selT.size > 0 ? "pt-1 pb-24" : "py-1",
              )}
              data-lens-tracks-col
            >
              {albumTracks || looseTracks ? (
                // Multi-disc albums get a quiet "Disc N" divider per disc — only
                // when the list actually spans discs (discGroups is one group
                // otherwise, and the divider never renders).
                discGroups(albumTracks ?? looseTracks ?? []).map((g, gi) => (
                  <div key={g.disc ?? `d${gi}`}>
                    {g.disc != null && (
                      <div className="microlabel px-1 pt-3 pb-1" data-disc-divider>
                        Disc {g.disc}
                      </div>
                    )}
                    <div className="divide-y divide-edge/50">
                      {g.tracks.map((t, ti) => (
                        <TrackRow
                          key={nodeKey(t)}
                          node={t}
                          note={albumTracks ? albumFmt.notes[albumTracks.indexOf(t)] : null}
                          // inside an album under its artist, guests read as "feat."
                          artistLabel={
                            selectedAlbum ? performerLine(t, selectedAlbum.artist) : null
                          }
                          showArt={looseTracks != null}
                          isCurrent={actions.isCurrentTrack(t)}
                          queued={actions.trackQueued(t)}
                          menuOpen={actions.menuNodeId === t.id}
                          favorited={actions.nodeFavorited(t)}
                          selected={selT.has(nodeKey(t))}
                          selStart={!(ti > 0 && selT.has(nodeKey(g.tracks[ti - 1])))}
                          selEnd={
                            !(ti < g.tracks.length - 1 && selT.has(nodeKey(g.tracks[ti + 1])))
                          }
                          onRowClick={(e) => trackRowClick(t, e)}
                          onNavDrag={(e) => sel.startTrackDrag(t, e)}
                          onHeart={() => actions.heartNode(t)}
                          onPlayNow={(el) => actions.playTrack(t, el)}
                          onMenu={(e) => sel.rowMenu(t, e)}
                        />
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-[12.5px] text-faint pt-2 px-1">
                  {selectedArtist ? "Pick an album." : ""}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {sel.dragGhost}
      <LensTrackMenu sel={sel} />
    </div>
  );
}

// ------------------------------------------------------------------- tracks
