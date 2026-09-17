import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import { artKeyOf } from "@/lib/artSrc";
import { setCurrentLibrarySpot } from "@/lib/navSpot";
import type { LibrarySpot } from "@/store";
import {
  Disc3,
  HardDrive,
  Heart,
  LayoutGrid,
  Library,
  ListEnd,
  Loader2,
  ListPlus,
  ListStart,
  Play,
  RotateCw,
  Rows3,
  Search,
  Usb,
  Users,
  Music2,
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
import { FACT_SEP, albumFactsLine } from "@/lib/mediaFacts";
import { usePlayStats } from "@/lib/playStats";
import { useBestArt } from "@/lib/bestArt";
import type { QueueListItem } from "@shared/smoip";
import { queueWrite, tt } from "@/api";
import { useStore } from "@/store";
import { activeSourceId, cx, matchesFilter, fmtCount } from "@/lib/format";
import {
  albumMatchesEntry,
  entryArtistMatches,
  playingQueueEntry,
  trackMatchesEntry,
} from "@/lib/playingEntry";
import { useIndexPools } from "@/hooks/useIndexPools";
import { MOD } from "@/lib/screens";
import { flashTarget, scrollToCentered } from "@/lib/scroll";
import { isAlbumClass, stripFurniture } from "@/lib/media";
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
import { AlbumHeader } from "@/components/library/AlbumHeader";
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
// Where the last visit left off — server, crumb trail, and which lens was open.
// The screen UNMOUNTS on every navigation away (App renders only the active
// screen), so component state can't survive the trip; this is the same
// module-scope, session-only shape as the memories above, and never a setting.
// Restored on arrival from another screen; deliberately NOT consulted when the
// front door is asked for explicitly (see the reset effect).
let positionMemory: {
  udn: string | null;
  path: Crumb[];
  lens: Lens | null;
} | null = null;

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
// The Albums lens scrolls the page scroller — its spot is remembered apart
// from the source list's (they share the root path key otherwise).
let albumsLensScroll = 0;

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
  // Standby honesty: USB source cards dim (the streamer's own ContentDirectory
  // has no content until wake — probed 2026-07-23); external servers and the
  // local index browse fine while the device sleeps.
  const inStandby = useStore((s) => s.systemPower != null && s.systemPower.power !== "ON");
  const setSettings = useStore((s) => s.setSettings);
  const saveSettings = useStore((s) => s.saveSettings);
  const filter = useStore((s) => s.screenFilters.library);
  const setScreenFilter = useStore((s) => s.setScreenFilter);
  const setScreen = useStore((s) => s.setScreen);
  const playState = useStore((s) => s.playState);
  const effectivePlayId = useStore((s) => s.effectivePlayId);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const zoneState = useStore((s) => s.zoneState);
  const queue = useStore((s) => s.queue);
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
      scrollRef.current.scrollTop = pendingScroll.current;
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

  // Cross-server search: every READY index at once, grouped by server. It
  // activates at TWO ready indexes — with one, the scoped per-server flow
  // already covers everything (and keeps its live fallback).
  const mediaIndexStatuses = useStore((s) => s.mediaIndex);
  const readyIndexes = useMemo(
    () => mediaIndexStatuses.filter((x) => x.state === "ready"),
    [mediaIndexStatuses],
  );
  const crossAvailable = readyIndexes.length >= 2;
  // The button used to POP IN when the second index finished building —
  // confusing (real-user report). While builds that will unlock cross
  // search are still running, show it disabled with a building tip instead.
  // aria-disabled (not the HTML attr) keeps the hover tip alive — the
  // cross-search server filter's precedent.
  const buildingCount = useMemo(
    () => mediaIndexStatuses.filter((x) => x.state === "building").length,
    [mediaIndexStatuses],
  );
  const crossPending =
    !crossAvailable && buildingCount > 0 && readyIndexes.length + buildingCount >= 2;

  // The lenses: OUR views over the union of ready indexes, offered as doors
  // at the root beside the sources (places, not modes). One ready index is
  // enough — for a Browse-only USB stick the lens is the first real library
  // UI it's ever had.
  const lensAvailable = readyIndexes.length >= 1;
  // The doors used to POP IN when the first index finished building — the
  // same complaint the cross-search button drew (see above), and every
  // schema bump replays it for everyone. So the block is on screen from the
  // moment anything is BUILDING (or has FAILED — a silent "not indexed" told
  // nobody anything): building doors are dimmed with a pulsing icon and say
  // so, failed ones offer Retry in place, and because the block holds its
  // space from the first paint nothing below it ever moves. Hidden only when
  // no index exists AND nothing is building or failed (a fresh browse-only
  // setup: the servers' own tiles are right below).
  const failedIndexes = useMemo(
    () => mediaIndexStatuses.filter((x) => x.state === "failed"),
    [mediaIndexStatuses],
  );
  const doorsState: "ready" | "building" | "failed" | "hidden" = lensAvailable
    ? "ready"
    : buildingCount > 0
      ? "building"
      : failedIndexes.length > 0
        ? "failed"
        : "hidden";
  const [lens, setLens] = useState<Lens | null>(null);

  // (⌘A/Esc keyboard handling lives below the listing memo — its deps need
  // the visible tracks.)
  // the pools snapshot (cached on the ready indexes' signature) — fetched
  // when a lens opens, shared with the queue rows via useIndexPools
  // pools also load while browsing a volume-suffixed album, so the header
  // can offer the set line without a lens ever having been opened
  const tailVol = albumVolume(path.at(-1)?.title ?? "");
  const lensPools = useIndexPools(lens != null || tailVol != null);
  useEffect(() => {
    if (lens !== "albums" || lensPools == null) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: albumsLensScroll }));
  }, [lens, lensPools]);

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
              c.id !== LENS_ARTIST_CRUMB_ID,
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
  });

  const moveTo = (udn: string | null, newPath: Crumb[]): void => {
    if (!restoring.current) navPush({ screen: "library", library: snapshot() });
    rememberScroll();
    exitSearch();
    setLens(null);
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
    goToAlbumFromLens,
    goToArtistFromLens,
  } = lensNavigation({
    lens,
    setLens,
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
          // a NAME from another screen's row: the Artists lens at the root,
          // focused and revealed on it (the Tracks lens's link, app-wide)
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
                    upnpClass: "object.container.album.musicAlbum",
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
      if (cameBack && positionMemory) {
        const mem = positionMemory;
        moveTo(mem.udn, mem.path);
        setLens(mem.lens); // moveTo clears it; the remembered lens wins
        return;
      }
      moveTo(null, []);
    } finally {
      restoring.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryResetNonce]);

  // Keep the memory current as you browse (a module var write, like the scroll
  // and find-recall memories — not state, nothing re-renders on it).
  // DECLARATION ORDER MATTERS: this must stay BELOW the arrival effect. On a
  // return-mount both run, in order — arrival reads the memory and queues the
  // restore, then this one overwrites it with the mount's initial (empty)
  // state; the restore's re-render writes the real values back a beat later.
  // Declared above the arrival effect, the clobber would come first and there
  // would be nothing left to restore.
  useEffect(() => {
    positionMemory = { udn: serverUdn, path, lens };
  }, [serverUdn, path, lens]);

  const enter = (node: MediaNode): void => {
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
      if (parent === LENS_CRUMB_ID || parent === LENS_ARTIST_CRUMB_ID) return returnToLens();
      moveTo(serverUdn, path.slice(0, -1));
    } else if (serverUdn) moveTo(null, []);
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
  // the store reads this when a navigation leaves the Library (lib/navSpot)
  useEffect(() => {
    setCurrentLibrarySpot(snapshot());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUdn, path, searchMode, searchQuery, searchState, crossState, lens]);
  useEffect(() => () => setCurrentLibrarySpot(null), []);

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

  // Title-keyed queue index: the content-match used to scan the whole queue
  // once per TRACK ROW per render (O(nodes × queue) under a 400-item grid);
  // one Map per queue push makes each lookup O(same-titled entries).
  const queueByTitle = useMemo(() => {
    const m = new Map<string, QueueListItem[]>();
    for (const i of queue?.items ?? []) {
      const t = i.metadata?.title;
      if (t == null || i.id == null) continue;
      const list = m.get(t);
      if (list) list.push(i);
      else m.set(t, [i]);
    }
    return m;
  }, [queue]);

  /**
   * Queue entries whose metadata content-matches a library track — the ONE
   * matcher (lib/playingEntry), so a compilation track whose entry carries
   * the album artist is found, not duplicated on click.
   */
  const queueMatches = (node: MediaNode): QueueListItem[] =>
    (queueByTitle.get(node.title) ?? []).filter((i) => trackMatchesEntry(node, i.metadata));
  const trackQueued = (node: MediaNode): boolean => queueMatches(node).length > 0;

  /**
   * Bare track click: if the track is already in the queue, JUMP to that
   * queue entry (first occurrence at-or-after the current position) instead
   * of inserting a duplicate — clicking an album you just queued navigates
   * it. Only genuinely un-queued tracks insert (PLAY_NOW). The ⋯ verbs stay
   * literal inserts.
   */
  const playTrack = (node: MediaNode, el: HTMLElement | null): void => {
    const items = queue?.items ?? [];
    const matches = queueMatches(node);
    if (matches.length > 0) {
      const curIdx = items.findIndex((i) => i.id === effectivePlayId);
      const target = matches.find((mi) => items.indexOf(mi) >= curIdx) ?? matches[0];
      void tt.command({ type: "playQueueId", queueId: target.id as number });
      if (el) flashTarget(el);
      return;
    }
    void act(node, "PLAY_NOW", el);
  };

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
  const crossItemCount = crossState
    ? crossState.groups.reduce((acc, g) => acc + g.items.length, 0)
    : 0;
  const crossTotal = crossState ? crossState.groups.reduce((acc, g) => acc + g.total, 0) : 0;

  // Playing-item highlight, queue-screen rules: library items carry no queue
  // ids, so match by content — against the PLAYING QUEUE ENTRY's metadata
  // (server-shaped, the same strings the library shows; see lib/playingEntry:
  // play_state.metadata is the streamer's FILE-TAG readout and disagrees with
  // the server on every album Asset renames), falling back to that readout
  // only while the queue isn't known. Only while the queue's source is audible.
  const md = playState?.metadata ?? null;
  const queueSourceActive = activeSourceId(zoneState, nowPlaying) === "MEDIA_PLAYER";
  const playingEntry = playingQueueEntry(queue, playState, effectivePlayId)?.metadata ?? null;
  const isCurrentTrack = (node: MediaNode): boolean =>
    playingEntry != null
      ? trackMatchesEntry(node, playingEntry)
      : md != null &&
        node.title === md.title &&
        (node.album == null || md.album == null || node.album === md.album) &&
        entryArtistMatches(md.artist, node) &&
        // Twin titles on one album (a reprise, a bonus cut) are real — duration
        // is the content identity left, so require agreement when both sides
        // know it (±2s: the device and UPnP round track lengths differently).
        (node.durationSecs == null ||
          md.duration == null ||
          Math.abs(node.durationSecs - md.duration) <= 2);
  const isPlayingAlbum = (node: MediaNode): boolean =>
    playingEntry != null
      ? albumMatchesEntry(node, playingEntry)
      : md != null && md.album === node.title && entryArtistMatches(md.artist, node);

  const allTracks = useMemo(() => nodes.filter((n) => !n.isContainer), [nodes]);
  menusLate.current = { albumNode, setSiblings, openVolume, allTracks };
  const albumArtServer = albumNode ? (albumNode.artUrl ?? allTracks[0]?.artUrl ?? null) : null;
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
  const albumArtist = albumNode
    ? (albumNode.artist ??
      (allTracks.length > 0 && allTracks.every((t) => t.artist === allTracks[0].artist)
        ? allTracks[0].artist
        : allTracks.length > 0
          ? "Various artists"
          : null))
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
      (c) => c.id !== SEARCH_CRUMB_ID && c.id !== LENS_CRUMB_ID && c.id !== LENS_ARTIST_CRUMB_ID,
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
  const groupLabelClass = (first: boolean): string =>
    cx("microlabel mb-0.5 px-1", first ? "mt-2" : "mt-5");

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
      {list.map((node) =>
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
              isAlbumClass(node.upnpClass)
                ? (e) => startAlbumDrag([node], e, node.title)
                : undefined
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
              isAlbumClass(node.upnpClass) && node.artist
                ? () => goToArtistFromLens(node)
                : undefined
            }
            onHeart={isAlbumClass(node.upnpClass) ? () => heartNode(node) : undefined}
            onEnter={() => enter(node)}
            onMenu={(e) => openMenu(node, e)}
            onNavDrag={
              isAlbumClass(node.upnpClass)
                ? (e) => startAlbumDrag([node], e, node.title)
                : undefined
            }
          />
        ),
      )}
    </div>
  );

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
    opts: { showArt: boolean; note?: string | null; artistLabel?: string | null; links: boolean },
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
      onMenu={(e) => openMenu(node, e)}
      note={opts.note}
      artistLabel={opts.artistLabel}
      onAlbumLink={
        opts.links && node.album && linkable(node, "albums")
          ? () => void goToAlbum(node)
          : undefined
      }
      onArtistLink={
        opts.links && node.artist && linkable(node, "artists")
          ? () => void goToArtist(node)
          : undefined
      }
    />
  );

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
                ` · ${analysisProgress.done}/${analysisProgress.total}`}
              {analysisProgress.queued > 0 && ` · +${analysisProgress.queued} queued`}
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
              ...(atRoot && lens ? [{ key: "lens", label: LENS_LABEL[lens] }] : []),
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
          if (atRoot && lens === "albums" && !searchMode) {
            albumsLensScroll = e.currentTarget.scrollTop;
            return;
          }
          // Recorded as you scroll, not only when you navigate: leaving for
          // another screen UNMOUNTS this one, and the album you were halfway
          // down came back at the top (user, 2026-08-22).
          if (searchMode || lens) return;
          const key = nodeKey(serverUdn, path);
          if (loadedKey.current === key) scrollMemory.set(key, e.currentTarget.scrollTop);
        }}
        className={cx(
          // stable gutter: without it the scrollbar's appearance shifts every
          // right-aligned control as listings shrink/grow (macOS always-on
          // scrollbars — the "filter box moves" report)
          "flex-1 px-8 pt-1 [scrollbar-gutter:stable]",
          // the miller view scrolls its own columns — the page must not
          atRoot && (lens === "artists" || lens === "tracks") && !searchMode
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
          ) : lens === "artists" ? (
            <ArtistsLens pools={lensPools} actions={lensActions} />
          ) : (
            <TracksLens pools={lensPools} actions={lensActions} />
          ))}

        {!loading && atRoot && !searchMode && lens == null && (
          <div className="space-y-7 pt-1">
            {shownServers.length === 0 && (
              <div className="text-[15px] text-faint pt-3 px-1">
                {filter ? `No matches for “${filter}”` : "Nothing here"}
              </div>
            )}
            {/* the lens doors LEAD the root: our views over EVERY built
                index at once — same card geometry as the sources, gold
                surface marking them as a different kind of door */}
            {doorsState !== "hidden" && (
              <div data-library-doors={doorsState}>
                <div className="microlabel mb-0.5 px-1">All libraries</div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: presetFillRows
                      ? `repeat(auto-fill, minmax(${presetCardSize}px, 1fr))`
                      : `repeat(auto-fill, ${presetCardSize}px)`,
                    gap: presetGap,
                    paddingTop: 8,
                  }}
                >
                  {[
                    {
                      key: "artists" as const,
                      title: "Artists",
                      icon: Users,
                      count: readyIndexes.reduce((acc, x) => acc + x.artists, 0),
                      noun: "artists",
                    },
                    {
                      key: "albums" as const,
                      title: "Albums",
                      icon: Disc3,
                      count: readyIndexes.reduce((acc, x) => acc + x.albums, 0),
                      noun: "albums",
                    },
                    {
                      key: "tracks" as const,
                      title: "Tracks",
                      icon: Music2,
                      count: readyIndexes.reduce((acc, x) => acc + x.tracks, 0),
                      noun: "tracks",
                    },
                  ].map((door) => (
                    <div
                      key={door.key}
                      data-library-lens={door.key}
                      aria-disabled={doorsState === "building" ? true : undefined}
                      data-tip={
                        buildingCount > 0 && doorsState !== "failed"
                          ? `Indexing ${buildingCount === 1 ? "a library" : `${buildingCount} libraries`}…${doorsState === "ready" ? " What is already indexed is browsable now." : ""}`
                          : doorsState === "failed"
                            ? `Couldn't index ${failedIndexes.map((x) => `${x.serverName} (${x.failure ?? "no index"})`).join(", ")}. Click to retry.`
                            : undefined
                      }
                      onClick={() => {
                        if (doorsState === "building") return;
                        if (doorsState === "failed") {
                          for (const x of failedIndexes) void tt.mediaIndexRebuild(x.udn);
                          return;
                        }
                        openLens(door.key);
                      }}
                      className={cx(
                        // tip-wide anchors the tooltip to the card's LEFT edge and wraps it:
                        // centered, the indexing tip poked past the scrollport's left
                        // edge and clipped (user, 2026-08-29)
                        "group relative rounded-2xl p-2 pb-2.5 bg-raised/50 ring-1 ring-gold/25 transition-all duration-200 ease-out tip-bottom tip-wide",
                        doorsState === "building"
                          ? "opacity-60 cursor-default"
                          : "card-hover-glow cursor-pointer hover:z-10 motion-safe:hover:scale-[1.04]",
                      )}
                    >
                      <div className="aspect-square w-full rounded-lg bg-golddim flex items-center justify-center">
                        {buildingCount > 0 && doorsState !== "failed" ? (
                          <>
                            {/* the boot screen's own loading glyph at the door icon's
                                size, while ANYTHING is still building — the icon's
                                pulse read as styling, not activity (user, 2026-08-29).
                                Reduced motion keeps the icon: a frozen spinner reads
                                as broken. */}
                            <Loader2
                              size={40}
                              strokeWidth={1.1}
                              className="spin text-gold/70 motion-reduce:hidden"
                            />
                            <door.icon
                              size={40}
                              strokeWidth={1.1}
                              className="hidden motion-reduce:block text-gold/70"
                            />
                          </>
                        ) : (
                          <door.icon
                            size={40}
                            strokeWidth={1.1}
                            className="text-gold/70 group-hover:text-gold transition-colors"
                          />
                        )}
                      </div>
                      <div className="pt-1.5 text-[12.5px] truncate">{door.title}</div>
                      {/* the count line fades in when the index lands (motion-safe, the modal's 140ms) — the door itself never moves */}
                      <div
                        key={doorsState === "ready" && buildingCount === 0 ? "ready" : "waiting"}
                        className={cx(
                          "text-[11.5px] truncate motion-safe:transition-opacity motion-safe:duration-[140ms]",
                          doorsState === "failed" ? "text-alert" : "text-faint",
                        )}
                      >
                        {doorsState === "building"
                          ? "Indexing…"
                          : doorsState === "failed"
                            ? "Couldn't index · Retry"
                            : buildingCount > 0
                              ? door.count > 0
                                ? `${fmtCount(door.count)} ${door.noun} · indexing…`
                                : "Indexing…"
                              : door.count > 0
                                ? `${fmtCount(door.count)} ${door.noun} · every library`
                                : "Across every library"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(["servers", "usb"] as const).map((kind) => {
              const group = shownServers.filter((s) => (kind === "usb") === s.isStreamer);
              if (group.length === 0) return null;
              return (
                <div key={kind}>
                  <div className="microlabel mb-0.5 px-1">
                    {kind === "usb" ? "USB drives" : "Servers"}
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: presetFillRows
                        ? `repeat(auto-fill, minmax(${presetCardSize}px, 1fr))`
                        : `repeat(auto-fill, ${presetCardSize}px)`,
                      gap: presetGap,
                      paddingTop: 8,
                    }}
                  >
                    {group.map((s) => {
                      // the card carries ITS server's index state (2026-09-14): the
                      // doors animate for any build, this says which one, and a
                      // stick's first index is a Build ask the Library never offered
                      const st = mediaIndexStatuses.find((x) => x.udn === s.udn) ?? null;
                      const state = st?.state ?? "none";
                      const building = state === "building";
                      const failed = state === "failed";
                      const unindexed = state === "none" && !s.searchable;
                      // the stick's contents changed and the app will not walk it unasked
                      const stale = st?.stale === true;
                      const Icon = s.isStreamer ? Usb : HardDrive;
                      return (
                        <div
                          key={s.udn}
                          data-library-source
                          data-library-source-state={state}
                          onClick={() => {
                            if (failed) {
                              void tt.mediaIndexRebuild(s.udn);
                              return;
                            }
                            enterServer(s.udn);
                          }}
                          data-tip={
                            s.isStreamer && inStandby
                              ? "In standby. USB content appears once the streamer wakes."
                              : failed
                                ? `Couldn't index (${st?.failure ?? "no index"}). Click to retry.`
                                : stale
                                  ? "The drive's contents changed since it was indexed."
                                  : undefined
                          }
                          className={cx(
                            "group relative rounded-2xl p-2 pb-2.5 bg-raised/50 ring-1 ring-edge card-hover-glow cursor-pointer transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]",
                            s.isStreamer && inStandby && "opacity-50 tip-bottom",
                            building && "opacity-60",
                            failed && "tip-bottom",
                          )}
                        >
                          {/* one frame per card: the well is a veil lift with no ring of its own (see LibraryCards) */}
                          <div className="aspect-square w-full rounded-lg bg-veil flex items-center justify-center">
                            {building ? (
                              <>
                                {/* the doors' loading glyph: a spinner reads as activity where a
                                    pulsing icon read as styling; reduced motion keeps the icon */}
                                <Loader2
                                  size={40}
                                  strokeWidth={1.1}
                                  className="spin text-dim motion-reduce:hidden"
                                />
                                <Icon
                                  size={40}
                                  strokeWidth={1.1}
                                  className="hidden motion-reduce:block text-dim"
                                />
                              </>
                            ) : (
                              <Icon
                                size={40}
                                strokeWidth={1.1}
                                className="text-dim group-hover:text-ink transition-colors"
                              />
                            )}
                          </div>
                          <div className="pt-1.5 text-[12.5px] truncate">{s.name}</div>
                          <div
                            data-library-source-caption
                            className={cx(
                              "text-[11.5px] truncate",
                              failed ? "text-alert" : "text-faint",
                            )}
                          >
                            {building ? (
                              <span className="motion-safe:animate-pulse">Indexing…</span>
                            ) : failed ? (
                              "Couldn't index · Retry"
                            ) : state === "ready" && st && stale ? (
                              <button
                                data-library-source-build
                                data-library-source-stale
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void tt.mediaIndexRebuild(s.udn);
                                }}
                                className="text-gold/90 hover:text-gold transition-colors"
                              >
                                Changed · Re-index
                              </button>
                            ) : state === "ready" && st ? (
                              `Indexed · ${fmtCount(st.albums)} ${st.albums === 1 ? "album" : "albums"}`
                            ) : unindexed ? (
                              <button
                                data-library-source-build
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void tt.mediaIndexRebuild(s.udn);
                                }}
                                className="text-gold/90 hover:text-gold transition-colors"
                              >
                                {s.isStreamer ? "Index this drive" : "Index this server"}
                              </button>
                            ) : (
                              (s.model ??
                              (s.isStreamer ? "Storage on the streamer" : "Media server"))
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
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
          containerGrid(containers)}

        {/* search results come grouped so artists / albums / tracks read
            at a glance (hierarchy order, matching the kind filter) */}
        {!atRoot && state === "ready" && searchMode && searchState && (
          <>
            {(() => {
              const albums = containers.filter((c) => isAlbumClass(c.upnpClass));
              const artists = containers.filter((c) => c.upnpClass.includes("musicArtist"));
              const other = containers.filter(
                (c) => !isAlbumClass(c.upnpClass) && !c.upnpClass.includes("musicArtist"),
              );
              return (
                <>
                  {artists.length > 0 && (
                    <>
                      <div className={groupLabelClass(true)}>Artists</div>
                      {containerGrid(artists)}
                    </>
                  )}
                  {albums.length > 0 && (
                    <>
                      <div className={groupLabelClass(artists.length === 0)}>Albums</div>
                      {containerGrid(albums)}
                    </>
                  )}
                  {other.length > 0 && (
                    <>
                      <div className={groupLabelClass(artists.length === 0 && albums.length === 0)}>
                        Folders
                      </div>
                      {containerGrid(other)}
                    </>
                  )}
                </>
              );
            })()}
          </>
        )}

        {searchMode && searchState && state === "ready" && tracks.length > 0 && (
          <div className={groupLabelClass(containers.length === 0)}>Tracks</div>
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
        {!atRoot && state === "ready" && tracks.length > 0 ? (
          <div
            className={cx(
              "divide-y divide-edge/50 -mx-2",
              containers.length > 0 && !searchMode && "mt-4",
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

        {/* cross-server results: grouped by SERVER first (provenance at a
            glance — the same album can live on two servers), then the usual
            kind clusters within each group. Entering any result scopes the
            screen to its server; the query crumb leads back here. */}
        {crossMode &&
          crossState &&
          crossGroups.map((g, gi) => {
            const src = servers?.find((s) => s.udn === g.udn);
            const kindLabel = (text: string): React.JSX.Element => (
              <div className="microlabel mb-0.5 mt-2 px-1">{text}</div>
            );
            return (
              <div key={g.udn} data-cross-server-group={g.serverName}>
                <div className={cx("flex items-center gap-2 px-1", gi === 0 ? "mt-2" : "mt-7")}>
                  {src?.isStreamer ? (
                    <Usb size={15} className="text-dim" />
                  ) : (
                    <HardDrive size={15} className="text-dim" />
                  )}
                  <span className="text-[13.5px] font-medium">{g.serverName}</span>
                  <span className="font-mono text-[11px] text-faint tabular-nums">
                    {g.total} result{g.total === 1 ? "" : "s"}
                  </span>
                </div>
                {g.artists.length > 0 && (
                  <>
                    {kindLabel("Artists")}
                    {containerGrid(g.artists)}
                  </>
                )}
                {g.albums.length > 0 && (
                  <>
                    {kindLabel("Albums")}
                    {containerGrid(g.albums)}
                  </>
                )}
                {g.folders.length > 0 && (
                  <>
                    {kindLabel("Folders")}
                    {containerGrid(g.folders)}
                  </>
                )}
                {g.tracks.length > 0 && (
                  <>
                    {kindLabel("Tracks")}
                    <div className="divide-y divide-edge/50 -mx-2">
                      {g.tracks.map((node, ti) =>
                        trackRow(node, g.tracks, ti, { showArt: true, links: true }),
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
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
        presetPicker={presetPicker}
        setPresetPicker={setPresetPicker}
        savePreset={savePreset}
        lens={lens}
        searchMode={searchMode}
        goToAlbumFromLens={goToAlbumFromLens}
        goToArtistFromLens={goToArtistFromLens}
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
