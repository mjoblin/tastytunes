import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import { artKeyOf } from "@/lib/artSrc";
import type { LibrarySpot } from "@/store";
import {
  HardDrive,
  Heart,
  LayoutGrid,
  Library,
  ListEnd,
  ListPlus,
  ListStart,
  Play,
  RotateCw,
  Rows3,
  Search,
  Usb,
} from "lucide-react";
import {
  presetVolumeKey,
  type AppSettings,
  type MediaNode,
  type MediaQueueAction,
  type MediaServerInfo,
  type ScreenLayout,
  orderTracks,
  discGroups,
  albumFormat,
  albumComposers,
  performerLine,
  nameSortKey,
  albumVolume,
  albumOfTrack,
  trackPosition,
} from "@shared/model";
import { albumDrKey } from "@shared/model";
import { useAlbumDr } from "@/lib/audioAnalysis";
import { FACT_SEP, albumFactsLine, albumFromTracks } from "@/lib/mediaFacts";
import { usePlayStats } from "@/lib/playStats";
import { useBestArt } from "@/lib/bestArt";
import { queueWrite, tt } from "@/api";
import { useStore } from "@/store";
import { cx, matchesFilter } from "@/lib/format";
import { useIndexPools } from "@/hooks/useIndexPools";
import { MOD } from "@/lib/screens";
import { flashTarget, scrollToCentered } from "@/lib/scroll";
import { isAlbumClass, isArtistClass, stripFurniture } from "@/lib/media";
import { FilterInput } from "@/components/controls/FilterInput";
import { ContainerCard, ContainerRow, TrackRow } from "@/components/library/LibraryCards";
import { Crumbs } from "@/components/library/Crumbs";
import { SortChip } from "@/components/controls/SortChip";
import {
  AlbumsLens,
  ArtistsLens,
  TracksLens,
  focusArtistsLens,
  type LensActions,
} from "@/components/library/LibraryLenses";
import {
  LENS_ARTIST_CRUMB_ID,
  ARTIST_PAGE_CRUMB_ID,
  LENS_CRUMB_ID,
  LENS_LABEL,
  lensNavigation,
  setLensReturn,
  type Lens,
} from "@/components/library/lensNavigation";
import { SelectionBar, SelectionVerb } from "@/components/controls/SelectionBar";
import { EmptyState } from "@/components/chrome/EmptyState";
import {
  HeaderChip,
  PrimaryButton,
  ScreenTitle,
  GAP_BETWEEN,
  GAP_WITHIN,
} from "@/components/chrome/Chrome";
import { useOneShotAsk } from "@/hooks/useOneShotAsk";
import { useLibraryMenus, type MenusLate } from "@/components/library/useLibraryMenus";
import { useLibraryFavorites } from "@/components/library/useLibraryFavorites";
import { LibraryPopovers } from "@/components/library/LibraryPopovers";
import { LibraryRoot } from "@/components/library/LibraryRoot";
import { useIndexDoors } from "@/components/library/useIndexDoors";
import { usePlayingMatch } from "@/components/library/usePlayingMatch";
import { useQueueMatch } from "@/components/library/useQueueMatch";
import { useWindowedList } from "@/hooks/useWindowedList";
import { Lru } from "@/lib/lru";
import { AlbumHeader } from "@/components/library/AlbumHeader";
import { ArtistHeader } from "@/components/library/ArtistHeader";
import { ArtistPage } from "@/components/library/ArtistPage";
import { LibrarySearchBar } from "@/components/library/LibrarySearchBar";
import { useLibrarySelection, type SelectionLate } from "@/components/library/useLibrarySelection";
import {
  matchesKind,
  sortSearch,
  useLibrarySearch,
  type SearchLate,
} from "@/components/library/useLibrarySearch";

// Crumbs keep the entered node so an album level can render its header
// (art, artist, year) without re-fetching metadata.
export type Crumb = { id: string; title: string; node?: MediaNode };

// Returning to the Library RESTORES where the last visit left off
// (positionMemory below) — the T3 "always the front door" rule was reversed
// 2026-07-24 (user ask); the reset now lives behind re-invoking Library while
// already here, or the breadcrumb root. Per-folder scroll and filter memories
// apply while browsing within a visit.
const scrollMemory = new Map<string, number>();
// Per-LEVEL filter memory: each folder keeps its own filter for the session
// (the store's screenFilters.library always holds the current level's).
const filterMemory = new Map<string, string>();
// Where the last visit left off — server, crumb trail, and which lens was open —
// is the store's libraryLocation (the 0.11.0 sweep; it was a module variable here
// and a second copy in lib/navSpot for history). The screen UNMOUNTS on every
// navigation away (App renders only the active screen), so component state can't
// survive the trip. Restored on arrival from another screen; deliberately NOT
// consulted when the front door is asked for explicitly (see the reset effect).

const nodeKey = (serverUdn: string | null, path: Crumb[]): string =>
  `${serverUdn ?? ""}|${path.map((c) => c.id).join("/")}`;

// Synthetic crumb planted when a search RESULT is entered: the trail reads
// Library › server › “query” › Artist, and the query crumb (or Backspace)
// restores the search with its results intact. It never reaches the browse
// layer — titlePaths strip it (a result's true folder path is unknown, so
// stale-id rewalks can't recover search-entered branches either way).
const SEARCH_CRUMB_ID = "__search-results__";

// The lens crumbs (LENS_CRUMB_ID, LENS_ARTIST_CRUMB_ID) live with the lens
// navigation in components/library/lensNavigation.
/**
 * Planted when a UNIFIED SEARCH result opens here: the trail reads
 * Search › <server> › <album>, and that crumb — or Backspace, or ⌘← — returns
 * to the Search screen with its query intact (the screen remembers it).
 *
 * Same idiom as the search and lens crumbs, with one difference worth stating: this crumb
 * leads OFF this screen. Without it, arriving from search left you in a browse
 * tree you never navigated into, and back went to the source list — reported
 * as "⌘← takes me to the top of the library".
 */
const UNIFIED_SEARCH_CRUMB_ID = "__from-search__";

/** One wording for a queue write that didn't land, whichever verb sent it. */
const QUEUE_FAILED = "Couldn't reach the streamer. Nothing was queued.";
/** Each artist page's scroll spot for the session (an album opened from it and Back). */
const artistPageScroll = new Lru<string, number>(200);

/** One line of the windowed search results (see searchLines): every kind has one height. */
type SearchLine =
  | {
      kind: "group0" | "group";
      key: string;
      group: { udn: string; serverName: string; total: number };
    }
  | { kind: "label0" | "label" | "klabel"; key: string; text: string }
  | { kind: "cards0" | "cards"; key: string; nodes: MediaNode[] }
  | { kind: "crow" | "track"; key: string; node: MediaNode; list: MediaNode[]; index: number };

/**
 * Library: browse UPnP media (LAN servers and the streamer's own USB storage)
 * and act on it — a bare click is never destructive (track click = Play now,
 * container click = drill in); queue-replacing verbs live behind explicit
 * buttons and the ⋯ menu.
 */
