import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Heart,
  ListEnd,
  ListPlus,
  ListStart,
  MoreHorizontal,
  Play,
} from "lucide-react";
import {
  albumFormat,
  discGroups,
  type MediaIndexPools,
  type MediaNode,
  nameSortKey,
  orderTracks,
  performerLine,
  sameArt,
  trackArtists,
  trackInAlbumOf,
} from "@shared/model";
import { cx, fmtTime, matchesFilter } from "@/lib/format";
import { useStore } from "@/store";
import { scrollToVisible } from "@/lib/scroll";
import { isAlbumClass } from "@/lib/media";
import { MediaArt } from "@/components/media/MediaArt";
import { FilterInput } from "@/components/controls/FilterInput";
import { Chip, GAP_BETWEEN } from "@/components/chrome/Chrome";
import { TrackRow } from "@/components/library/LibraryCards";
import { RowMenu } from "@/components/media/RowMenu";
import { useNavDrag } from "@/hooks/useNavDrag";
import { flashNavTarget } from "@/lib/navDrop";
import { SelectionBar, SelectionVerb } from "@/components/controls/SelectionBar";
import { Eqbars } from "@/components/media/Eqbars";
import { type LensActions, lc, nodeKey } from "./lensShared";

// The Artists lens, split out of LibraryLenses.tsx (2026-09-13, the lenses round: three lenses of
// 600 to 800 lines shared one file); what the lenses share lives in ./lensShared.

interface LensArtist {
  key: string;
  name: string;
  artUrl: string | null;
  albums: MediaNode[];
  tracks: MediaNode[];
}

/**
 * A lens artist is content identity, not a node — the ⋯ / right-click menu
 * and Info want one, so it is synthesized: the entity's server (or the first
 * album's/track's) is what Info sums their page from.
 */
