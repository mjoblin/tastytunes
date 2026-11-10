// THE LIBRARY'S NAVIGATION, lifted out of LibraryScreen (0.15.0, his A on the decision page
// "Hygiene Pass Decisions": the screen in two rounds, its hooks first): what a move records and
// where it lands, the three ways to arrive, the crumb trail, Backspace and history's restores, and
// the scroll a listing comes back to. The state stays the screen's (the search hook reads it
// first) and comes in here, as it does to lensNavigation; the moves go back under their old names.
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import type { MediaIndexPools, MediaIndexStatus, MediaNode } from "@shared/model";
import { useStore, type LibrarySpot } from "@/store";
import { onScreenKey } from "@/lib/keyboardOwner";
import { flashTarget, scrollToCentered } from "@/lib/scroll";
import { isArtistClass } from "@/lib/media";
import { useOneShotAsk } from "@/hooks/useOneShotAsk";
import { focusArtistsLens } from "@/components/library/LibraryLenses";
import { landingRowIndex, type LandingTrack } from "@/components/library/landing";
import {
  ARTIST_PAGE_CRUMB_ID,
  LENS_ARTIST_CRUMB_ID,
  LENS_CRUMB_ID,
  lensNavigation,
  setLensReturn,
  type Lens,
} from "@/components/library/lensNavigation";
import type { SearchLate, useLibrarySearch } from "@/components/library/useLibrarySearch";
import {
  SEARCH_CRUMB_ID,
  UNIFIED_SEARCH_CRUMB_ID,
  artistPageScroll,
  filterMemory,
  nodeKey,
  scrollMemory,
  standIn,
  type Crumb,
} from "@/components/library/libraryPlaces";

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export function useLibraryNavigation(d: {
  serverUdn: string | null;
  setServerUdn: Setter<string | null>;
  path: Crumb[];
  setPath: Setter<Crumb[]>;
  /** The listing on screen and its state (a restore waits for this destination's to land). */
  nodes: MediaNode[];
  state: "loading" | "ready" | "error";
  scrollRef: { current: HTMLDivElement | null };
  /** Which node the scroller shows once its listing has landed (scroll records only for it). */
  loadedKey: { current: string | null };
  pendingScroll: { current: number | null };
  pendingTrack: { current: LandingTrack | null };
  lens: Lens | null;
  setLens: Setter<Lens | null>;
  artistPage: string | null;
  setArtistPage: Setter<string | null>;
  atRoot: boolean;
  filter: string;
  search: ReturnType<typeof useLibrarySearch>;
  searchLate: { current: SearchLate };
  readyIndexes: MediaIndexStatus[];
  lensPools: MediaIndexPools[] | null;
  showNotice(msg: string): void;
}) {
  const {
    serverUdn,
    setServerUdn,
    path,
    setPath,
    nodes,
    state,
    scrollRef,
    loadedKey,
    pendingScroll,
    pendingTrack,
    lens,
    setLens,
    artistPage,
    setArtistPage,
    atRoot,
    filter,
    searchLate,
    readyIndexes,
    lensPools,
    showNotice,
  } = d;
  const {
    searchMode,
    setSearchMode,
    searchQuery,
    setSearchQuery,
    searchState,
    setSearchState,
    searchReturn,
    setSearchReturn,
    crossState,
    setCrossState,
    crossMode,
    restoredSearch,
    exitSearch,
    returnToSearch,
  } = d.search;
  const setScreen = useStore((s) => s.setScreen);
  const setScreenFilter = useStore((s) => s.setScreenFilter);

  const restoreListing = useEffectEvent(() => {
    if (pendingScroll.current != null && scrollRef.current) {
      // a lens at the root holds the page at 0 (it scrolls its own column)
      scrollRef.current.scrollTop = serverUdn == null && lens != null ? 0 : pendingScroll.current;
      pendingScroll.current = null;
    }
    // only once THIS destination's listing has landed — a fresh mount's first
    // ready commit is the empty initial listing, and clearing there lost the
    // track before the album ever rendered
    if (
      pendingTrack.current != null &&
      state === "ready" &&
      scrollRef.current &&
      loadedKey.current === nodeKey(serverUdn, path)
    ) {
      const rows = [...scrollRef.current.querySelectorAll<HTMLElement>("[data-library-track]")];
      const at = landingRowIndex(
        rows.map((r) => ({
          title: r.dataset.libraryTrack ?? "",
          id: r.dataset.libraryTrackId ?? null,
          secs: r.dataset.libraryTrackSecs ? Number(r.dataset.libraryTrackSecs) : null,
        })),
        pendingTrack.current,
      );
      const row = at >= 0 ? rows[at] : null;
      pendingTrack.current = null;
      if (row) {
        scrollToCentered(row, "auto");
        flashTarget(row);
      }
    }
    // runs when the LISTING commits (nodes, state); path and serverUdn are
    // read through loadedKey's guard, and a path change without a new listing
    // must not fire a restore against the old rows
  });
  useLayoutEffect(() => restoreListing(), [nodes, state]);

  // A LENS OPENS AT THE TOP OF THE PAGE: it scrolls its own column with the page held still, so
  // a root left scrolled would carry the lens up out of view; closing it at the root brings the
  // doors back to their own spot (a move between levels restores through the listing's effect)
  const holdLensTop = useEffectEvent(() => {
    const sc = scrollRef.current;
    if (!sc || serverUdn != null || searchMode) return;
    sc.scrollTop = artistPage
      ? (artistPageScroll.get(artistPage.toLowerCase()) ?? 0)
      : lens != null
        ? 0
        : (scrollMemory.get(nodeKey(null, path)) ?? 0);
  });
  useLayoutEffect(() => holdLensTop(), [lens, artistPage]);

  const rememberScroll = (): void => {
    // a lens scrolls its own column; the page under it is not the root's spot
    if (lens != null) return;
    const key = nodeKey(serverUdn, path);
    if (scrollRef.current && loadedKey.current === key)
      scrollMemory.set(key, scrollRef.current.scrollTop);
  };

  // Each level keeps its own filter: stash the current one, restore the
  // destination's (or empty) whenever navigation happens.
  // HISTORY IS THE STORE'S (one stack across screens and within the Library,
  // 2026-08-23): every move here records the spot being LEFT via navPush, and
  // back/forward hand a spot back through navRestore. `restoring` marks a
  // move that is itself a restore (or an arrival), which must not record.
  const restoring = useRef(false);
  const navPush = useStore((s) => s.navPush);
  /** This screen's spot right now, in history's shape. */
  const snapshot = (): LibrarySpot => ({
    udn: serverUdn,
    path,
    mode: searchMode,
    query: searchQuery,
    searchNow: searchState,
    crossNow: crossState,
    lens,
    artist: artistPage,
  });

  const moveTo = (udn: string | null, newPath: Crumb[]): void => {
    if (!restoring.current) navPush({ screen: "library", library: snapshot() });
    rememberScroll();
    exitSearch();
    setLens(null);
    setArtistPage(null);
    filterMemory.set(nodeKey(serverUdn, path), filter);
    setScreenFilter("library", filterMemory.get(nodeKey(udn, newPath)) ?? "");
    setServerUdn(udn);
    setPath(newPath);
  };

  /** Record the spot being left; arrivals and history restores never do. */
  const pushSpot = (): void => {
    if (!restoring.current) navPush({ screen: "library", library: snapshot() });
  };
  searchLate.current = { pushSpot, moveTo, rememberScroll, showNotice };
  // The lens navigation and THE ONE LANDING (components/library/lensNavigation).
  const {
    openLens,
    landOn,
    openAlbumFromLens,
    returnToLens,
    openArtistPage,
    closeArtistPage,
    openAlbumFromArtistPage,
    returnToArtistPage,
    goToAlbumFromLens,
    goToArtistFromLens,
  } = lensNavigation({
    lens,
    setLens,
    artistPage,
    setArtistPage,
    atRoot,
    searchMode,
    serverUdn,
    lensPools,
    restoring,
    pendingTrack,
    pushSpot,
    moveTo,
    setPath,
    showNotice,
  });

  // Three ways to arrive, and this effect picks between them.
  //
  // A DESTINATION was planted (Favorites → open album): land on that node.
  // Intermediate crumbs carry sentinel ids — clicking one fails the fresh
  // browse and the title-path re-walk resolves it, the same recovery stale USB
  // ids use.
  // The FRONT DOOR was asked for — "Library" re-invoked while already here, so
  // the nonce bumped: reset to the source list.
  // Otherwise you simply CAME BACK from another screen: restore where the last
  // visit left off. (T3 used to reset here too; see setScreen for why that
  // reversed.)
  const libraryResetNonce = useStore((s) => s.libraryResetNonce);
  const clearLibraryTarget = useStore((s) => s.clearLibraryTarget);
  /** Nonce this mount has already acted on — null until the first run. */
  const handledNonce = useRef<number | null>(null);
  const arrive = useEffectEvent(() => {
    // At most ONE action per nonce value per mount. StrictMode double-invokes
    // mount effects in dev (refs intact), and this effect is no longer
    // naturally idempotent the way the old always-reset version was: its first
    // run RESTORES, so a second run falling through to moveTo(null, []) undoes
    // the restore it just made — the screen restored and instantly reset,
    // which read as "restore doesn't work" in dev while the built app was
    // fine. The skip is the idempotence now.
    if (handledNonce.current === libraryResetNonce) return;
    // First action of a fresh mount = plain navigation back (a front-door
    // bump while mounted re-runs this effect with a CHANGED nonce instead).
    const cameBack = handledNonce.current === null;
    handledNonce.current = libraryResetNonce;
    // back/forward landed here with a spot to restore: the one-shot below
    // does it; an arrival restore on top would browse twice and win wrongly
    if (cameBack && useStore.getState().navRestore) return;
    // every move in here is an ARRIVAL, never a navigation to record
    restoring.current = true;
    try {
      const target = useStore.getState().libraryTarget;
      // Nonce EQUALITY, not consume-and-clear (a StrictMode double-run must
      // find the target intact — it skips above, but a THIRD mount shouldn't
      // chase it either). A leftover target with an older nonce is stale — drop
      // it and reset normally.
      if (target && target.nonce !== libraryResetNonce) clearLibraryTarget();
      if (target && target.nonce === libraryResetNonce) {
        if ("artist" in target) {
          // a NAME from another screen's row, Now Playing, History or Search: the
          // artist's page, over the Artists lens
          landOn({ artist: target.artist });
          return;
        }
        const last = target.titlePath.length - 1;
        landOn({
          udn: target.serverUdn,
          path: target.titlePath.map((title, i) =>
            i === last
              ? {
                  id: target.objectId,
                  title,
                  // a stand-in album node so the header renders without a metadata
                  // re-fetch; the index's own entry replaces it as albumNode once the
                  // pools are in (its keys are the Albums lens's), and until then the
                  // tracks fill what it lacks (albumFromTracks)
                  node: standIn({
                    id: target.objectId,
                    parentId: null,
                    serverUdn: target.serverUdn,
                    title,
                    upnpClass: target.upnpClass ?? "object.container.album.musicAlbum",
                    isContainer: true,
                    artUrl: null,
                    artist: null,
                    album: null,
                    year: null,
                    trackNumber: null,
                    durationSecs: null,
                  }),
                }
              : { id: `__fav-crumb-${i}__`, title },
          ),
          track: target.track
            ? { title: target.track, id: target.trackId ?? null, secs: target.trackSecs ?? null }
            : null,
          ...(target.fromSearch ? { lead: { id: UNIFIED_SEARCH_CRUMB_ID, title: "Search" } } : {}),
        });
        return;
      }
      const mem = useStore.getState().libraryLocation;
      if (cameBack && mem) {
        moveTo(mem.udn, mem.path);
        setLens(mem.lens); // moveTo clears it; the remembered lens wins
        setArtistPage(mem.lens === "artists" ? (mem.artist ?? null) : null);
        return;
      }
      // THE FRONT DOOR is the top of the root: its remembered spot goes (after moveTo has
      // recorded the level being left)
      moveTo(null, []);
      scrollMemory.delete(nodeKey(null, []));
    } finally {
      restoring.current = false;
    }
  });
  useEffect(() => arrive(), [libraryResetNonce]);

  // Keep the location current as you browse: history reads it as the spot being
  // left when a navigation goes elsewhere, and a return visit restores it (the
  // store's libraryLocation; nothing subscribes to it, so nothing re-renders on it).
  // DECLARATION ORDER MATTERS: this must stay BELOW the arrival effect. On a
  // return-mount both run, in order — arrival reads the location and queues the
  // restore, then this one overwrites it with the mount's initial (empty)
  // state; the restore's re-render writes the real values back a beat later.
  // Declared above the arrival effect, the clobber would come first and there
  // would be nothing left to restore.
  const setLibraryLocation = useStore((s) => s.setLibraryLocation);
  const recordLocation = useEffectEvent(() => {
    setLibraryLocation(snapshot());
  });
  useEffect(
    () => recordLocation(),
    [serverUdn, path, searchMode, searchQuery, searchState, crossState, lens, artistPage],
  );

  // THE ARTIST PAGE is built from the indexes: an artist has one when an index holds their server
  // (the lens's artists always; a search's or a folder's artist when theirs is indexed)
  const artistPageOf = (node: MediaNode): (() => void) | undefined =>
    node.isContainer &&
    isArtistClass(node.upnpClass) &&
    readyIndexes.some((x) => x.udn === (node.serverUdn ?? serverUdn))
      ? () => openArtistPage(node.title)
      : undefined;

  const enter = (node: MediaNode): void => {
    // A SEARCH'S ARTIST opens the artist's page (2026-10-11); an artist from a live search of an
    // unindexed server keeps its folder, as does an artist met browsing a server's folders
    const page = searchMode || crossMode ? artistPageOf(node) : undefined;
    if (page) return page();
    if (crossMode && crossState) {
      // Entering a cross-server result SCOPES to its server; the query crumb
      // leads back to the root cross view with its groups intact.
      if (!node.serverUdn) return;
      setSearchReturn({
        udn: null,
        query: crossState.query,
        items: [],
        total: 0,
        cross: crossState.groups,
        prevPath: [],
      });
      moveTo(node.serverUdn, [
        { id: SEARCH_CRUMB_ID, title: `“${crossState.query}”` },
        { id: node.id, title: node.title, node },
      ]);
      return;
    }
    if (searchMode && searchState) {
      // Entering a result: plant the query crumb so the trail offers the
      // way back, and remember the results for an instant restore.
      setSearchReturn({ ...searchState, udn: serverUdn, cross: null, prevPath: path });
      moveTo(serverUdn, [
        { id: SEARCH_CRUMB_ID, title: `“${searchState.query}”` },
        { id: node.id, title: node.title, node },
      ]);
      return;
    }
    moveTo(serverUdn, [...path, { id: node.id, title: node.title, node }]);
  };
  const enterServer = (udn: string): void => moveTo(udn, []);

  // Crumb trail: Library (source list) › source › folders…
  const jumpTo = (index: number): void => {
    if (index === 0) {
      // The root crumb reads "Search" on a from-search trail, and leads back.
      if (path[0]?.id === UNIFIED_SEARCH_CRUMB_ID) return setScreen("search");
      return moveTo(null, []);
    }
    const newPath = path.slice(0, index - 1);
    if (newPath[newPath.length - 1]?.id === UNIFIED_SEARCH_CRUMB_ID) return setScreen("search");
    if (newPath[newPath.length - 1]?.id === SEARCH_CRUMB_ID) return returnToSearch();
    const last = newPath[newPath.length - 1];
    if (last?.id === ARTIST_PAGE_CRUMB_ID) return returnToArtistPage(last.title);
    if (last?.id === LENS_ARTIST_CRUMB_ID) {
      focusArtistsLens(last.title);
      return returnToLens();
    }
    if (last?.id === LENS_CRUMB_ID) return returnToLens();
    moveTo(serverUdn, newPath);
  };
  const goUp = (): void => {
    if (searchMode)
      exitSearch(); // search exits first, folder stays
    else if (path.length > 0) {
      if (path[path.length - 2]?.id === UNIFIED_SEARCH_CRUMB_ID) return setScreen("search");
      if (path.length === 1 && path[0]?.id === UNIFIED_SEARCH_CRUMB_ID) return setScreen("search");
      if (path[path.length - 2]?.id === SEARCH_CRUMB_ID) return returnToSearch();
      const parent = path[path.length - 2]?.id;
      if (parent === ARTIST_PAGE_CRUMB_ID) return returnToArtistPage(path[path.length - 2].title);
      if (parent === LENS_CRUMB_ID || parent === LENS_ARTIST_CRUMB_ID) return returnToLens();
      moveTo(serverUdn, path.slice(0, -1));
    } else if (serverUdn) moveTo(null, []);
    else if (artistPage)
      closeArtistPage(); // the page exits to the Artists lens's columns
    else if (lens) setLens(null); // lens exits to the source list
  };

  /** Put this screen at a spot history handed back (back/forward landed here). */
  const restoreSpot = (snap: LibrarySpot): void => {
    restoring.current = true;
    try {
      moveTo(snap.udn, snap.path);
      if (snap.mode) {
        // the spot being restored was a search-results view — re-enter it,
        // without taking focus (only a false → true flip runs the focus effect)
        if (!searchMode) restoredSearch.current = true;
        setSearchMode(true);
        setSearchQuery(snap.query);
        setSearchState(snap.searchNow);
        setCrossState(snap.crossNow);
      }
      if (snap.lens) {
        setLensReturn(snap.lens);
        setLens(snap.lens);
      }
      setArtistPage(snap.lens === "artists" ? (snap.artist ?? null) : null);
    } finally {
      restoring.current = false;
    }
  };
  const navRestore = useStore((s) => s.navRestore);
  const clearNavRestore = useStore((s) => s.clearNavRestore);
  useOneShotAsk(navRestore, (ask) => restoreSpot(ask.spot), {
    claim: navRestore?.nonce,
    clear: clearNavRestore,
  });

  // Backspace goes UP a level (folder semantics; above a source's root it
  // lands on the source list). ⌘/Alt ←/→ and mouse 4/5 are history, app-wide —
  // useShortcuts owns them since 2026-08-23.
  const listenForBackspace = useEffectEvent(() =>
    onScreenKey((e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        goUp();
      }
    }),
  );
  useEffect(
    () => listenForBackspace(),
    [path, serverUdn, filter, searchState, searchReturn, searchMode, searchQuery, crossState, lens],
  );

  return {
    moveTo,
    pushSpot,
    artistPageOf,
    enter,
    enterServer,
    jumpTo,
    openLens,
    openAlbumFromLens,
    openArtistPage,
    closeArtistPage,
    openAlbumFromArtistPage,
    goToAlbumFromLens,
    goToArtistFromLens,
  };
}