export function LibraryScreen(): React.JSX.Element {
  const {
    libraryLayout,
    librarySort,
    librarySortReversed,
    presetCardSize,
    presetGap,
    presetFillRows,
  } = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const saveSettings = useStore((s) => s.saveSettings);
  const filter = useStore((s) => s.screenFilters.library);
  const setScreenFilter = useStore((s) => s.setScreenFilter);
  const setScreen = useStore((s) => s.setScreen);
  const systemInfo = useStore((s) => s.systemInfo);
  const cards = libraryLayout === "cards";

  const [servers, setServers] = useState<MediaServerInfo[] | null>(null);
  const [serverUdn, setServerUdn] = useState<string | null>(null);
  const [playlistPicker, setPlaylistPicker] = useState<{
    node: MediaNode;
    x: number;
    y: number;
  } | null>(null);
  const [path, setPath] = useState<Crumb[]>([]);
  const [nodes, setNodes] = useState<MediaNode[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // Whole-library search MODE (searchable servers): an explicit state with
  // its own gold bar and input — visually distinct from folder filtering. Its
  // state, its memories, the ways in and out, the searches and the ⌘F ask live
  // in components/library/useLibrarySearch (lifted 2026-09-13, the first lift
  // of this screen's hygiene round); the screen takes the state back under
  // the old names, so nothing downstream moved. The few things search MOVES
  // are declared below the hook and reach it late-bound through searchLate.
  const searchLate = useRef<SearchLate>({
    pushSpot: () => {},
    moveTo: () => {},
    rememberScroll: () => {},
    showNotice: () => {},
  });
  const {
    searchMode,
    setSearchMode,
    searchQuery,
    setSearchQuery,
    searchState,
    setSearchState,
    searching,
    searchReturn,
    setSearchReturn,
    searchKind,
    setSearchKind,
    searchSort,
    setSearchSort,
    searchSortReversed,
    setSearchSortReversed,
    crossState,
    setCrossState,
    setSearchServerUdn,
    crossMode,
    crossServerUdn,
    searchInputRef,
    restoredSearch,
    exitSearch,
    enterSearch,
    returnToSearch,
    runSearch,
  } = useLibrarySearch({
    serverUdn,
    setServerUdn,
    path,
    setPath,
    servers,
    filter,
    setScreenFilter,
    filterMemory,
    nodeKey,
    late: searchLate,
  });
  const [fetchNonce, setFetchNonce] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Which node the scroller currently shows, once its listing has landed —
  // scroll memory records only for that node, so a fresh mount (scroller at
  // 0, listing not yet fetched) can't clobber a remembered spot.
  const loadedKey = useRef<string | null>(null);
  const pendingScroll = useRef<number | null>(null);
  /** A track title a destination asked to land on (LibraryTarget.track). */
  const pendingTrack = useRef<string | null>(null);
  useLayoutEffect(() => {
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
      const sel = `[data-library-track="${CSS.escape(pendingTrack.current)}"]`;
      const row = scrollRef.current.querySelector<HTMLElement>(sel);
      pendingTrack.current = null;
      if (row) {
        scrollToCentered(row, "auto");
        flashTarget(row);
      }
    }
    // runs when the LISTING commits (nodes, state); path and serverUdn are
    // read through loadedKey's guard, and a path change without a new listing
    // must not fire a restore against the old rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, state]);
  const atRoot = serverUdn == null;

  // what the indexes offer: the doors' state, cross-server search (useIndexDoors)
  const { readyIndexes, crossAvailable, crossPending } = useIndexDoors();
  const [lens, setLens] = useState<Lens | null>(null);
  /** The artist page open over the Artists lens, by name (ArtistPage, 2026-10-11). */
  const [artistPage, setArtistPage] = useState<string | null>(null);
  // A LENS OPENS AT THE TOP OF THE PAGE: it scrolls its own column with the page held still, so
  // a root left scrolled would carry the lens up out of view; closing it at the root brings the
  // doors back to their own spot (a move between levels restores through the listing's effect)
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc || serverUdn != null || searchMode) return;
    sc.scrollTop = artistPage
      ? (artistPageScroll.get(artistPage.toLowerCase()) ?? 0)
      : lens != null
        ? 0
        : (scrollMemory.get(nodeKey(null, path)) ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens, artistPage]);

  // (⌘A/Esc keyboard handling lives below the listing memo — its deps need
  // the visible tracks.)
  // the pools snapshot (cached on the ready indexes' signature) — fetched
  // when a lens opens, shared with the queue rows via useIndexPools
  // pools also load while browsing a volume-suffixed album, so the header
  // can offer the set line without a lens ever having been opened
  const tailVol = albumVolume(path.at(-1)?.title ?? "");
  const lensPools = useIndexPools(lens != null || tailVol != null);

  // Action feedback: the app-wide toast for failures, a gold pulse for wins.
  // (The screen's original local notice banner graduated into the toast.)
  const showToast = useStore((s) => s.showToast);
  const playStats = usePlayStats();
  const showNotice = (msg: string): void => showToast({ kind: "error", text: msg });

  const loadServers = useCallback((): void => {
    setServers(null);
    void tt
      .mediaServers()
      .then((list) => {
        setServers(list);
        // a remembered source that vanished falls back to the source list
        setServerUdn((cur) => (cur && list.some((s) => s.udn === cur) ? cur : null));
      })
      .catch(() => setServers([]));
  }, []);

  useEffect(() => loadServers(), [loadServers]);

  useEffect(() => {
    if (!serverUdn) {
      setNodes([]);
      setState("ready");
      // THE ROOT KEEPS ITS OWN SPOT (2026-10-11, found checking the sweep): it records as it
      // scrolls and comes back to it like every other level; it never did (no loadedKey), so
      // the page stayed wherever the level before it was. The front door clears the spot
      // (the reset effect), so re-invoking Library lands at the top.
      loadedKey.current = nodeKey(null, path);
      pendingScroll.current = scrollMemory.get(nodeKey(null, path)) ?? 0;
      return;
    }
    let stale = false;
    setState("loading");
    void tt
      .mediaBrowse(
        serverUdn,
        path.length > 0 ? path[path.length - 1].id : null,
        path
          .filter(
            (c) =>
              c.id !== SEARCH_CRUMB_ID &&
              c.id !== UNIFIED_SEARCH_CRUMB_ID &&
              // lens crumbs are the app's, not the server's containers
              c.id !== LENS_CRUMB_ID &&
              c.id !== LENS_ARTIST_CRUMB_ID &&
              c.id !== ARTIST_PAGE_CRUMB_ID,
          )
          .map((c) => c.title),
      )
      .then((list) => {
        if (stale) return;
        setNodes(stripFurniture(list));
        setState("ready");
        loadedKey.current = nodeKey(serverUdn, path);
        // applied by the layout effect below, AFTER these rows commit — a rAF
        // here could run against the previous listing and clamp to 0
        pendingScroll.current = scrollMemory.get(nodeKey(serverUdn, path)) ?? 0;
      })
      .catch(() => {
        if (!stale) setState("error");
      });
    return () => {
      stale = true;
    };
  }, [serverUdn, path, fetchNonce]);

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
  useEffect(() => {
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
                  // synthetic album node so the header renders without a
                  // metadata re-fetch (art falls back to the first track's)
                  node: {
                    id: target.objectId,
                    parentId: null,
                    title,
                    upnpClass: target.upnpClass ?? "object.container.album.musicAlbum",
                    isContainer: true,
                    artUrl: null,
                    artist: null,
                    album: null,
                    year: null,
                    trackNumber: null,
                    durationSecs: null,
                  },
                }
              : { id: `__fav-crumb-${i}__`, title },
          ),
          track: target.track ?? null,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryResetNonce]);

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
  useEffect(() => {
    setLibraryLocation(snapshot());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUdn, path, searchMode, searchQuery, searchState, crossState, lens, artistPage]);

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

  /** Bring the search back exactly as it was left (no refetch). */
  const serverIndex = useStore((st) => st.mediaIndex.find((x) => x.udn === serverUdn));

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
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        goUp();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    path,
    serverUdn,
    filter,
    searchState,
    searchReturn,
    searchMode,
    searchQuery,
    crossState,
    lens,
  ]);

  const setLayout = async (libraryLayout: ScreenLayout): Promise<void> => {
    await saveSettings({ libraryLayout });
  };

  // ----------------------------------------------------------------- actions

  // Cross-server results carry their own server stamp; everything else
  // belongs to the screen's current server.
  const nodeUdn = (node: MediaNode): string | null => node.serverUdn ?? serverUdn;

  // The menus and their verb builders, the analysis sweeps and the link
  // resolvers live in components/library/useLibraryMenus (lifted 2026-09-13,
  // the second lift); the screen keeps the menus' rendering and takes the
  // state and the builders back under the old names. What the builders read
  // that is derived below (the open album, its volume siblings, the visible
  // tracks) reaches them late-bound through menusLate.
  const menusLate = useRef<MenusLate>({
    albumNode: null,
    setSiblings: null,
    openVolume: () => {},
    allTracks: [],
  });
  const {
    menu,
    setMenu,
    presetPicker,
    setPresetPicker,
    menuNodeId,
    openMenu,
    tracksForInfo,
    discCountForInfo,
    volumeNavVerbs,
    analyzeVerbs,
    linkable,
    goToAlbum,
    goToArtist,
    runAnalyzeAlbums,
    runAnalyzeTracks,
    saveNodesAsPlaylist,
    unreadable,
  } = useLibraryMenus({
    serverUdn,
    servers,
    path,
    nodeUdn,
    enter,
    lensPools,
    showToast,
    showNotice,
    late: menusLate,
    openArtistPage,
  });

  const act = async (
    node: MediaNode,
    action: MediaQueueAction,
    el: HTMLElement | null,
    playFromId?: string,
  ): Promise<void> => {
    const udn = nodeUdn(node);
    if (!udn) return;
    const outcome = await queueWrite(() => tt.mediaQueueAdd(udn, node.id, action, playFromId));
    if (outcome === "failed") showNotice(QUEUE_FAILED);
    else if (outcome === "ok" && el) flashTarget(el);
  };

  // which tracks are queued, and a bare click's jump to a queued entry (useQueueMatch)
  const { trackQueued, playTrack } = useQueueMatch((node, el) => void act(node, "PLAY_NOW", el));

  // Selection and drag live in components/library/useLibrarySelection (lifted
  // 2026-09-13, the third lift): the multi-select over the visible track rows,
  // the batch queue writes and their undo, and the drag to the nav with the
  // Finder payload rule; the screen keeps the rows, the bar and the actions,
  // and takes the state back under the old names. The hook is called after
  // the listing memo (it reads the visible tracks directly since step two of
  // the lenses round, 2026-09-13); the hearts, derived later, reach it
  // late-bound through selectionLate.
  const selectionLate = useRef<SelectionLate>({
    heartNode: () => {},
    heartNodes: () => {},
    nodeFavorited: () => false,
  });

  /** "Play" on a container: replace the queue with it and start at its first track. */
  const playContainer = async (node: MediaNode, el: HTMLElement | null): Promise<void> => {
    const udn = nodeUdn(node);
    if (!udn) return;
    const outcome = await queueWrite(async () => {
      const children = await tt.mediaBrowse(udn, node.id, [
        ...path.map((c) => c.title),
        node.title,
      ]);
      const firstTrack = children.find((c) => !c.isContainer);
      if (firstTrack) await tt.mediaQueueAdd(udn, node.id, "PLAY_FROM_HERE", firstTrack.id);
      else await tt.mediaQueueAdd(udn, node.id, "REPLACE");
    });
    if (outcome === "failed") showNotice(QUEUE_FAILED);
    else if (outcome === "ok" && el) flashTarget(el);
  };

  /** "Play album from here" on a track: the album's OWN browse supplies both
   *  ids, the album view's contract (and the resume card's). A pooled or
   *  searched track's parentId is the search scope, the whole library on
   *  Asset, and its id belongs to that path: Play from here on it queued
   *  2,528 tracks (2026-09-04). A row of the album leaf on screen came from
   *  that browse and is used as it is. */
  const playAlbumFrom = async (track: MediaNode): Promise<void> => {
    const udn = nodeUdn(track);
    if (!udn) return;
    const leaf = path[path.length - 1];
    if (leaf && track.parentId === leaf.id && nodes.some((n) => n.id === track.id)) {
      await act({ ...track, id: leaf.id }, "PLAY_FROM_HERE", null, track.id);
      return;
    }
    const pools = lensPools ?? (await tt.mediaIndexPools().catch(() => null));
    const pool = pools?.find((g) => g.udn === udn);
    const album = pool ? albumOfTrack(track, pool) : null;
    const kids = album
      ? await tt.mediaBrowse(udn, album.id, [album.title]).catch(() => null)
      : null;
    const title = track.title.trim().toLowerCase();
    const same = (kids ?? []).filter(
      (k) => !k.isContainer && k.title.trim().toLowerCase() === title,
    );
    // twin titles on one album are real (a reprise): the position tells them apart
    const start = same.find((k) => trackPosition(k) === trackPosition(track)) ?? same[0];
    if (!album || !start) {
      showNotice(`Couldn't find "${track.album ?? "that album"}" in this library.`);
      return;
    }
    await act({ ...album, serverUdn: udn }, "PLAY_FROM_HERE", null, start.id);
  };

  // Throws on failure so the shared panel stays open; closes the picker itself
  // on success. A custom name rides along via presetRename (the firmware names
  // media presets from content otherwise).
  const savePreset = async (node: MediaNode, slot: number, name: string | null): Promise<void> => {
    const udn = nodeUdn(node);
    if (!udn) return;
    try {
      await tt.mediaPresetSave(udn, node.id, slot);
      if (name) await tt.command({ type: "presetRename", slot, name });
    } catch {
      showNotice("Couldn't save the preset.");
      throw new Error("preset save failed");
    }
    // Record the artist locally (settings.presetArtists): /presets/list has
    // no artist field and firmware-derived names are just the album title —
    // this is what lets the Presets filter match by artist. Read fresh so
    // back-to-back saves can't clobber each other's keys.
    const artist = node === albumNode ? (albumArtist ?? node.artist) : node.artist;
    if (artist) {
      void saveSettings({
        presetArtists: {
          ...useStore.getState().settings.presetArtists,
          [presetVolumeKey(systemInfo?.udn, slot)]: artist,
        },
      });
    }
    setPresetPicker(null);
    // unlike queue-adds there's no in-place flash — the effect lives on Presets
    showToast({
      kind: "success",
      text: `Saved “${name ?? node.title}” to preset ${slot}`,
      action: { label: "View", screen: "presets" },
    });
  };

  const setMediaInfo = useStore((s) => s.setMediaInfo);

  // -------------------------------------------------------------- derivation

  // The filter belongs to listings with playable media (albums/tracks);
  // navigation folders and the source list don't offer it. Search results
  // aren't client-filtered — the search input is the text control there.
  const hasPlayable = nodes.some((n) => !n.isContainer || isAlbumClass(n.upnpClass));
  const filterAvailable = !searchMode && !atRoot && state === "ready" && hasPlayable;
  const effFilter = filterAvailable ? filter : "";

  // Album level: header with art + album metadata; tracks drop per-row art.
  // (Derived before the listing memo — album tracklists sort by track number.)
  const lastCrumbNode = path.length > 0 ? path[path.length - 1].node : undefined;
  const albumNode =
    !searchMode && lastCrumbNode && isAlbumClass(lastCrumbNode.upnpClass) ? lastCrumbNode : null;
  /** An artist folder opens under the artist's picture and name (ArtistHeader). */
  const artistNode =
    !searchMode && lastCrumbNode && isArtistClass(lastCrumbNode.upnpClass) ? lastCrumbNode : null;
  const albumVol = albumNode ? albumVolume(albumNode.title) : null;
  /** The browsed album's volume siblings (same parsed base + artist), by volume. */
  const setSiblings = useMemo(() => {
    if (!albumVol || !albumNode || !lensPools) return null;
    const artist = (albumNode.albumArtist ?? albumNode.artist ?? "").toLowerCase();
    const found = lensPools
      .flatMap((g) => g.albums)
      .filter((a) => {
        const v = albumVolume(a.title);
        return (
          v != null &&
          v.base.toLowerCase() === albumVol.base.toLowerCase() &&
          (a.albumArtist ?? a.artist ?? "").toLowerCase() === artist
        );
      })
      .sort((a, b) => (albumVolume(a.title)?.volume ?? 0) - (albumVolume(b.title)?.volume ?? 0));
    return found.length >= 2 ? found : null;
  }, [albumVol, albumNode, lensPools]);
  /** A sibling's own marker text — its title minus the set's base ("Boxed
   *  Winds [Disc 2]" → "Disc 2"), keeping whatever word the title used. */
  const volumeMarker = (title: string): string => {
    if (!albumVol) return title;
    const tail = title.trim().slice(albumVol.base.length);
    return tail.replace(/^[\s\-–—:,([]+/, "").replace(/[\])\s]+$/, "") || title;
  };
  /** Jump to a volume sibling — the single-crumb move the set header has
   *  always used (the volume is its own album; Back returns in one step). */
  const openVolume = (a: MediaNode): void => {
    if (a.serverUdn) moveTo(a.serverUdn, [{ id: a.id, title: a.title, node: a }]);
  };
  // the sweep's progress (the header's pill and the album menu's state read it)
  const analysisProgress = useStore((s) => s.analysisProgress);

  // Filtered + sorted listings are memoized: unmemoized they re-ran the
  // localeCompare sorts and filter scans on every store push — once a second
  // during playback, under grids that can hold 400+ cards.
  const { baseNodes, shown, containers, tracks } = useMemo(() => {
    const baseNodes = searchMode ? (searchState?.items ?? []) : nodes;
    const shown = effFilter
      ? baseNodes.filter((n) => matchesFilter(effFilter, [n.title, n.artist, n.album, n.year]))
      : baseNodes;
    // Shared sort for albums AND loose-track listings; missing fields fall
    // back to title so folders stay sane. Album tracklists are exempt below.
    const sortNodes = (list: MediaNode[]): MediaNode[] => {
      const sorted =
        librarySort === "server"
          ? list
          : [...list].sort((a, b) => {
              if (librarySort === "artist")
                return (
                  nameSortKey(a.artist ?? "￿").localeCompare(nameSortKey(b.artist ?? "￿")) ||
                  a.title.localeCompare(b.title)
                );
              if (librarySort === "year")
                return (b.year ?? "").localeCompare(a.year ?? "") || a.title.localeCompare(b.title);
              return a.title.localeCompare(b.title);
            });
      return librarySortReversed ? [...sorted].reverse() : sorted;
    };
    // Search results: the kind filter narrows, the search sort orders (its
    // 'relevance' default keeps the index's artists→albums→tracks order).
    let searchShown = shown;
    if (searchMode) {
      if (searchKind !== "all") searchShown = shown.filter((n) => matchesKind(n, searchKind));
      searchShown = sortSearch(searchShown, searchSort, searchSortReversed);
    }
    const containers = searchMode
      ? searchShown.filter((n) => n.isContainer)
      : sortNodes(shown.filter((n) => n.isContainer));
    const rawTracks = (searchMode ? searchShown : shown).filter((n) => !n.isContainer);
    // Track order: album views always by track number (the album's own
    // order); loose listings (Title views, mixed folders) follow the sort.
    const tracks = albumNode
      ? rawTracks.length > 1 && rawTracks.every((t) => t.trackNumber != null)
        ? orderTracks(rawTracks) // disc, then position — or the server's order when the numbers repeat
        : rawTracks
      : searchMode
        ? rawTracks
        : sortNodes(rawTracks);
    return { baseNodes, shown, containers, tracks };
  }, [
    nodes,
    searchMode,
    searchState,
    effFilter,
    librarySort,
    librarySortReversed,
    albumNode,
    searchKind,
    searchSort,
    searchSortReversed,
  ]);

  // the selection and the drag to the nav (after the listing: the selection
  // reads the visible tracks directly since step two of the lenses round)
  const {
    selTracks,
    setSelTracks,
    playlistMulti,
    setPlaylistMulti,
    trackRowClick,
    selectedNodes,
    queueNodes,
    queueSelected,
    navDrag,
    startAlbumDrag,
    startTrackDrag,
  } = useLibrarySelection({
    serverUdn,
    path,
    lens,
    searchMode,
    atRoot,
    state,
    tracks,
    nodeUdn,
    showToast,
    showNotice,
    queueFailed: QUEUE_FAILED,
    setPlaylistPicker,
    late: selectionLate,
  });
  const server = servers?.find((s) => s.udn === serverUdn) ?? null;
  // Sort/layout affordances key off the UNFILTERED level: filtering down to
  // one match must not unmount them (the header controls would jump around).
  const { rawContainerCount, rawTrackCount } = useMemo(
    () => ({
      rawContainerCount: nodes.filter((n) => n.isContainer).length,
      rawTrackCount: nodes.filter((n) => !n.isContainer).length,
    }),
    [nodes],
  );

  // Cross-server results, per-server groups: the kind filter and sort apply
  // WITHIN each group (the grouping is the point — provenance at a glance).
  const crossGroups = useMemo(() => {
    if (!crossState) return [];
    return crossState.groups
      .filter((g) => !crossServerUdn || g.udn === crossServerUdn)
      .map((g) => {
        const items = sortSearch(
          searchKind === "all" ? g.items : g.items.filter((n) => matchesKind(n, searchKind)),
          searchSort,
          searchSortReversed,
        );
        return {
          udn: g.udn,
          serverName: g.serverName,
          total: g.total,
          albums: items.filter((n) => n.isContainer && isAlbumClass(n.upnpClass)),
          artists: items.filter((n) => n.isContainer && n.upnpClass.includes("musicArtist")),
          folders: items.filter(
            (n) =>
              n.isContainer && !isAlbumClass(n.upnpClass) && !n.upnpClass.includes("musicArtist"),
          ),
          tracks: items.filter((n) => !n.isContainer),
        };
      })
      .filter((g) => g.albums.length + g.artists.length + g.folders.length + g.tracks.length > 0);
  }, [crossState, crossServerUdn, searchKind, searchSort, searchSortReversed]);
  // ONE WINDOWED LIST OF EVERY RESULT (2026-10-11, user: "one big (windowed) list seems more
  // user friendly", after the 500-at-a-time button sat at the end of the first library's group,
  // mid-list): the results flatten into lines (a library's heading, a kind's label, a row of
  // cards, a container row, a track row), and only the lines near the viewport are drawn, the
  // Albums grid's rule. Each line carries its own spacing inside it (padding, a border on every
  // row, transparent on a section's first), so a kind of line has one height to measure.
  const [searchWidth, setSearchWidth] = useState(0);
  const searchRo = useRef<ResizeObserver | null>(null);
  const searchBodyRef = useCallback((el: HTMLDivElement | null) => {
    searchRo.current?.disconnect();
    searchRo.current = null;
    if (!el) return;
    setSearchWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setSearchWidth(e.contentRect.width));
    ro.observe(el);
    searchRo.current = ro;
  }, []);
  const searchCols = Math.max(
    1,
    Math.floor((searchWidth + presetGap) / (presetCardSize + presetGap)),
  );
  const searchLines = useMemo((): SearchLine[] => {
    const lines: SearchLine[] = [];
    const section = (key: string, text: string, list: MediaNode[], containers: boolean): void => {
      if (list.length === 0) return;
      // across libraries a kind's label sits tight under its library's heading
      const label = crossMode ? "klabel" : lines.length === 0 ? "label0" : "label";
      lines.push({ kind: label, key: `${key}-l`, text });
      if (containers && cards) {
        for (let i = 0; i < list.length; i += searchCols)
          lines.push({
            kind: i === 0 ? "cards0" : "cards",
            key: `${key}-c${i}`,
            nodes: list.slice(i, i + searchCols),
          });
      } else
        list.forEach((node, index) =>
          lines.push({
            kind: containers ? "crow" : "track",
            key: `${key}-${node.id}`,
            node,
            list,
            index,
          }),
        );
    };
    const kinds = (key: string, items: MediaNode[], tracksOf: MediaNode[]): void => {
      section(
        `${key}a`,
        "Artists",
        items.filter((c) => c.isContainer && c.upnpClass.includes("musicArtist")),
        true,
      );
      section(
        `${key}b`,
        "Albums",
        items.filter((c) => c.isContainer && isAlbumClass(c.upnpClass)),
        true,
      );
      section(
        `${key}f`,
        "Folders",
        items.filter(
          (c) =>
            c.isContainer && !isAlbumClass(c.upnpClass) && !c.upnpClass.includes("musicArtist"),
        ),
        true,
      );
      section(`${key}t`, "Tracks", tracksOf, false);
    };
    if (crossMode && crossState)
      crossGroups.forEach((g) => {
        lines.push({ kind: lines.length === 0 ? "group0" : "group", key: `g-${g.udn}`, group: g });
        kinds(`g-${g.udn}-`, [...g.artists, ...g.albums, ...g.folders], g.tracks);
      });
    else if (searchMode && searchState) kinds("s-", containers, tracks);
    return lines;
  }, [
    crossMode,
    crossState,
    crossGroups,
    searchMode,
    searchState,
    containers,
    tracks,
    cards,
    searchCols,
  ]);
  const searchKinds = useMemo(() => searchLines.map((l) => l.kind), [searchLines]);
  const searchWin = useWindowedList({
    scrollRef,
    count: searchLines.length,
    itemSelector: "[data-search-line]",
    kinds: searchKinds,
    estimate: {
      group0: 36,
      group: 56,
      label0: 30,
      label: 42,
      klabel: 30,
      cards0: presetCardSize + 60,
      cards: presetCardSize + 52 + presetGap,
      crow: 57,
      track: 57,
    },
    overscan: 6,
    enabled: searchLines.length > 80,
  });

  const crossItemCount = crossState
    ? crossState.groups.reduce((acc, g) => acc + g.items.length, 0)
    : 0;
  const crossTotal = crossState ? crossState.groups.reduce((acc, g) => acc + g.total, 0) : 0;

  // the playing row and card, by content against the playing queue entry (usePlayingMatch)
  const { md, queueSourceActive, isCurrentTrack, isPlayingAlbum } = usePlayingMatch();

  const allTracks = useMemo(() => nodes.filter((n) => !n.isContainer), [nodes]);
  menusLate.current = { albumNode, setSiblings, openVolume, allTracks };
  // what the album's tracks say where the album is silent (lib/mediaFacts, the one rule the
  // album's Info reads too): an album opened from another screen arrives with only its title
  const albumSaid = useMemo(
    () => (albumNode ? albumFromTracks(albumNode, allTracks) : null),
    [albumNode, allTracks],
  );
  const albumArtServer = albumSaid?.artUrl ?? null;
  // the header's 160px tile (320 on retina) asks the first track's file when
  // the server's art is small (lib/bestArt)
  const firstTrack = allTracks[0];
  const albumArt = useBestArt(
    albumArtServer,
    firstTrack && nodeUdn(firstTrack)
      ? { serverUdn: nodeUdn(firstTrack) ?? "", objectId: firstTrack.id }
      : null,
    true,
    albumNode ? artKeyOf(albumNode) : undefined,
  );
  const albumArtist = albumSaid
    ? (albumSaid.artist ?? (allTracks.length > 0 ? "Various artists" : null))
    : null;
  const albumInQueue = allTracks.length > 0 && allTracks.every(trackQueued);
  // Format and size come from the tracks' <res> (Asset describes them; the
  // USB server doesn't, and then the facts simply don't mention them).
  const albumFmt = albumFormat(allTracks);
  // the catalog facts line has ONE home (lib/mediaFacts) — the album Info
  // modal reads the identical string; only the queue note is this screen's
  const albumPlay = playStats.album(allTracks);
  const albumLastPlayed = albumPlay.lastAt;
  // the catalog facts, then the listening record's whole-listen count; the
  // "last played" fact renders apart as a LINK into History's Timeline
  // (0.8.0 round 2b) and the queue note closes the line
  const albumFacts = albumNode
    ? [
        albumFactsLine(albumNode, allTracks),
        albumPlay.whole > 0
          ? `played whole ${albumPlay.whole === 1 ? "once" : albumPlay.whole === 2 ? "twice" : `${albumPlay.whole} times`}`
          : null,
      ]
        .filter(Boolean)
        .join(FACT_SEP)
    : "";
  const jumpToHistory = useStore((s) => s.jumpToHistory);
  // one composer credit for the whole album, when every track agrees (the
  // classical case, and a band that writes its own); silent otherwise
  const composers = albumNode ? albumComposers(allTracks) : [];
  const albumComposerLine = composers.length > 0 ? `Composed by ${composers.join(", ")}` : null;
  // EXPERIMENT (0.7 exploration): the album's recorded TT-DR, shown only
  // while the sweep's track count still matches the listing (a changed
  // album re-earns its number). Zero listed tracks = a box set's volume
  // view — the recorded count stands.
  const albumDrMap = useAlbumDr();
  const albumDrEntry = albumNode ? (albumDrMap[albumDrKey(albumNode)] ?? null) : null;
  const albumDrShown =
    albumDrEntry && (allTracks.length === 0 || albumDrEntry.tracks === allTracks.length)
      ? albumDrEntry.dr
      : null;
  // the album's integrated loudness (0.8.0) rides the same freshness rule
  const albumLufsShown = albumDrShown != null ? (albumDrEntry?.lufs ?? null) : null;
  const albumSweeping = albumNode != null && analysisProgress?.key === albumDrKey(albumNode);
  // the note a row carries when its format differs from the album headline
  const albumNoteFor = (node: MediaNode): string | null => {
    if (!albumNode) return null;
    const i = allTracks.indexOf(node);
    return i >= 0 ? albumFmt.notes[i] : null;
  };
  const shownServers = servers ?? []; // the source list is short — no filter there
  const loading = atRoot ? servers == null : state === "loading";

  // ---------------------------------------------------------------- favorites
  // The favorite payload and the hearts live in components/library/useLibraryFavorites
  // (lifted 2026-09-13, the fourth lift); the trail titles stay here, where the
  // synthetic crumb ids are known
  const pathTitles = path
    .filter(
      (c) =>
        c.id !== SEARCH_CRUMB_ID &&
        c.id !== LENS_CRUMB_ID &&
        c.id !== LENS_ARTIST_CRUMB_ID &&
        c.id !== ARTIST_PAGE_CRUMB_ID,
    )
    .map((c) => c.title);
  const { nodeFavorited, heartNode, heartNodes } = useLibraryFavorites({
    serverUdn,
    serverName: server?.name ?? null,
    searchMode,
    pathTitles,
    albumNode,
    albumArtist,
    albumArt,
  });

  // "Retrieving…" only appears when a browse actually takes a moment —
  // cached/fast responses swap in without a flash of loading copy.
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const t = setTimeout(() => setShowLoading(true), 250);
    return () => clearTimeout(t);
  }, [loading]);

  // Everything a lens needs, node-based — the stamps make the existing
  // handlers server-aware for free.
  const lensActions: LensActions = {
    openAlbum: openAlbumFromLens,
    playTrack,
    playContainer: (node, el) => void playContainer(node, el),
    openMenu,
    menuNodeId,
    heartNode,
    heartNodes,
    nodeFavorited,
    trackQueued,
    isCurrentTrack: (node) => queueSourceActive && isCurrentTrack(node),
    isPlayingAlbum: (node) => queueSourceActive && isPlayingAlbum(node),
    playingArtist: queueSourceActive ? (md?.artist ?? null) : null,
    queueTracks: (chosen, mode, onDone) => {
      void queueNodes(chosen, mode).then((ok) => {
        if (ok) onDone?.();
      });
    },
    addTracksToPlaylist: (chosen, at, onAdded) =>
      setPlaylistMulti({ nodes: chosen, x: at.x, y: at.y, clear: onAdded }),
    goToAlbum: goToAlbumFromLens,
    dragAlbum: startAlbumDrag,
    analyzeAlbums: (nodes) => void runAnalyzeAlbums(nodes),
    unreadable,
    goToArtist: goToArtistFromLens,
    saveAsPlaylist: (chosen, name) => void saveNodesAsPlaylist(chosen, name),
    analyzeTracks: (chosen, label) => void runAnalyzeTracks(chosen, label),
  };

  // ------------------------------------------------------------------ render

  // Search-result group headings: identical under-gap everywhere (mb-0.5 —
  // the lists below carry no extra top margin in search mode), identical
  // above-gap too (mt-2 for whichever group lands first, mt-5 after).
  selectionLate.current = { heartNode, heartNodes, nodeFavorited };
  /** One container as the listing draws it: a card, or a row in the rows layout. */
  const containerItem = (node: MediaNode): React.JSX.Element =>
    cards ? (
      <ContainerCard
        key={node.id}
        node={node}
        playing={queueSourceActive && isPlayingAlbum(node)}
        menuOpen={menuNodeId === node.id}
        favorited={isAlbumClass(node.upnpClass) ? nodeFavorited(node) : undefined}
        onHeart={isAlbumClass(node.upnpClass) ? () => heartNode(node) : undefined}
        onEnter={() => enter(node)}
        onPlay={(el) => void playContainer(node, el)}
        onMenu={(e) => openMenu(node, e)}
        onNavDrag={
          isAlbumClass(node.upnpClass) ? (e) => startAlbumDrag([node], e, node.title) : undefined
        }
      />
    ) : (
      <ContainerRow
        key={node.id}
        node={node}
        playing={queueSourceActive && isPlayingAlbum(node)}
        menuOpen={menuNodeId === node.id}
        favorited={isAlbumClass(node.upnpClass) ? nodeFavorited(node) : undefined}
        dr={isAlbumClass(node.upnpClass) ? (albumDrMap[albumDrKey(node)]?.dr ?? null) : null}
        onArtistLink={
          isAlbumClass(node.upnpClass) && node.artist ? () => goToArtistFromLens(node) : undefined
        }
        onHeart={isAlbumClass(node.upnpClass) ? () => heartNode(node) : undefined}
        onEnter={() => enter(node)}
        onMenu={(e) => openMenu(node, e)}
        onNavDrag={
          isAlbumClass(node.upnpClass) ? (e) => startAlbumDrag([node], e, node.title) : undefined
        }
      />
    );

  const containerGrid = (list: MediaNode[]): React.JSX.Element => (
    <div
      className={cx(!cards && "divide-y divide-edge/50 -mx-2")}
      style={
        cards
          ? {
              display: "grid",
              gridTemplateColumns: presetFillRows
                ? `repeat(auto-fill, minmax(${presetCardSize}px, 1fr))`
                : `repeat(auto-fill, ${presetCardSize}px)`,
              gap: presetGap,
              paddingTop: 8,
            }
          : undefined
      }
    >
      {list.map((node) => containerItem(node))}
    </div>
  );

  // AN ARTIST PAGE NAMES WHAT IT HOLDS (2026-10-11, user: "do we want to add an 'Albums' title
  // above the albums? i'm a little unclear exactly what this is supposed to be showing"): the
  // server's own folder for the artist holds what that server decides (Asset: the albums;
  // MinimServer: its sub-indexes, "2 albums", "Date", "Genre"), so the contents are labelled by
  // kind as search results are, never one fixed title that is wrong on some server
  const artistSections = ((): React.JSX.Element | null => {
    if (!artistNode) return null;
    const albums = containers.filter((c) => isAlbumClass(c.upnpClass));
    const other = containers.filter((c) => !isAlbumClass(c.upnpClass));
    return (
      <>
        {albums.length > 0 && (
          <>
            <div className="microlabel pb-0.5 px-1 pt-2">Albums</div>
            {containerGrid(albums)}
          </>
        )}
        {other.length > 0 && (
          <>
            <div className={cx("microlabel pb-0.5 px-1", albums.length > 0 ? "pt-5" : "pt-2")}>
              Folders
            </div>
            {containerGrid(other)}
          </>
        )}
      </>
    );
  })();

  if (servers != null && servers.length === 0) {
    return (
      <EmptyState
        className="h-full"
        icon={Library}
        title="No media libraries found"
        caption="UPnP servers on your network and USB storage attached to the streamer show up here."
      >
        <button
          onClick={loadServers}
          className="mt-1 flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-[12.5px] text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
        >
          <RotateCw size={13} /> Find libraries
        </button>
      </EmptyState>
    );
  }

  /** ONE wiring for a track row, the listing's and the cross-server groups' alike (they
   *  carried two copies of it, 2026-09-13): identity, the queue and selection state, the
   *  actions and the drag, the links by the index. The caller says what only it knows:
   *  the art, an album row's note and performer line, and whether the links are on (the
   *  listing's only in search mode, a cross-server row's always). */
  const trackRow = (
    node: MediaNode,
    siblings: MediaNode[],
    ti: number,
    opts: {
      showArt: boolean;
      note?: string | null;
      artistLabel?: string | null;
      links: boolean;
      /** The list Info steps through when it isn't `siblings` (an album's every disc). */
      infoList?: MediaNode[];
    },
  ): React.JSX.Element => (
    <TrackRow
      key={node.id}
      node={node}
      showArt={opts.showArt}
      isCurrent={queueSourceActive && isCurrentTrack(node)}
      queued={trackQueued(node)}
      menuOpen={menuNodeId === node.id}
      favorited={nodeFavorited(node)}
      onHeart={() => heartNode(node)}
      onPlayNow={(el) => playTrack(node, el)}
      selected={selTracks.has(node.id)}
      selStart={!(ti > 0 && selTracks.has(siblings[ti - 1].id))}
      selEnd={!(ti < siblings.length - 1 && selTracks.has(siblings[ti + 1].id))}
      onRowClick={(e) => trackRowClick(node, e)}
      onNavDrag={(e) => startTrackDrag(node, e)}
      onMenu={(e) => openMenu(node, e, opts.infoList ?? siblings)}
      note={opts.note}
      artistLabel={opts.artistLabel}
      onAlbumLink={
        opts.links && node.album && linkable(node, "albums")
          ? () => void goToAlbum(node)
          : undefined
      }
      onArtistLink={
        opts.links && node.artist && linkable(node, "artists") ? () => goToArtist(node) : undefined
      }
    />
  );

  /** One line of the windowed search results; its spacing lives inside it (see searchLines). */
  const searchLine = (line: SearchLine): React.JSX.Element => {
    const attrs = { "data-search-line": "", "data-win-kind": line.kind };
    if ("group" in line) {
      const src = servers?.find((x) => x.udn === line.group.udn);
      return (
        <div
          key={line.key}
          {...attrs}
          data-cross-server-group={line.group.serverName}
          className={cx("flex items-center gap-2 px-1", line.kind === "group0" ? "pt-2" : "pt-7")}
        >
          {src?.isStreamer ? (
            <Usb size={15} className="text-dim" />
          ) : (
            <HardDrive size={15} className="text-dim" />
          )}
          <span className="text-[13.5px] font-medium">{line.group.serverName}</span>
          <span className="font-mono text-[11px] text-faint tabular-nums">
            {line.group.total} result{line.group.total === 1 ? "" : "s"}
          </span>
        </div>
      );
    }
    if ("text" in line)
      return (
        <div
          key={line.key}
          {...attrs}
          className={cx("microlabel pb-0.5 px-1", line.kind === "label" ? "pt-5" : "pt-2")}
        >
          {line.text}
        </div>
      );
    if ("nodes" in line)
      return (
        <div
          key={line.key}
          {...attrs}
          style={{
            display: "grid",
            gridTemplateColumns: presetFillRows
              ? `repeat(${searchCols}, minmax(${presetCardSize}px, 1fr))`
              : `repeat(${searchCols}, ${presetCardSize}px)`,
            gap: presetGap,
            paddingTop: line.kind === "cards0" ? 8 : presetGap,
          }}
        >
          {line.nodes.map((node) => containerItem(node))}
        </div>
      );
    // a row: its divider is its own top border, transparent on a section's first
    return (
      <div
        key={line.key}
        {...attrs}
        className={cx("-mx-2 border-t", line.index === 0 ? "border-transparent" : "border-edge/50")}
      >
        {line.kind === "crow"
          ? containerItem(line.node)
          : trackRow(line.node, line.list, line.index, { showArt: true, links: true })}
      </div>
    );
  };

  return (
    <div
      className="relative h-full flex flex-col"
      onClick={(e) => {
        // blank-space click clears the selection (the Finder rule)
        if (selTracks.size === 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        const t = e.target as HTMLElement;
        // portaled dismiss clicks are their own gesture (the queue's rule)
        if (!e.currentTarget.contains(t)) return;
        if (t.closest("button, input, a, [data-library-track], [data-selection-bar]")) return;
        setSelTracks(new Set());
      }}
    >
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-2">
        {/* EXPERIMENT (0.7 exploration): the Analyze-audio sweep's pulse —
            the silent seconds between its toasts, made visible (the panel
            waveform's "Reading the file…" grammar). BASELINE-paired with the
            title (annotation text reads placed only on the title's own
            baseline), so no CSS truncation here — an overflow-hidden flex
            item forfeits its text baseline (the box bottom substitutes) —
            and the long-title ellipsis lives in the data instead. */}
        <div className="flex min-w-0 items-baseline gap-6">
          <ScreenTitle>Library</ScreenTitle>
          {analysisProgress && (
            <div
              data-analysis-progress
              className="whitespace-nowrap font-mono text-[11px] text-faint motion-safe:animate-pulse"
            >
              Analyzing “
              {analysisProgress.album.length > 40
                ? `${analysisProgress.album.slice(0, 39)}…`
                : analysisProgress.album}
              ”
              {analysisProgress.total > 0 &&
                `${FACT_SEP}${analysisProgress.done}/${analysisProgress.total}`}
              {analysisProgress.queued > 0 && `${FACT_SEP}+${analysisProgress.queued} queued`}
            </div>
          )}
        </div>
        <div className="flex-1" />
        <div className={`flex items-center ${GAP_BETWEEN}`}>
          {filterAvailable && (
            <FilterInput
              value={filter}
              onChange={(t) => setScreenFilter("library", t)}
              shown={shown.length}
              total={baseNodes.length}
            />
          )}
          {/* the root's cross-server search: every built index at once */}
          {!searchMode && atRoot && (crossAvailable || crossPending) && (
            <button
              data-library-search-all-button
              aria-disabled={!crossAvailable}
              // the shortcut in the tip: ⌘F is contextual (the library's own
              // search HERE, unified Search elsewhere) and nothing else says so
              data-tip={crossAvailable ? `${MOD}F` : "Building library indexes…"}
              onClick={() => crossAvailable && enterSearch()}
              className={cx(
                "no-drag tip-bottom tip-end flex items-center gap-2 px-3.5 h-8 rounded-lg text-[12.5px] font-medium transition-all",
                crossAvailable
                  ? "bg-gold text-bg shadow-[0_0_14px_rgb(var(--gold-rgb)_/_0.3)] hover:brightness-110 motion-safe:active:scale-95"
                  : "bg-veil2 text-faint cursor-default",
              )}
            >
              <Search size={14} strokeWidth={2.2} />
              Search libraries
            </button>
          )}
          {/* a ready index makes even a Browse-only server searchable */}
          {!searchMode && !atRoot && (server?.searchable || serverIndex?.state === "ready") && (
            <PrimaryButton
              data-library-search-button
              data-tip={`${MOD}F`}
              onClick={() => enterSearch()}
              className="no-drag tip-bottom tip-end flex items-center gap-2 px-3.5 h-8 text-[12.5px]"
            >
              <Search size={14} strokeWidth={2.2} />
              Search all of {server?.name ?? "this library"}
            </PrimaryButton>
          )}
          {/* sort and layout are one presentation pairing: one group */}
          <div className={`flex items-center ${GAP_WITHIN} empty:hidden`}>
            {!searchMode &&
              !atRoot &&
              (rawContainerCount > 1 || (!albumNode && rawTrackCount > 1)) && (
                <SortChip
                  sorts={SORTS}
                  neutral="server"
                  value={librarySort}
                  reversed={librarySortReversed}
                  onChange={(librarySort) => void saveSettings({ librarySort })}
                  onToggleReverse={() =>
                    void tt
                      .setSettings({ librarySortReversed: !librarySortReversed })
                      .then(setSettings)
                  }
                />
              )}
            {/* the rows⇄cards toggle governs CONTAINER lists only (tracks are
              always rows); hidden wherever it would sit dead — the root
              (sources always cards), album views, and pure-track folders.
              The ALBUMS LENS carries its own toggle beside its sort chip
              (2026-08-31 — sort and layout are one presentation pairing,
              and the lens keeps sort in its sub-row; the lens case had
              slipped through these conditions and quietly locked the lens
              to cards). */}
            {!atRoot &&
              !albumNode &&
              (searchMode ? containers.length > 0 : rawContainerCount > 0) && (
                <HeaderChip
                  data-tip={cards ? "Albums & folders as rows" : "Albums & folders as cards"}
                  aria-label={cards ? "Albums & folders as rows" : "Albums & folders as cards"}
                  onClick={() => void setLayout(cards ? "rows" : "cards")}
                  className="no-drag tip-bottom p-2 motion-safe:active:scale-90"
                >
                  {cards ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
                </HeaderChip>
              )}
          </div>
        </div>
      </header>

      {/* search mode's gold bar and the result controls (components/library/LibrarySearchBar,
          lifted 2026-09-13, the fifth lift's third part); leaving search is a navigation,
          so the spot being left is recorded here */}
      <LibrarySearchBar
        searchMode={searchMode}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        runSearch={runSearch}
        searchInputRef={searchInputRef}
        searching={searching}
        crossMode={crossMode}
        crossState={crossState}
        setCrossState={setCrossState}
        searchState={searchState}
        setSearchState={setSearchState}
        searchKind={searchKind}
        setSearchKind={setSearchKind}
        crossServerUdn={crossServerUdn}
        setSearchServerUdn={setSearchServerUdn}
        searchSort={searchSort}
        setSearchSort={setSearchSort}
        searchSortReversed={searchSortReversed}
        setSearchSortReversed={setSearchSortReversed}
        readyIndexes={readyIndexes}
        serverName={server?.name ?? null}
        crossTotal={crossTotal}
        crossItemCount={crossItemCount}
        atRoot={atRoot}
        leaveSearch={() => {
          navPush({ screen: "library", library: snapshot() });
          exitSearch();
        }}
      />
      {/* breadcrumbs: Library (source list) › source › folders… — hidden at
          the bare root, where the screen title already says it; the trail
          folds its middle when it would not fit (Crumbs) */}
      {!searchMode && (serverUdn != null || lens != null || path.length > 0) && (
        <div data-library-crumbs className="no-drag px-8 pb-3 text-[12.5px]">
          <Crumbs
            items={[
              {
                // Arriving from unified search, the trail LEADS with Search rather
                // than burying it mid-trail: you didn't come through the library root,
                // and the first crumb is the way back to where you did come from.
                key: "root",
                label: path[0]?.id === UNIFIED_SEARCH_CRUMB_ID ? "Search" : "Library",
                onClick: () => jumpTo(0),
                current: atRoot && !lens,
              },
              ...(atRoot && lens
                ? artistPage
                  ? [
                      // the artist page over the Artists lens: the lens crumb leads back to
                      // its columns, the artist still selected
                      { key: "lens", label: LENS_LABEL[lens], onClick: closeArtistPage },
                      { key: "artist-page", label: artistPage, current: true },
                    ]
                  : [{ key: "lens", label: LENS_LABEL[lens] }]
                : []),
              ...(server && path[0]?.id !== LENS_CRUMB_ID
                ? [
                    {
                      key: "server",
                      label: server.name,
                      onClick: () => jumpTo(1),
                      current: path.length === 0,
                    },
                  ]
                : []),
              ...path.flatMap((crumb, i) =>
                crumb.id === UNIFIED_SEARCH_CRUMB_ID
                  ? []
                  : [
                      {
                        key: `${crumb.id}-${i}`,
                        label: crumb.title,
                        onClick: () => jumpTo(i + 2),
                        current: i === path.length - 1,
                        search: crumb.id === SEARCH_CRUMB_ID,
                      },
                    ],
              ),
            ]}
          />
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(e) => {
          // Recorded as you scroll, not only when you navigate: leaving for
          // another screen UNMOUNTS this one, and the album you were halfway
          // down came back at the top (user, 2026-08-22).
          if (artistPage && atRoot && !searchMode) {
            artistPageScroll.set(artistPage.toLowerCase(), e.currentTarget.scrollTop);
            return;
          }
          if (searchMode || lens) return;
          const key = nodeKey(serverUdn, path);
          if (loadedKey.current === key) scrollMemory.set(key, e.currentTarget.scrollTop);
        }}
        className={cx(
          // stable gutter: without it the scrollbar's appearance shifts every
          // right-aligned control as listings shrink/grow (macOS always-on
          // scrollbars — the "filter box moves" report)
          "flex-1 px-8 pt-1 [scrollbar-gutter:stable]",
          // every lens scrolls its own column under its toolbar (the miller view's columns, the
          // tracks list, the albums grid since 2026-10-11) — the page must not; the artist page
          // is a page, and scrolls as one
          atRoot && lens != null && !searchMode && !artistPage
            ? "overflow-hidden min-h-0 pb-6"
            : // the floating bar overlaps the last rows at full scroll —
              // selection mode adds scroll-room so every row can clear it
              selTracks.size > 0
              ? "overflow-y-auto pb-28"
              : "overflow-y-auto pb-8",
        )}
      >
        {showLoading && (
          <div className="text-[13px] text-dim pt-4 motion-safe:animate-pulse">
            Retrieving library…
          </div>
        )}

        {/* root: sources, grouped like the official app (Servers / USB drives).
            Cards, not a list built for volume — same geometry and the same
            size/gap/fill settings as every other media card grid, so the
            card-size slider governs the landing too. */}
        {/* lenses: our views over the union of ready indexes */}
        {!loading &&
          atRoot &&
          !searchMode &&
          lens != null &&
          (lensPools == null ? (
            <div className="text-[13px] text-dim pt-4 motion-safe:animate-pulse">
              Reading the library index…
            </div>
          ) : lens === "albums" ? (
            <AlbumsLens
              pools={lensPools}
              actions={lensActions}
              cards={cards}
              cardSize={presetCardSize}
              cardGap={presetGap}
              fillRows={presetFillRows}
              onToggleLayout={() => void setLayout(cards ? "rows" : "cards")}
            />
          ) : lens === "artists" && artistPage ? (
            <ArtistPage
              name={artistPage}
              pools={lensPools}
              actions={lensActions}
              cards={cards}
              cardSize={presetCardSize}
              cardGap={presetGap}
              fillRows={presetFillRows}
              onOpenAlbum={(node, track) => openAlbumFromArtistPage(node, artistPage, track)}
            />
          ) : lens === "artists" ? (
            <ArtistsLens
              pools={lensPools}
              actions={lensActions}
              onOpenArtistPage={openArtistPage}
            />
          ) : (
            <TracksLens pools={lensPools} actions={lensActions} />
          ))}

        {/* root: the lens doors and the sources (components/library/LibraryRoot) */}
        {!loading && atRoot && !searchMode && lens == null && (
          <LibraryRoot
            servers={shownServers}
            filter={filter}
            openLens={openLens}
            enterServer={enterServer}
          />
        )}

        {!atRoot && state === "error" && (
          <div className="pt-4 space-y-3">
            <div className="text-[15px] text-faint">Couldn't browse this library.</div>
            <button
              onClick={() => setFetchNonce((n) => n + 1)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-[12.5px] text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
            >
              <RotateCw size={13} /> Retry
            </button>
          </div>
        )}
        {/* the album header and its box-set pills (components/library/AlbumHeader,
            lifted 2026-09-13, the fifth lift's second part) */}
        {!atRoot && state === "ready" && artistNode && (
          <ArtistHeader name={artistNode.title} serverArt={artistNode.artUrl} folders={nodes} />
        )}
        {!atRoot && state === "ready" && albumNode && (
          <AlbumHeader
            albumNode={albumNode}
            albumArt={albumArt}
            albumArtist={albumArtist}
            albumFacts={albumFacts}
            albumLastPlayed={albumLastPlayed}
            jumpToHistory={jumpToHistory}
            albumInQueue={albumInQueue}
            allTracks={allTracks}
            albumDrShown={albumDrShown}
            albumLufsShown={albumLufsShown}
            albumSweeping={albumSweeping}
            analysisProgress={analysisProgress}
            albumComposerLine={albumComposerLine}
            playContainer={playContainer}
            nodeFavorited={nodeFavorited}
            heartNode={heartNode}
            openMenu={openMenu}
            goToArtistFromLens={goToArtistFromLens}
            setSiblings={setSiblings}
            volumeMarker={volumeMarker}
            openVolume={openVolume}
          />
        )}

        {searchMode && !atRoot && !searchState && !searching && (
          <div className="text-[15px] text-faint pt-4 px-1">
            Search all the media on {server?.name ?? "this library"}.
          </div>
        )}
        {searchMode && !atRoot && searchState && !searching && shown.length === 0 && (
          <div className="text-[15px] text-faint pt-4 px-1">
            No results for “{searchState.query}”
          </div>
        )}
        {crossMode && !crossState && !searching && (
          <div className="text-[15px] text-faint pt-4 px-1">
            Search every built library index at once:{" "}
            {readyIndexes.map((x) => x.serverName).join(", ")}.
          </div>
        )}
        {crossMode && crossState && !searching && crossGroups.length === 0 && (
          <div className="text-[15px] text-faint pt-4 px-1">
            No results for “{crossState.query}”
          </div>
        )}
        {!searchMode && !atRoot && state === "ready" && shown.length === 0 && (
          <div className="text-[15px] text-faint pt-4 px-1">
            {effFilter ? `No matches for “${effFilter}”` : "Nothing here"}
          </div>
        )}

        {!atRoot &&
          state === "ready" &&
          containers.length > 0 &&
          !searchMode &&
          (artistNode ? artistSections : containerGrid(containers))}

        {/* every search result, one windowed list (searchLines): one library's search
            and the search across libraries alike */}
        {((!atRoot && state === "ready" && searchMode && searchState) ||
          (crossMode && crossState)) &&
          searchLines.length > 0 && (
            <div ref={searchBodyRef} data-search-list style={{ overflowAnchor: "none" }}>
              {searchWin.padTop > 0 && <div style={{ height: searchWin.padTop }} />}
              {searchLines.slice(searchWin.first, searchWin.last + 1).map(searchLine)}
              {searchWin.padBottom > 0 && <div style={{ height: searchWin.padBottom }} />}
            </div>
          )}

        {/* tracks are ALWAYS rows — the app-wide idiom (Queue, Recently,
            Favorites, album tracklists). The cards ⇄ rows toggle governs
            container lists only. */}
        {/* floats over the list (toast entrance, popover surface) — in flow
            it pushed the rows being picked; anchored to the screen root, so
            the scroller neither clips nor carries it (user, 2026-08-27) */}
        {!atRoot && state === "ready" && selTracks.size > 0 && (
          <SelectionBar
            count={selTracks.size}
            onClear={() => setSelTracks(new Set())}
            className="bottom-4 inset-x-8 z-30"
          >
            <SelectionVerb icon={<Play size={13} />} onClick={() => void queueSelected("now")}>
              Play now
            </SelectionVerb>
            <SelectionVerb
              icon={<ListStart size={13} />}
              onClick={() => void queueSelected("next")}
            >
              Play next
            </SelectionVerb>
            <SelectionVerb
              icon={<ListEnd size={13} />}
              onClick={() => void queueSelected("append")}
            >
              Add to end of queue
            </SelectionVerb>
            <SelectionVerb
              icon={<ListPlus size={13} />}
              onClick={(e) =>
                setPlaylistMulti({ nodes: selectedNodes(), x: e.clientX, y: e.clientY })
              }
            >
              Add to playlist…
            </SelectionVerb>
            {/* one verb with the album-header rule: adds what's missing, reads
                "Remove" only when every member is already a favorite */}
            {(() => {
              const nodes = selectedNodes();
              const allIn = nodes.length > 0 && nodes.every(nodeFavorited);
              return (
                <SelectionVerb
                  icon={<Heart size={13} fill={allIn ? "currentColor" : "none"} />}
                  onClick={() => heartNodes(nodes, allIn)}
                >
                  {allIn ? "Remove from favorites" : "Add to favorites"}
                </SelectionVerb>
              );
            })()}
          </SelectionBar>
        )}
        {/* an artist page's tracks are labelled, as its albums and folders are */}
        {!atRoot && state === "ready" && !searchMode && artistNode && tracks.length > 0 && (
          <div className={cx("microlabel pb-0.5 px-1", containers.length > 0 ? "pt-5" : "pt-2")}>
            Tracks
          </div>
        )}
        {!atRoot && state === "ready" && !searchMode && tracks.length > 0 ? (
          <div
            className={cx(
              "divide-y divide-edge/50 -mx-2",
              containers.length > 0 && !searchMode && !artistNode && "mt-4",
            )}
          >
            {/* an album leaf that spans discs gets the same quiet "Disc N"
                dividers as the lens (one group, no divider, otherwise) */}
            {(albumNode ? discGroups(tracks) : [{ disc: null, tracks }]).map((g, gi) => (
              <div key={g.disc ?? `d${gi}`}>
                {g.disc != null && (
                  <div className="microlabel px-2 pt-3 pb-1" data-disc-divider>
                    Disc {g.disc}
                  </div>
                )}
                <div className="divide-y divide-edge/50">
                  {g.tracks.map((node, ti) =>
                    trackRow(node, g.tracks, ti, {
                      // Info steps through the whole album, every disc
                      infoList: tracks,
                      showArt: !albumNode,
                      note: albumNoteFor(node),
                      artistLabel: albumNode
                        ? performerLine(node, albumArtist ?? albumNode.artist)
                        : null,
                      links: searchMode,
                    }),
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* the popovers over the listing: the menus, the playlist panels, the preset
          picker and the drag ghost (components/library/LibraryPopovers, lifted
          2026-09-13, the fifth lift) */}
      <LibraryPopovers
        menu={menu}
        setMenu={setMenu}
        selTracks={selTracks}
        setSelTracks={setSelTracks}
        queueSelected={queueSelected}
        playlistMulti={playlistMulti}
        setPlaylistMulti={setPlaylistMulti}
        selectedNodes={selectedNodes}
        nodeFavorited={nodeFavorited}
        heartNode={heartNode}
        heartNodes={heartNodes}
        volumeNavVerbs={volumeNavVerbs}
        analyzeVerbs={analyzeVerbs}
        linkable={linkable}
        goToAlbum={goToAlbum}
        goToArtist={goToArtist}
        tracksForInfo={tracksForInfo}
        discCountForInfo={discCountForInfo}
        presetPicker={presetPicker}
        setPresetPicker={setPresetPicker}
        savePreset={savePreset}
        lens={lens}
        searchMode={searchMode}
        goToAlbumFromLens={goToAlbumFromLens}
        goToArtistFromLens={goToArtistFromLens}
        artistPageOf={artistPageOf}
        playContainer={playContainer}
        playAlbumFrom={playAlbumFrom}
        act={act}
        lensPools={lensPools}
        server={server}
        setMediaInfo={setMediaInfo}
        nodeUdn={nodeUdn}
        playlistPicker={playlistPicker}
        setPlaylistPicker={setPlaylistPicker}
        serverUdn={serverUdn}
        servers={servers}
        ghost={navDrag.ghost}
      />
    </div>
  );
}

// ------------------------------------------------------------------ sort chip

const SORTS: Array<{ value: AppSettings["librarySort"]; label: string }> = [
  { value: "server", label: "Server order" },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "year", label: "Year (newest first)" },
];