function lensArtistNode(a: LensArtist): MediaNode {
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

// Session memory: selections, the artist filter, and each column's scroll
// spot survive the round trip through an album leaf (and screen switches).
// The With-albums toggle lives in settings (view defaults persist,
// 2026-08-06); this is the session's workspace — spot, filter, scroll.
let artistsMem: {
  artist: string | null;
  album: string | null;
  filter: string;
  scroll: { artists: number; albums: number; tracks: number };
  /** An artist to scroll into a comfortable spot on the next render (set by
   *  focusArtistsLens; consumed once). */
  reveal: string | null;
} = {
  artist: null,
  album: null,
  filter: "",
  scroll: { artists: 0, albums: 0, tracks: 0 },
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
}: {
  pools: MediaIndexPools[];
  actions: LensActions;
}): React.JSX.Element {
  const [mem, setMemState] = useState(artistsMem);
  const setMem = (patch: Partial<typeof artistsMem>): void => {
    artistsMem = { ...artistsMem, ...patch };
    setMemState(artistsMem);
  };
  const albumsOnly = useStore((s) => s.settings.lensArtistsAlbumsOnly);
  const saveSettings = useStore((s) => s.saveSettings);

  const multiServer = useMemo(() => pools.filter((g) => g.albums.length > 0).length > 1, [pools]);

  const artists = useMemo(() => {
    const byKey = new Map<string, LensArtist>();
    const ensure = (name: string): LensArtist => {
      const key = lc(name);
      let a = byKey.get(key);
      if (!a) {
        a = { key, name: name.trim(), artUrl: null, albums: [], tracks: [] };
        byKey.set(key, a);
      }
      return a;
    };
    for (const g of pools) {
      for (const e of g.artists) {
        const a = ensure(e.title);
        a.artUrl ??= e.artUrl;
      }
      for (const alb of g.albums) if (alb.artist) ensure(alb.artist).albums.push(alb);
      // Every PERFORMER is an artist, and only performers — never the packed
      // "A; B" string. A featured singer gets a row with their one track;
      // the headliner keeps every track of the album (2026-08-15).
      for (const t of g.tracks) for (const name of trackArtists(t)) ensure(name).tracks.push(t);
    }
    return [...byKey.values()]
      .filter((a) => a.albums.length > 0 || a.tracks.length > 0)
      .map((a) => ({
        ...a,
        artUrl: a.artUrl ?? a.albums.find((x) => x.artUrl)?.artUrl ?? null,
        albums: [...a.albums].sort(
          (x, y) => (y.year ?? "").localeCompare(x.year ?? "") || x.title.localeCompare(y.title),
        ),
      }))
      .sort((a, b) => nameSortKey(a.name).localeCompare(nameSortKey(b.name)));
  }, [pools]);

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
      mem.filter ? baseArtists.filter((a) => matchesFilter(mem.filter, [a.name])) : baseArtists,
    [baseArtists, mem.filter],
  );

  // Album tracks by content identity: same server + same album title.
  const tracksByAlbum = useMemo(() => {
    const m = new Map<string, MediaNode[]>();
    for (const g of pools) {
      for (const t of g.tracks) {
        if (!t.album) continue;
        const k = `${g.udn}|${lc(t.album)}`;
        const list = m.get(k);
        if (list) list.push(t);
        else m.set(k, [t]);
      }
    }
    for (const [k, list] of m) m.set(k, orderTracks(list)); // disc, then position — or the server's order when the numbers repeat
    return m;
  }, [pools]);

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
  const [selT, setSelT] = useState<ReadonlySet<string>>(() => new Set());
  const selTAnchor = useRef<number | null>(null);
  const visibleTracks = useMemo(() => albumTracks ?? looseTracks ?? [], [albumTracks, looseTracks]);
  useEffect(() => {
    setSelT(new Set());
    selTAnchor.current = null;
  }, [mem.artist, mem.album]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target;
      if (t instanceof HTMLElement && t.matches("input, textarea, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        if (visibleTracks.length === 0) return;
        e.preventDefault();
        setSelT(new Set(visibleTracks.map(nodeKey)));
        return;
      }
      if (selT.size === 0) return;
      if (e.key === "Escape") setSelT(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleTracks, selT.size]);
  // nav-rail blank clicks clear too (the queue's rule)
  useEffect(() => {
    if (selT.size === 0) return;
    const onWin = (e: MouseEvent): void => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (!t.closest("[data-app-nav], [data-app-playbar]")) return;
      if (t.closest("button, input, a, [aria-valuenow]")) return;
      setSelT(new Set());
    };
    window.addEventListener("click", onWin);
    return () => window.removeEventListener("click", onWin);
  }, [selT.size]);
  /** The plural ⋯: a menu invoked ON a selected track speaks for the whole
   *  selection (the Finder/Spotify convention); unselected rows keep the
   *  single-track builder menu via actions.openMenu. */
  const [lensMenu, setLensMenu] = useState<{ x: number; y: number } | null>(null);
  /** True = the click was a selection chord; the caller must not play. */
  const trackRowClick = (t: MediaNode, e: React.MouseEvent): boolean => {
    const key = nodeKey(t);
    const idx = visibleTracks.findIndex((x) => nodeKey(x) === key);
    if (e.metaKey || e.ctrlKey) {
      setSelT((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      selTAnchor.current = idx;
      return true;
    }
    if (e.shiftKey && selTAnchor.current != null && idx >= 0) {
      const [a, b] = [Math.min(selTAnchor.current, idx), Math.max(selTAnchor.current, idx)];
      setSelT(new Set(visibleTracks.slice(a, b + 1).map(nodeKey)));
      return true;
    }
    // selection mode suspends playback (the queue's rule, one grammar):
    // the first bare click exits the selection, the next plays
    if (selT.size > 0) {
      setSelT(new Set());
      return true;
    }
    return false;
  };
  const chosenT = (): MediaNode[] => visibleTracks.filter((t) => selT.has(nodeKey(t)));

  // Drag-to-rail from the lens's track column — same targets and semantics
  // as the Library lists, routed through the actions the lens already has.
  const lensDragCargo = useRef<{ nodes: MediaNode[]; fromSelection: boolean }>({
    nodes: [],
    fromSelection: false,
  });
  const lensNavDrag = useNavDrag({
    targets: ["queue", "playlists", "favorites"],
    payload: () => {
      const { nodes } = lensDragCargo.current;
      if (nodes.length === 0) return null;
      return { count: nodes.length, title: nodes[0].title };
    },
    onDrop: (target, at) => {
      const { nodes, fromSelection } = lensDragCargo.current;
      if (target === "queue") {
        actions.queueTracks(nodes, "append", () => {
          if (fromSelection) setSelT(new Set());
          flashNavTarget("queue");
        });
      } else if (target === "favorites") {
        actions.heartNodes(nodes, false);
        flashNavTarget("favorites");
      } else if (target === "playlists") {
        actions.addTracksToPlaylist(
          nodes,
          at,
          fromSelection ? () => setSelT(new Set()) : undefined,
        );
      }
    },
  });
  const startLensTrackDrag = (t: MediaNode, e: React.PointerEvent): void => {
    const fromSelection = selT.has(nodeKey(t));
    lensDragCargo.current = { nodes: fromSelection ? chosenT() : [t], fromSelection };
    lensNavDrag.start(e);
  };

  // A-Z fast travel: letter anchors in the artists column.
  const artistsColRef = useRef<HTMLDivElement | null>(null);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
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
    if (mem.artist && selectedRowRef.current) scrollToVisible(selectedRowRef.current);
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
    const col = artistsColRef.current;
    const row = col?.querySelector<HTMLElement>(`[data-lens-artist-row="${CSS.escape(key)}"]`);
    if (!col || !row) return;
    requestAnimationFrame(() => {
      // consumed when APPLIED, not when scheduled — a repeated effect run
      // (StrictMode) schedules the same landing again, harmlessly
      if (artistsMem.reveal !== key) return;
      const top = Math.max(
        0,
        row.getBoundingClientRect().top -
          col.getBoundingClientRect().top +
          col.scrollTop -
          REVEAL_PAD,
      );
      col.scrollTo({ top });
      artistsMem.scroll.artists = top;
      artistsMem.reveal = null;
    });
  }, [shownArtists]);
  const letterRefs = useRef(new Map<string, HTMLDivElement>());
  const letterOf = (name: string): string => {
    const c = nameSortKey(name)[0]?.toUpperCase() ?? "#";
    return c >= "A" && c <= "Z" ? c : "#";
  };
  const letters = useMemo(
    () => [...new Set(shownArtists.map((a) => letterOf(a.name)))],
    [shownArtists],
  );
  const jumpToLetter = (letter: string): void => {
    const el = letterRefs.current.get(letter);
    const col = artistsColRef.current;
    if (el && col) col.scrollTo({ top: el.offsetTop - col.offsetTop });
  };

  // Playing-artist highlight is content identity, like everything else.
  const playingArtistKey = actions.playingArtist ? lc(actions.playingArtist) : null;

  const colHeading = (label: string, detail?: string): React.JSX.Element => (
    <div className="shrink-0 pb-1.5 mb-1.5 border-b border-edge flex items-baseline gap-2">
      <span className="microlabel">{label}</span>
      {detail && <span className="font-mono text-[10.5px] text-faint tabular-nums">{detail}</span>}
    </div>
  );

  let lastLetter = "";
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
      </div>
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
              {shownArtists.map((a) => {
                const letter = letterOf(a.name);
                const anchor = letter !== lastLetter;
                lastLetter = letter;
                const selected = a.key === mem.artist;
                const playing = a.key === playingArtistKey;
                return (
                  <div
                    key={a.key}
                    ref={(el) => {
                      if (anchor && el) letterRefs.current.set(letter, el);
                      if (selected && el) selectedRowRef.current = el;
                    }}
                    data-artist-row={a.name}
                    onClick={() => setMem({ artist: selected ? null : a.key, album: null })}
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
                      "group grid grid-cols-[44px_1fr_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 cursor-pointer transition-colors",
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
                    <MediaArt src={a.artUrl} kind="artist" />
                    <div className="min-w-0">
                      <div
                        className={cx(
                          "text-[13.5px] truncate",
                          playing ? "text-gold" : selected ? "text-amber" : "text-ink",
                        )}
                      >
                        {a.name}
                      </div>
                      <div className="text-[12px] text-dim truncate">
                        {a.albums.length > 0
                          ? `${a.albums.length} album${a.albums.length === 1 ? "" : "s"}`
                          : `${a.tracks.length} track${a.tracks.length === 1 ? "" : "s"}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {playing && <Eqbars />}
                      {/* the ⋯, hover-revealed like the album rows' — the same
                        artist menu the right-click opens */}
                      <button
                        aria-label="More actions"
                        data-lens-artist-menu
                        onClick={(e) => {
                          e.stopPropagation();
                          actions.openMenu(lensArtistNode(a), e);
                        }}
                        className={cx(
                          "p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all",
                          actions.menuNodeId === `lens-artist:${a.key}`
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100",
                        )}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* the A-Z rail: fast travel for a long first column */}
            <div
              data-az-rail
              className="shrink-0 flex flex-col items-center justify-center gap-px pl-0.5 select-none"
            >
              {letters.map((l) => (
                <button
                  key={l}
                  onClick={() => jumpToLetter(l)}
                  className="px-1 text-[9.5px] leading-[13px] font-mono text-faint hover:text-gold transition-colors"
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Albums -------------------------------------------------------- */}
        <div className="w-[28%] min-w-[250px] max-w-[400px] shrink-0 min-h-0 flex flex-col">
          {colHeading("Albums", selectedArtist ? String(selectedArtist.albums.length) : undefined)}
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
                      "group grid grid-cols-[44px_1fr_auto_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 cursor-pointer transition-colors",
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
                    <div className="min-w-0">
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
                        {multiServer && alb.serverName && (
                          <span
                            data-card-badge={alb.serverName}
                            className="shrink-0 text-[9.5px] px-1.5 py-px rounded-full ring-1 ring-edge"
                          >
                            {alb.serverName}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      aria-label={`Open album ${alb.title}`}
                      data-tip="Open album"
                      data-lens-open-album={alb.title}
                      onClick={(e) => {
                        e.stopPropagation();
                        actions.openAlbum(alb);
                      }}
                      className={cx(
                        "tip-bottom p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all",
                        actions.menuNodeId === alb.id
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100",
                      )}
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
                        className={cx(
                          "p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all",
                          actions.menuNodeId === alb.id
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100",
                        )}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    ) : (
                      <span />
                    )}
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
          {selT.size > 0 && (
            <SelectionBar
              count={selT.size}
              onClear={() => setSelT(new Set())}
              className="bottom-2 inset-x-0 z-20"
              data-lens-selection-bar
            >
              <SelectionVerb
                icon={<Play size={13} />}
                onClick={() => actions.queueTracks(chosenT(), "now", () => setSelT(new Set()))}
              >
                Play now
              </SelectionVerb>
              <SelectionVerb
                icon={<ListStart size={13} />}
                onClick={() => actions.queueTracks(chosenT(), "next", () => setSelT(new Set()))}
              >
                Play next
              </SelectionVerb>
              <SelectionVerb
                icon={<ListEnd size={13} />}
                onClick={() => actions.queueTracks(chosenT(), "append", () => setSelT(new Set()))}
              >
                Add to end of queue
              </SelectionVerb>
              <SelectionVerb
                icon={<ListPlus size={13} />}
                onClick={(e) =>
                  actions.addTracksToPlaylist(chosenT(), { x: e.clientX, y: e.clientY }, () =>
                    setSelT(new Set()),
                  )
                }
              >
                Add to playlist…
              </SelectionVerb>
              {(() => {
                const nodes = chosenT();
                const allIn = nodes.length > 0 && nodes.every(actions.nodeFavorited);
                return (
                  <SelectionVerb
                    icon={<Heart size={13} fill={allIn ? "currentColor" : "none"} />}
                    onClick={() => actions.heartNodes(nodes, allIn)}
                  >
                    {allIn ? "Remove from favorites" : "Add to favorites"}
                  </SelectionVerb>
                );
              })()}
            </SelectionBar>
          )}
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
                        artistLabel={selectedAlbum ? performerLine(t, selectedAlbum.artist) : null}
                        showArt={looseTracks != null}
                        isCurrent={actions.isCurrentTrack(t)}
                        queued={actions.trackQueued(t)}
                        menuOpen={actions.menuNodeId === t.id}
                        favorited={actions.nodeFavorited(t)}
                        selected={selT.has(nodeKey(t))}
                        selStart={!(ti > 0 && selT.has(nodeKey(g.tracks[ti - 1])))}
                        selEnd={!(ti < g.tracks.length - 1 && selT.has(nodeKey(g.tracks[ti + 1])))}
                        onRowClick={(e) => trackRowClick(t, e)}
                        onNavDrag={(e) => startLensTrackDrag(t, e)}
                        onHeart={() => actions.heartNode(t)}
                        onPlayNow={(el) => actions.playTrack(t, el)}
                        onMenu={(e) => {
                          if (selT.size > 1 && selT.has(nodeKey(t))) {
                            e.preventDefault();
                            e.stopPropagation();
                            setLensMenu({ x: e.clientX, y: e.clientY });
                          } else actions.openMenu(t, e);
                        }}
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
      {lensNavDrag.ghost}
      {lensMenu && (
        <RowMenu
          title={`${selT.size} tracks`}
          at={lensMenu}
          onClose={() => setLensMenu(null)}
          items={[
            {
              label: "Play now",
              run: () => actions.queueTracks(chosenT(), "now", () => setSelT(new Set())),
            },
            {
              label: "Play next",
              run: () => actions.queueTracks(chosenT(), "next", () => setSelT(new Set())),
            },
            {
              label: "Add to end of queue",
              run: () => actions.queueTracks(chosenT(), "append", () => setSelT(new Set())),
            },
            {
              label: "Add to playlist…",
              run: () => actions.addTracksToPlaylist(chosenT(), lensMenu, () => setSelT(new Set())),
            },
            (() => {
              const nodes = chosenT();
              const allIn = nodes.length > 0 && nodes.every(actions.nodeFavorited);
              return {
                label: allIn ? "Remove from favorites" : "Add to favorites",
                run: () => actions.heartNodes(nodes, allIn),
              };
            })(),
          ]}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- tracks
