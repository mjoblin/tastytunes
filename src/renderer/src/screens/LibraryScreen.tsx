import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import { setCurrentLibrarySpot } from "@/lib/navSpot";
import type { LibrarySpot } from "@/store";
import {
  ArrowLeft,
  ChevronRight,
  Disc3,
  HardDrive,
  Heart,
  LayoutGrid,
  Library,
  MoreHorizontal,
  Play,
  RotateCw,
  Rows3,
  Search,
  Usb,
  Users,
  X,
} from "lucide-react";
import {
  presetVolumeKey,
  type AppSettings,
  type MediaNode,
  type MediaQueueAction,
  type MediaSearchAllGroup,
  type MediaServerInfo,
  type ScreenLayout,
  orderTracks,
  discGroups,
  albumFormat,
  fmtBytes,
  albumComposers,
  performerLine,
  albumTracksOf,
  artistSummary,
  nameSortKey,
} from "@shared/model";
import { favoriteKey, type Favorite, type FavoriteMedia } from "@shared/model";
import type { QueueListItem } from "@shared/smoip";
import { tt } from "@/api";
import { useStore } from "@/store";
import { activeSourceId, cx, fmtTime, matchesFilter } from "@/lib/format";
import {
  albumMatchesEntry,
  entryArtistMatches,
  playingQueueEntry,
  trackMatchesEntry,
} from "@/lib/playingEntry";
import { useIndexPools } from "@/hooks/useIndexPools";
import { MOD } from "@/lib/screens";
import { flashTarget, scrollToCentered } from "@/lib/scroll";
import { mediaKind, isAlbumClass, stripFurniture, isArtistClass } from "@/lib/media";
import { toggleFavorite } from "@/lib/favorites";
import { ArtImage } from "@/components/media/ArtImage";
import { Segmented } from "@/components/controls/Segmented";
import { FilterInput } from "@/components/controls/FilterInput";
import { ContainerCard, ContainerRow, TrackRow } from "@/components/library/LibraryCards";
import { SortChip } from "@/components/controls/SortChip";
import { AlbumsLens, ArtistsLens, type LensActions } from "@/components/library/LibraryLenses";
import { AddToPlaylistPanel, itemFromNode } from "@/components/overlays/AddToPlaylistPanel";
import { ItemMenu, PresetPicker } from "@/components/library/LibraryMenus";
import { EmptyState } from "@/components/chrome/EmptyState";
import { HeaderChip, PrimaryButton, ScreenTitle } from "@/components/chrome/Chrome";
import { useOneShotAsk } from "@/hooks/useOneShotAsk";
import { artUrlAt } from "@shared/artUrl";

// Crumbs keep the entered node so an album level can render its header
// (art, artist, year) without re-fetching metadata.
type Crumb = { id: string; title: string; node?: MediaNode };

// Returning to the Library RESTORES where the last visit left off
// (positionMemory below) — the T3 "always the front door" rule was reversed
// 2026-07-24 (user ask); the reset now lives behind re-invoking Library while
// already here, or the breadcrumb root. Per-folder scroll and filter memories
// apply while browsing within a visit.
const scrollMemory = new Map<string, number>();
// Per-LEVEL filter memory: each folder keeps its own filter for the session
// (the store's screenFilters.library always holds the current level's).
const filterMemory = new Map<string, string>();
// Find-recall memory: the session's last search — scope, query, controls,
// and a results snapshot for scopes that would cost a live round-trip to
// re-run (index-backed scopes re-execute instead: free and always fresh).
// ⌘F and the gold search buttons restore it with the query text selected,
// browser-find style. Session-only, like the memories above — never a
// setting. The nav's "Library" front door is unaffected.
let searchMemory: {
  udn: string | null; // null = the root cross-server search
  query: string;
  kind: SearchKind;
  sort: SearchSort;
  sortReversed: boolean;
  serverFilter: string | null;
  scoped: { query: string; items: MediaNode[]; total: number } | null;
} | null = null;

// Where the last visit left off — server, crumb trail, and which lens was open.
// The screen UNMOUNTS on every navigation away (App renders only the active
// screen), so component state can't survive the trip; this is the same
// module-scope, session-only shape as the memories above, and never a setting.
// Restored on arrival from another screen; deliberately NOT consulted when the
// front door is asked for explicitly (see the reset effect).
let positionMemory: {
  udn: string | null;
  path: Crumb[];
  lens: "albums" | "artists" | null;
} | null = null;

const nodeKey = (serverUdn: string | null, path: Crumb[]): string =>
  `${serverUdn ?? ""}|${path.map((c) => c.id).join("/")}`;

// Synthetic crumb planted when a search RESULT is entered: the trail reads
// Library › server › “query” › Artist, and the query crumb (or Backspace)
// restores the search with its results intact. It never reaches the browse
// layer — titlePaths strip it (a result's true folder path is unknown, so
// stale-id rewalks can't recover search-entered branches either way).
const SEARCH_CRUMB_ID = "__search-results__";

// Synthetic crumb planted when a LENS result is opened: the trail reads
// Library › server › Albums › <album>, and the lens crumb (or Backspace)
// restores the lens exactly as it was left. Same contract as the search
// crumb; titlePaths strip it the same way.
const LENS_CRUMB_ID = "__lens__";
/**
 * Planted when a UNIFIED SEARCH result opens here: the trail reads
 * Search › <server> › <album>, and that crumb — or Backspace, or ⌘← — returns
 * to the Search screen with its query intact (the screen remembers it).
 *
 * Same idiom as the two above, with one difference worth stating: this crumb
 * leads OFF this screen. Without it, arriving from search left you in a browse
 * tree you never navigated into, and back went to the source list — reported
 * as "⌘← takes me to the top of the library".
 */
const UNIFIED_SEARCH_CRUMB_ID = "__from-search__";
// Which lens the crumb leads back to (module scope — survives the scoped
// album detour, like the lens components' own selection memories).
let lensReturnTo: "albums" | "artists" | null = null;
// The Albums lens scrolls the page scroller — its spot is remembered apart
// from the source list's (they share the root path key otherwise).
let albumsLensScroll = 0;

type SearchKind = "all" | "albums" | "artists" | "tracks";
type SearchSort = "relevance" | "title" | "artist" | "year";

const matchesKind = (n: MediaNode, kind: SearchKind): boolean =>
  kind === "all" ? true : `${mediaKind(n.upnpClass, n.isContainer)}s` === kind;

// Shared result sort — single-server results and every cross-server group
// order the same way. 'relevance' keeps the index's artists→albums→tracks
// order (the hierarchy: artists make albums, albums contain tracks).
const sortSearch = (list: MediaNode[], sort: SearchSort, reversed: boolean): MediaNode[] => {
  let out = list;
  if (sort !== "relevance") {
    out = [...list].sort((a, b) => {
      if (sort === "artist")
        return (
          nameSortKey(a.artist ?? "￿").localeCompare(nameSortKey(b.artist ?? "￿")) ||
          a.title.localeCompare(b.title)
        );
      if (sort === "year")
        return (b.year ?? "").localeCompare(a.year ?? "") || a.title.localeCompare(b.title);
      return a.title.localeCompare(b.title);
    });
  }
  return reversed ? [...out].reverse() : out;
};

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
  // its own gold bar and input — visually distinct from folder filtering.
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<{
    query: string;
    items: MediaNode[];
    total: number;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  // Where to come back to when a search result was entered: the results
  // themselves plus the folder the search ran over. udn null + cross set =
  // the root cross-server search.
  const [searchReturn, setSearchReturn] = useState<{
    udn: string | null;
    query: string;
    items: MediaNode[];
    total: number;
    cross: MediaSearchAllGroup[] | null;
    prevPath: Crumb[];
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** Set by restoreSpot: a search-results spot coming back through Back/Forward keeps its bar blurred (history restores, intent prepares — see SearchScreen). */
  const restoredSearch = useRef(false);
  useEffect(() => {
    if (searchMode) {
      if (restoredSearch.current) {
        restoredSearch.current = false;
        return;
      }
      searchInputRef.current?.focus();
      // find idiom: a recalled query arrives selected, so typing replaces it
      searchInputRef.current?.select();
    }
  }, [searchMode]);
  // Result controls: kind filter (the Favorites Segmented idiom) + sort.
  // Both reset when search exits — a fresh search starts neutral.
  const [searchKind, setSearchKind] = useState<"all" | "albums" | "artists" | "tracks">("all");
  const [searchSort, setSearchSort] = useState<"relevance" | "title" | "artist" | "year">(
    "relevance",
  );
  const [searchSortReversed, setSearchSortReversed] = useState(false);
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
  const [lens, setLens] = useState<"albums" | "artists" | null>(null);
  // the pools snapshot (cached on the ready indexes' signature) — fetched
  // when a lens opens, shared with the queue rows via useIndexPools
  const lensPools = useIndexPools(lens != null);
  useEffect(() => {
    if (lens !== "albums" || lensPools == null) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: albumsLensScroll }));
  }, [lens, lensPools]);

  const [crossState, setCrossState] = useState<{
    query: string;
    groups: MediaSearchAllGroup[];
  } | null>(null);
  const crossMode = searchMode && atRoot;
  // Which server's slice to show (null = all) — the same transient-narrowing
  // semantics as the kind filter beside it: dies when search exits, and a
  // selection whose server has no results for the new query falls back to
  // all rather than presenting an empty screen.
  const [searchServerUdn, setSearchServerUdn] = useState<string | null>(null);
  const crossServerUdn =
    searchServerUdn && crossState?.groups.some((g) => g.udn === searchServerUdn)
      ? searchServerUdn
      : null;

  // Keep the find-recall memory current while searching (a module var write
  // per state change — the screen unmounts on any nav, so continuous saving
  // is what makes recall survive a trip to another screen).
  useEffect(() => {
    if (!searchMode || !searchQuery.trim()) return;
    searchMemory = {
      udn: atRoot ? null : serverUdn,
      query: searchQuery,
      kind: searchKind,
      sort: searchSort,
      sortReversed: searchSortReversed,
      serverFilter: searchServerUdn,
      scoped: !atRoot ? searchState : null,
    };
  }, [
    searchMode,
    searchQuery,
    searchKind,
    searchSort,
    searchSortReversed,
    searchServerUdn,
    searchState,
    atRoot,
    serverUdn,
  ]);

  /**
   * Restore the remembered search into the CURRENT scope (call after the
   * scope is set). Returns false when the memory belongs elsewhere or is
   * empty — the caller's fresh-search behavior then stands. Index-backed
   * scopes re-execute (instant + fresh); live-only scopes restore the
   * snapshot rather than re-firing SOAP at the server.
   */
  const restoreSearchMemory = (scope: string | null): boolean => {
    const mem = searchMemory;
    if (!mem || mem.udn !== scope || !mem.query.trim()) return false;
    setSearchQuery(mem.query);
    setSearchKind(mem.kind);
    setSearchSort(mem.sort);
    setSearchSortReversed(mem.sortReversed);
    if (scope === null) {
      setSearchServerUdn(mem.serverFilter);
      void tt
        .mediaSearchAll(mem.query)
        .then((groups) => setCrossState({ query: mem.query, groups }))
        .catch(() => {});
    } else if (useStore.getState().mediaIndex.some((x) => x.udn === scope && x.state === "ready")) {
      void tt
        .mediaSearch(scope, mem.query)
        .then((res) => setSearchState({ query: mem.query, ...res }))
        .catch(() => {});
    } else if (mem.scoped) {
      setSearchState(mem.scoped);
    }
    // the [searchMode] focus effect misses re-entry from within search mode
    // (true → true across the commit) — select the recalled text explicitly
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return true;
  };

  // Action feedback: the app-wide toast for failures, a gold pulse for wins.
  // (The screen's original local notice banner graduated into the toast.)
  const showToast = useStore((s) => s.showToast);
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
          .filter((c) => c.id !== SEARCH_CRUMB_ID && c.id !== UNIFIED_SEARCH_CRUMB_ID)
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

  const exitSearch = (): void => {
    setSearchMode(false);
    setSearchState(null);
    setCrossState(null);
    setSearchServerUdn(null);
    setSearchQuery("");
    setSearchKind("all");
    setSearchSort("relevance");
    setSearchSortReversed(false);
    document.documentElement.classList.remove("filter-focused");
  };

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

  const openLens = (which: "albums" | "artists"): void => {
    if (!restoring.current) navPush({ screen: "library", library: snapshot() });
    lensReturnTo = which;
    setLens(which);
  };

  /** A lens result opens the SHARED native album leaf, scoped to its server;
   *  the lens crumb offers the way back with the lens state intact. */
  const openAlbumFromLens = (node: MediaNode): void => {
    if (!node.serverUdn || !lens) return;
    lensReturnTo = lens;
    moveTo(node.serverUdn, [
      { id: LENS_CRUMB_ID, title: lens === "albums" ? "Albums" : "Artists" },
      { id: node.id, title: node.title, node },
    ]);
  };

  const returnToLens = (): void => {
    moveTo(null, []);
    setLens(lensReturnTo);
  };

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
        const last = target.titlePath.length - 1;
        moveTo(
          target.serverUdn,
          target.titlePath.map((title, i) =>
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
        );
        if (target.fromSearch) {
          setPath((p) => [{ id: UNIFIED_SEARCH_CRUMB_ID, title: "Search" }, ...p]);
        }
        pendingTrack.current = target.track ?? null;
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

  // Palette/global "search the library" ask, carrying its own id (it no longer
  // rides the reset nonce — ⌘F must not reset the browse tree underneath the
  // search, so it doesn't bump it, which left the nonce unable to tell two
  // consecutive ⌘F presses apart).
  //
  // Claimed at most once per id — so exiting search manually isn't fought by a
  // re-running effect — and CLEARED once claimed, which is what stops a stale
  // ask re-firing on a later mount. `ready` parks the ask until the server
  // listing lands rather than consuming it into nothing; see useOneShotAsk.
  const librarySearchTarget = useStore((s) => s.librarySearchTarget);
  const clearLibrarySearchTarget = useStore((s) => s.clearLibrarySearchTarget);
  useOneShotAsk(
    librarySearchTarget,
    (ask) => {
      if (!servers) return;
      // A SEEDED ask (the Search→Library handoff: "See all N in the Library")
      // brings the unified query along and skips find-recall below — restoring
      // yesterday's search over an explicit ask would answer a question nobody
      // asked.
      const seeded = ask.query?.trim() || null;
      const ready = new Set(
        useStore
          .getState()
          .mediaIndex.filter((x) => x.state === "ready")
          .map((x) => x.udn),
      );
      const eligible = (x: MediaServerInfo): boolean => x.searchable || ready.has(x.udn);
      // Find-recall first: ⌘F brings back the session's last search wholesale
      // (scope included) when that scope is still eligible; an ineligible or
      // absent memory falls through to the fresh-search picks below.
      const mem = seeded == null ? searchMemory : null;
      if (mem?.query.trim()) {
        const memServer = mem.udn ? servers.find((x) => x.udn === mem.udn) : undefined;
        const memEligible =
          mem.udn === null ? ready.size >= 2 : memServer != null && eligible(memServer);
        if (memEligible) {
          moveTo(mem.udn, []);
          setSearchMode(true);
          restoreSearchMemory(mem.udn);
          return;
        }
      }
      // Two or more ready indexes → the root cross-server search: no arbitrary
      // server pick (the reason a default-search-server setting was rejected).
      // With one, the scoped flow below keeps its live fallback.
      if (ready.size >= 2) {
        moveTo(null, []);
        setSearchMode(true);
        if (seeded != null) setSearchQuery(seeded);
        return;
      }
      const current = servers.find((x) => x.udn === serverUdn);
      if (current && eligible(current)) {
        setSearchMode(true);
        if (seeded != null) setSearchQuery(seeded);
        return;
      }
      const target = servers.find(eligible);
      if (!target) return;
      moveTo(target.udn, []);
      setSearchMode(true);
      if (seeded != null) setSearchQuery(seeded);
    },
    {
      claim: librarySearchTarget?.id,
      clear: clearLibrarySearchTarget,
      ready: servers != null, // listing still loading; runs when it lands
    },
  );

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
  const returnToSearch = (): void => {
    if (!searchReturn) return;
    rememberScroll();
    filterMemory.set(nodeKey(serverUdn, path), filter);
    if (searchReturn.cross) {
      // the cross-server search lives at the root — leave the scoped server
      setScreenFilter("library", "");
      setServerUdn(null);
      setPath([]);
      setSearchMode(true);
      setSearchQuery(searchReturn.query);
      setCrossState({ query: searchReturn.query, groups: searchReturn.cross });
      return;
    }
    setScreenFilter("library", filterMemory.get(nodeKey(serverUdn, searchReturn.prevPath)) ?? "");
    setPath(searchReturn.prevPath);
    setSearchMode(true);
    setSearchQuery(searchReturn.query);
    setSearchState({
      query: searchReturn.query,
      items: searchReturn.items,
      total: searchReturn.total,
    });
  };

  // The result links are INDEX-powered: only offer them when the ready index
  // actually holds the target pool — a folder-only or artist-less server
  // simply never shows them (graceful degradation to plain sublines).
  // Per-NODE, so cross-server rows gate against their own server's index.
  const serverIndex = useStore((st) => st.mediaIndex.find((x) => x.udn === serverUdn));
  const linkable = (node: MediaNode, pool: "albums" | "artists"): boolean => {
    const idx = mediaIndexStatuses.find((x) => x.udn === nodeUdn(node));
    return idx?.state === "ready" && idx[pool] > 0;
  };

  /** Album-as-link: resolve a track's album by content identity against the
   *  (index-first) search and enter it — same crumb behavior as clicking an
   *  album result, so the search trail stays returnable. */
  const goToAlbum = async (track: MediaNode): Promise<void> => {
    const udn = nodeUdn(track);
    if (!udn || !track.album) return;
    const lc = (x: string | null): string => (x ?? "").trim().toLowerCase();
    try {
      const { items } = await tt.mediaSearch(udn, track.album);
      const albums = items.filter(
        (n) => isAlbumClass(n.upnpClass) && lc(n.title) === lc(track.album),
      );
      const album =
        albums.find(
          (n) => track.artist == null || n.artist == null || lc(n.artist) === lc(track.artist),
        ) ?? albums[0];
      if (!album) {
        showNotice(`Couldn't find "${track.album}" in this library.`);
        return;
      }
      // carry the track's server stamp so entering from a cross view scopes right
      enter(track.serverUdn ? { ...album, serverUdn: udn, serverName: track.serverName } : album);
    } catch {
      showNotice(`Couldn't find "${track.album}" in this library.`);
    }
  };

  /** Artist-as-link: same content-identity resolution, aimed at the artist
   *  entity. Failure degrades to a quiet toast, never a broken screen. */
  const goToArtist = async (track: MediaNode): Promise<void> => {
    const udn = nodeUdn(track);
    if (!udn || !track.artist) return;
    const lc = (x: string | null): string => (x ?? "").trim().toLowerCase();
    try {
      const { items } = await tt.mediaSearch(udn, track.artist);
      const artist = items.find(
        (n) =>
          n.isContainer &&
          (n.upnpClass.includes("person") || n.upnpClass.includes("Artist")) &&
          lc(n.title) === lc(track.artist),
      );
      if (!artist) {
        showNotice(`Couldn't find "${track.artist}" in this library.`);
        return;
      }
      enter(track.serverUdn ? { ...artist, serverUdn: udn, serverName: track.serverName } : artist);
    } catch {
      showNotice(`Couldn't find "${track.artist}" in this library.`);
    }
  };

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
    if (newPath[newPath.length - 1]?.id === LENS_CRUMB_ID) return returnToLens();
    moveTo(serverUdn, newPath);
  };
  const goUp = (): void => {
    if (searchMode)
      exitSearch(); // search exits first, folder stays
    else if (path.length > 0) {
      if (path[path.length - 2]?.id === UNIFIED_SEARCH_CRUMB_ID) return setScreen("search");
      if (path.length === 1 && path[0]?.id === UNIFIED_SEARCH_CRUMB_ID) return setScreen("search");
      if (path[path.length - 2]?.id === SEARCH_CRUMB_ID) return returnToSearch();
      if (path[path.length - 2]?.id === LENS_CRUMB_ID) return returnToLens();
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
        lensReturnTo = snap.lens;
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

  const runSearch = (): void => {
    const query = searchQuery.trim();
    if (!query) return;
    // hand the keyboard back to navigation (Backspace = exit search)
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (atRoot) {
      // cross-server: all ready indexes at once, answered in-memory
      setSearching(true);
      void tt
        .mediaSearchAll(query)
        .then((groups) => setCrossState({ query, groups }))
        .catch(() => showNotice("Search failed."))
        .finally(() => setSearching(false));
      return;
    }
    if (!serverUdn) return;
    setSearching(true);
    void tt
      .mediaSearch(serverUdn, query)
      .then((res) => setSearchState({ query, ...res }))
      .catch(() => showNotice("Search failed — the server didn't answer."))
      .finally(() => setSearching(false));
  };

  // As-you-type search: with a READY local index the lookup is instant and
  // free (no server round-trip), so results update live while typing. Enter
  // still runs the full search everywhere — including index-less servers,
  // where per-keystroke SOAP against the server would be rude.
  const indexReady = useStore((s) =>
    s.mediaIndex.some((x) => x.udn === serverUdn && x.state === "ready"),
  );
  useEffect(() => {
    if (!searchMode || !indexReady || !serverUdn) return;
    const query = searchQuery.trim();
    if (query.length === 0) {
      setSearchState(null);
      return;
    }
    if (query.length < 2 || searchState?.query === query) return;
    const t = setTimeout(() => {
      void tt
        .mediaSearch(serverUdn, query)
        .then((res) => {
          // only land results for what's still in the box (fast typing races)
          if (searchInputRef.current?.value.trim() === query) setSearchState({ query, ...res });
        })
        .catch(() => {});
    }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchMode, indexReady, serverUdn]);

  // Cross-server as-you-type: always index-backed (that's the whole design),
  // so live results while typing come for free.
  useEffect(() => {
    if (!searchMode || !atRoot) return;
    const query = searchQuery.trim();
    if (query.length === 0) {
      setCrossState(null);
      return;
    }
    if (query.length < 2 || crossState?.query === query) return;
    const t = setTimeout(() => {
      void tt
        .mediaSearchAll(query)
        .then((groups) => {
          // only land results for what's still in the box (fast typing races)
          if (searchInputRef.current?.value.trim() === query) setCrossState({ query, groups });
        })
        .catch(() => {});
    }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchMode, atRoot]);

  // ----------------------------------------------------------------- actions

  // Cross-server results carry their own server stamp; everything else
  // belongs to the screen's current server.
  const nodeUdn = (node: MediaNode): string | null => node.serverUdn ?? serverUdn;

  const act = async (
    node: MediaNode,
    action: MediaQueueAction,
    el: HTMLElement | null,
    playFromId?: string,
  ): Promise<void> => {
    const udn = nodeUdn(node);
    if (!udn) return;
    try {
      await tt.mediaQueueAdd(udn, node.id, action, playFromId);
      if (el) flashTarget(el);
    } catch {
      showNotice("Couldn't reach the streamer — nothing was queued.");
    }
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
      const playId = queue?.play_id ?? playState?.queue_id ?? null;
      const curIdx = items.findIndex((i) => i.id === playId);
      const target = matches.find((mi) => items.indexOf(mi) >= curIdx) ?? matches[0];
      void tt.command({ type: "playQueueId", queueId: target.id as number });
      if (el) flashTarget(el);
      return;
    }
    void act(node, "PLAY_NOW", el);
  };

  /** "Play" on a container: replace the queue with it and start at its first track. */
  const playContainer = async (node: MediaNode, el: HTMLElement | null): Promise<void> => {
    const udn = nodeUdn(node);
    if (!udn) return;
    try {
      const children = await tt.mediaBrowse(udn, node.id, [
        ...path.map((c) => c.title),
        node.title,
      ]);
      const firstTrack = children.find((c) => !c.isContainer);
      if (firstTrack) {
        await tt.mediaQueueAdd(udn, node.id, "PLAY_FROM_HERE", firstTrack.id);
      } else {
        await tt.mediaQueueAdd(udn, node.id, "REPLACE");
      }
      if (el) flashTarget(el);
    } catch {
      showNotice("Couldn't reach the streamer — nothing was queued.");
    }
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

  // ------------------------------------------------------------------ menus

  const [menu, setMenu] = useState<{ node: MediaNode; x: number; y: number } | null>(null);
  const setMediaInfo = useStore((s) => s.setMediaInfo);
  // The Info modal wants an album's tracks summed: the browsed album's own
  // listing when the node IS the open album; otherwise the lens's index
  // (same server, same title, album artist / performers, and — when twin
  // editions exist — the same art), i.e. exactly what the lens itself lists.
  const tracksForInfo = (node: MediaNode): MediaNode[] | undefined => {
    if (!node.isContainer) return undefined;
    if (albumNode && node.id === albumNode.id) return allTracks;
    if (!lensPools || !node.serverUdn) return undefined;
    const pool = lensPools.find((g) => g.udn === node.serverUdn);
    return pool ? albumTracksOf(node, pool) : undefined;
  };
  const [presetPicker, setPresetPicker] = useState<{
    node: MediaNode;
    x: number;
    y: number;
  } | null>(null);
  // The card/row a popover belongs to holds its hover treatment while open.
  const menuNodeId = menu?.node.id ?? presetPicker?.node.id ?? null;
  const openMenu = (node: MediaNode, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ node, x: e.clientX, y: e.clientY });
  };

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
  const playingEntry = playingQueueEntry(queue, playState)?.metadata ?? null;
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
  const albumArt = albumNode ? (albumNode.artUrl ?? allTracks[0]?.artUrl ?? null) : null;
  const albumArtist = albumNode
    ? (albumNode.artist ??
      (allTracks.length > 0 && allTracks.every((t) => t.artist === allTracks[0].artist)
        ? allTracks[0].artist
        : allTracks.length > 0
          ? "Various artists"
          : null))
    : null;
  const albumSecs = allTracks.reduce((acc, t) => acc + (t.durationSecs ?? 0), 0);
  const albumInQueue = allTracks.length > 0 && allTracks.every(trackQueued);
  // Format and size come from the tracks' <res> (Asset describes them; the
  // USB server doesn't, and then the facts simply don't mention them).
  const albumBytes = allTracks.reduce((acc, t) => acc + (t.format?.sizeBytes ?? 0), 0);
  const albumFmt = albumFormat(allTracks);
  const albumFacts = albumNode
    ? [
        albumNode.year ?? allTracks[0]?.year ?? null,
        allTracks.length > 0 ? `${allTracks.length} tracks` : null,
        albumSecs > 0 ? fmtTime(albumSecs) : null,
        albumBytes > 0 ? fmtBytes(albumBytes) : null,
        albumFmt.label,
        albumInQueue ? "in the queue" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  // one composer credit for the whole album, when every track agrees (the
  // classical case, and a band that writes its own); silent otherwise
  const composers = albumNode ? albumComposers(allTracks) : [];
  const albumComposerLine = composers.length > 0 ? `Composed by ${composers.join(", ")}` : null;
  // the note a row carries when its format differs from the album headline
  const albumNoteFor = (node: MediaNode): string | null => {
    if (!albumNode) return null;
    const i = allTracks.indexOf(node);
    return i >= 0 ? albumFmt.notes[i] : null;
  };
  const shownServers = servers ?? []; // the source list is short — no filter there
  const loading = atRoot ? servers == null : state === "loading";

  // ---------------------------------------------------------------- favorites
  const favorites = useStore((s) => s.favorites);
  const favKeys = useMemo(() => new Set(favorites.map(favoriteKey)), [favorites]);
  const pathTitles = path.filter((c) => c.id !== SEARCH_CRUMB_ID).map((c) => c.title);
  /**
   * A library node as a favorite payload. Content identity + resolution
   * hints: the entered album's titlePath is the current trail (it already
   * ends in the album); a listed node appends its own title. Search results
   * carry no trustworthy trail (their true folder is unknown) — null.
   */
  const mediaFav = (node: MediaNode): Omit<FavoriteMedia, "addedAt"> => ({
    kind: node.isContainer ? "album" : "track",
    title: node.title,
    artist: node === albumNode ? (albumArtist ?? node.artist) : node.artist,
    album: node.isContainer ? null : node.album,
    artUrl: node === albumNode ? (albumArt ?? node.artUrl) : node.artUrl,
    serverUdn: node.serverUdn ?? serverUdn,
    serverName: node.serverName ?? server?.name ?? null,
    objectId: node.id,
    titlePath: searchMode
      ? null
      : node === albumNode
        ? pathTitles
        : node.isContainer
          ? [...pathTitles, node.title]
          : pathTitles,
    durationSecs: node.isContainer ? null : node.durationSecs,
  });
  const nodeFavorited = (node: MediaNode): boolean =>
    favKeys.has(favoriteKey(mediaFav(node) as Favorite));
  const heartNode = (node: MediaNode): void => {
    void toggleFavorite(mediaFav(node));
  };

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
    nodeFavorited,
    trackQueued,
    isCurrentTrack: (node) => queueSourceActive && isCurrentTrack(node),
    isPlayingAlbum: (node) => queueSourceActive && isPlayingAlbum(node),
    playingArtist: queueSourceActive ? (md?.artist ?? null) : null,
  };

  // ------------------------------------------------------------------ render

  // Search-result group headings: identical under-gap everywhere (mb-0.5 —
  // the lists below carry no extra top margin in search mode), identical
  // above-gap too (mt-2 for whichever group lands first, mt-5 after).
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
          />
        ) : (
          <ContainerRow
            key={node.id}
            node={node}
            playing={queueSourceActive && isPlayingAlbum(node)}
            menuOpen={menuNodeId === node.id}
            favorited={isAlbumClass(node.upnpClass) ? nodeFavorited(node) : undefined}
            onHeart={isAlbumClass(node.upnpClass) ? () => heartNode(node) : undefined}
            onEnter={() => enter(node)}
            onMenu={(e) => openMenu(node, e)}
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

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-2">
        <ScreenTitle>Library</ScreenTitle>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
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
              onClick={() => crossAvailable && setSearchMode(true)}
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
              onClick={() => setSearchMode(true)}
              className="no-drag tip-bottom tip-end flex items-center gap-2 px-3.5 h-8 text-[12.5px]"
            >
              <Search size={14} strokeWidth={2.2} />
              Search all of {server?.name ?? "this library"}
            </PrimaryButton>
          )}
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
              (sources always cards), album views, and pure-track folders */}
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
      </header>

      {/* search mode: an unmistakable gold bar replaces the breadcrumbs */}
      {searchMode && (
        <div
          data-library-search-bar
          className="no-drag mx-8 mb-3 flex items-center gap-3 px-4 py-2 rounded-xl ring-1 ring-gold/40 bg-golddim"
        >
          <Search size={15} className="text-gold shrink-0" />
          <input
            ref={searchInputRef}
            data-filter-input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              // Just-landed state (⌘F recall selects the text): the history
              // keys NAVIGATE — pressing ⌘← to leave is the reflex this
              // serves. Once the selection collapses (typing, clicking),
              // ⌘-arrows are ordinary text-editing keys again.
              if (
                (e.metaKey || e.altKey) &&
                !e.ctrlKey &&
                (e.key === "ArrowLeft" || e.key === "ArrowRight")
              ) {
                const el = e.currentTarget;
                if (
                  el.selectionStart === 0 &&
                  el.selectionEnd === el.value.length &&
                  el.value.length > 0
                ) {
                  e.preventDefault();
                  if (e.key === "ArrowLeft") useStore.getState().goBack();
                  else useStore.getState().goForward();
                  return;
                }
              }
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch();
              }
              if (e.key === "Escape") {
                // releases focus, keeps the query AND the results view (the
                // app-wide rule, 2026-08-23); "Back to browsing" and ⌘← leave
                // search mode
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
            onFocus={() => document.documentElement.classList.add("filter-focused")}
            onBlur={() => document.documentElement.classList.remove("filter-focused")}
            placeholder={
              crossMode
                ? `Search ${readyIndexes.map((x) => x.serverName).join(", ")}…`
                : `Search all of ${server?.name ?? "this library"}…`
            }
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[13.5px] text-ink placeholder:text-gold/50"
          />
          {searching ? (
            <span className="shrink-0 text-[12px] text-gold/80 motion-safe:animate-pulse">
              searching…
            </span>
          ) : crossMode && crossState ? (
            <span className="shrink-0 font-mono text-[11px] text-gold/80 tabular-nums">
              {crossTotal} result{crossTotal === 1 ? "" : "s"}
              {crossTotal > crossItemCount && ` · first ${crossItemCount}`}
            </span>
          ) : searchState ? (
            <span className="shrink-0 font-mono text-[11px] text-gold/80 tabular-nums">
              {searchState.total} result{searchState.total === 1 ? "" : "s"}
              {searchState.total > searchState.items.length &&
                ` · first ${searchState.items.length}`}
            </span>
          ) : null}
          {/* right of the count: the count's width changes as results come in,
              so the x anchors against the stable exit button instead */}
          {searchQuery.length > 0 && (
            <button
              aria-label="Clear search"
              onClick={() => {
                setSearchQuery("");
                setSearchState(null);
                setCrossState(null);
                searchInputRef.current?.focus();
              }}
              className="shrink-0 p-1 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
            >
              <X size={13} />
            </button>
          )}
          <button
            data-library-search-exit
            onClick={() => {
              navPush({ screen: "library", library: snapshot() });
              exitSearch();
            }}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber text-bg text-[12.5px] font-medium motion-safe:active:scale-95 transition-all"
          >
            <ArrowLeft size={13} /> Back to browsing
          </button>
        </div>
      )}

      {/* search result controls: kind filter + sort, the shared header idioms.
          Kind options follow the hierarchy — artists make albums, albums
          contain tracks — and the sections below render in the same order. */}
      {searchMode && (atRoot ? crossState != null : searchState != null) && (
        <div data-library-search-controls className="no-drag mx-8 mb-3 flex items-center gap-3">
          <Segmented<"all" | "albums" | "artists" | "tracks">
            value={searchKind}
            onChange={setSearchKind}
            options={[
              { value: "all", label: "All" },
              { value: "artists", label: "Artists" },
              { value: "albums", label: "Albums" },
              { value: "tracks", label: "Tracks" },
            ]}
          />
          {/* which server's slice — a filter like its neighbor, so it lives
              in the left cluster; the sort chip keeps its lone right spot.
              Options come from the search's COVERAGE (every ready index),
              not from who matched: a server with no results stays visible
              but inert, so the control never vanishes mid-session and
              nobody wonders whether a server dropped off the network. */}
          {crossMode && crossState && readyIndexes.length > 1 && (
            <div data-library-server-filter>
              <Segmented<string>
                value={crossServerUdn ?? "__all__"}
                onChange={(v) => setSearchServerUdn(v === "__all__" ? null : v)}
                options={[
                  { value: "__all__", label: "All libraries" },
                  ...[...readyIndexes]
                    .sort((a, b) => a.serverName.localeCompare(b.serverName))
                    .map((x) => {
                      const hasMatches = crossState.groups.some((g) => g.udn === x.udn);
                      return {
                        value: x.udn,
                        label:
                          x.serverName.length > 18 ? `${x.serverName.slice(0, 17)}…` : x.serverName,
                        disabled: !hasMatches,
                        tip: hasMatches ? undefined : `No matches on ${x.serverName}`,
                      };
                    }),
                ]}
              />
            </div>
          )}
          <div className="flex-1" />
          <SortChip
            sorts={SEARCH_SORTS}
            neutral="relevance"
            value={searchSort}
            reversed={searchSortReversed}
            onChange={(v) => {
              setSearchSort(v);
              setSearchSortReversed(false);
            }}
            onToggleReverse={() => setSearchSortReversed((r) => !r)}
          />
        </div>
      )}

      {/* breadcrumbs: Library (source list) › source › folders… — hidden at
          the bare root, where the screen title already says it */}
      {!searchMode && (serverUdn != null || lens != null || path.length > 0) && (
        <div
          data-library-crumbs
          className="no-drag flex items-center gap-1 flex-wrap px-8 pb-3 text-[12.5px]"
        >
          {/* Arriving from unified search, the trail LEADS with Search rather
            than burying it mid-trail: you didn't come through the library root,
            and the first crumb is the way back to where you did come from. */}
          <button
            onClick={() => jumpTo(0)}
            className={cx(
              "px-1.5 py-0.5 rounded transition-colors",
              atRoot && !lens ? "text-ink" : "text-dim hover:text-ink hover:bg-veil",
            )}
          >
            {path[0]?.id === UNIFIED_SEARCH_CRUMB_ID ? "Search" : "Library"}
          </button>
          {atRoot && lens && (
            <span className="flex items-center gap-1">
              <ChevronRight size={12} className="text-faint" />
              <span className="px-1.5 py-0.5 text-ink">
                {lens === "albums" ? "Albums" : "Artists"}
              </span>
            </span>
          )}
          {server && (
            <span className="flex items-center gap-1">
              <ChevronRight size={12} className="text-faint" />
              <button
                onClick={() => jumpTo(1)}
                className={cx(
                  "px-1.5 py-0.5 rounded transition-colors",
                  path.length === 0 ? "text-ink" : "text-dim hover:text-ink hover:bg-veil",
                )}
              >
                {server.name}
              </button>
            </span>
          )}
          {path.map((crumb, i) =>
            crumb.id === UNIFIED_SEARCH_CRUMB_ID ? null : (
              <span key={`${crumb.id}-${i}`} className="flex items-center gap-1">
                <ChevronRight size={12} className="text-faint" />
                {crumb.id === SEARCH_CRUMB_ID ? (
                  // the way back to the results this branch was entered from —
                  // gold, matching the search bar's identity
                  <button
                    data-library-search-crumb
                    onClick={() => jumpTo(i + 2)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-gold/90 hover:text-gold hover:bg-golddim transition-colors"
                  >
                    <Search size={11} />
                    {crumb.title}
                  </button>
                ) : (
                  <button
                    onClick={() => jumpTo(i + 2)}
                    className={cx(
                      "px-1.5 py-0.5 rounded transition-colors",
                      i === path.length - 1 ? "text-ink" : "text-dim hover:text-ink hover:bg-veil",
                    )}
                  >
                    {crumb.title}
                  </button>
                )}
              </span>
            ),
          )}
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
          atRoot && lens === "artists" && !searchMode
            ? "overflow-hidden min-h-0 pb-6"
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
            />
          ) : (
            <ArtistsLens pools={lensPools} actions={lensActions} />
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
                  ].map((door) => (
                    <div
                      key={door.key}
                      data-library-lens={door.key}
                      aria-disabled={doorsState === "building" ? true : undefined}
                      data-tip={
                        buildingCount > 0 && doorsState !== "failed"
                          ? `Indexing ${buildingCount === 1 ? "a library" : `${buildingCount} libraries`}…${doorsState === "ready" ? " — what is already indexed is browsable now" : ""}`
                          : doorsState === "failed"
                            ? `Couldn't index: ${failedIndexes.map((x) => `${x.serverName} — ${x.failure ?? "no index"}`).join("; ")}. Click to retry.`
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
                        "group relative rounded-2xl p-2 pb-2.5 bg-raised/50 ring-1 ring-gold/25 transition-all duration-200 ease-out tip-bottom",
                        doorsState === "building"
                          ? "opacity-60 cursor-default"
                          : "card-hover-glow cursor-pointer hover:z-10 motion-safe:hover:scale-[1.04]",
                      )}
                    >
                      <div className="aspect-square w-full rounded-lg bg-golddim flex items-center justify-center">
                        <door.icon
                          size={40}
                          strokeWidth={1.1}
                          className={cx(
                            "text-gold/70 group-hover:text-gold transition-colors",
                            // pulses while ANYTHING is still building — including the
                            // mixed case where one index is ready (the streamer's USB
                            // storage lands in a moment) and the big one is not
                            buildingCount > 0 && "motion-safe:animate-pulse",
                          )}
                        />
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
                                ? `${door.count} ${door.noun} · indexing…`
                                : "Indexing…"
                              : door.count > 0
                                ? `${door.count} ${door.noun} · every library`
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
                    {group.map((s) => (
                      <div
                        key={s.udn}
                        data-library-source
                        onClick={() => enterServer(s.udn)}
                        data-tip={
                          s.isStreamer && inStandby
                            ? "In standby — USB content appears once the streamer wakes"
                            : undefined
                        }
                        className={cx(
                          "group relative rounded-2xl p-2 pb-2.5 bg-raised/50 ring-1 ring-edge card-hover-glow cursor-pointer transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]",
                          s.isStreamer && inStandby && "opacity-50 tip-bottom",
                        )}
                      >
                        {/* one frame per card: the well is a veil lift with no ring of its own (see LibraryCards) */}
                        <div className="aspect-square w-full rounded-lg bg-veil flex items-center justify-center">
                          {s.isStreamer ? (
                            <Usb
                              size={40}
                              strokeWidth={1.1}
                              className="text-dim group-hover:text-ink transition-colors"
                            />
                          ) : (
                            <HardDrive
                              size={40}
                              strokeWidth={1.1}
                              className="text-dim group-hover:text-ink transition-colors"
                            />
                          )}
                        </div>
                        <div className="pt-1.5 text-[12.5px] truncate">{s.name}</div>
                        <div className="text-[11.5px] text-faint truncate">
                          {s.model ?? (s.isStreamer ? "Storage on the streamer" : "Media server")}
                        </div>
                      </div>
                    ))}
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
        {!atRoot && state === "ready" && albumNode && (
          <div className="flex items-start gap-6 pb-6 pt-2" data-album-header>
            <div className="h-[160px] w-[160px] shrink-0 rounded-xl overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
              <ArtImage
                src={artUrlAt(albumArt, 160)}
                className="h-full w-full object-cover"
                fallback={<Disc3 size={48} strokeWidth={1} className="text-faint" />}
              />
            </div>
            <div className="min-w-0 pt-1 space-y-1.5">
              {/* title + artist are one thought — set tight; the facts keep
                  the block's own rhythm below them */}
              <div className="space-y-0.5">
                <div className="font-display font-bold text-[24px] tracking-tight leading-tight">
                  {albumNode.title}
                </div>
                {albumArtist && <div className="text-[14px] text-dim truncate">{albumArtist}</div>}
              </div>
              {/* facts + composers are one thought too, set tight (the
                  composer line is only there when every track agrees) */}
              <div className="space-y-0.5">
                {albumFacts && <div className="text-[12.5px] text-faint">{albumFacts}</div>}
                {albumComposerLine && (
                  <div className="text-[12.5px] text-faint" data-album-composers>
                    {albumComposerLine}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 pt-2">
                <button
                  data-tip="Replaces the queue"
                  // no queue-ack flash on the album screen: the whole-header
                  // pulse read as a glitch and even the art square was ruled
                  // extra (user, 2026-08-24) — the button's own press state and
                  // the playing row lighting up are feedback enough here
                  onClick={() => void playContainer(albumNode, null)}
                  className="tip-bottom flex items-center gap-2 px-4 py-2 rounded-full bg-amber text-bg text-[13px] font-medium motion-safe:active:scale-95 transition-all"
                >
                  <Play size={14} fill="currentColor" /> Play
                </button>
                <button
                  data-tip={nodeFavorited(albumNode) ? "Remove from favorites" : "Add to favorites"}
                  aria-label={
                    nodeFavorited(albumNode) ? "Remove from favorites" : "Add to favorites"
                  }
                  data-album-heart={nodeFavorited(albumNode) ? "on" : "off"}
                  onClick={() => heartNode(albumNode)}
                  className={cx(
                    "tip-bottom p-2 rounded-full ring-1 ring-edge bg-panel/70 transition-all motion-safe:active:scale-90",
                    nodeFavorited(albumNode)
                      ? "text-gold hover:text-ink"
                      : "text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70",
                  )}
                >
                  <Heart size={16} fill={nodeFavorited(albumNode) ? "currentColor" : "none"} />
                </button>
                <HeaderChip
                  aria-label="More actions"
                  onClick={(e) => openMenu(albumNode, e)}
                  shape="full"
                  className="p-2"
                >
                  <MoreHorizontal size={16} />
                </HeaderChip>
              </div>
            </div>
          </div>
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
            Search every built library index at once —{" "}
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
                  {g.tracks.map((node) => (
                    <TrackRow
                      key={node.id}
                      node={node}
                      showArt={!albumNode}
                      isCurrent={queueSourceActive && isCurrentTrack(node)}
                      queued={trackQueued(node)}
                      menuOpen={menuNodeId === node.id}
                      favorited={nodeFavorited(node)}
                      onHeart={() => heartNode(node)}
                      onPlayNow={(el) => playTrack(node, el)}
                      onMenu={(e) => openMenu(node, e)}
                      note={albumNoteFor(node)}
                      artistLabel={
                        albumNode ? performerLine(node, albumArtist ?? albumNode.artist) : null
                      }
                      onAlbumLink={
                        searchMode && node.album && linkable(node, "albums")
                          ? () => void goToAlbum(node)
                          : undefined
                      }
                      onArtistLink={
                        searchMode && node.artist && linkable(node, "artists")
                          ? () => void goToArtist(node)
                          : undefined
                      }
                    />
                  ))}
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
                      {g.tracks.map((node) => (
                        <TrackRow
                          key={node.id}
                          node={node}
                          showArt
                          isCurrent={queueSourceActive && isCurrentTrack(node)}
                          queued={trackQueued(node)}
                          menuOpen={menuNodeId === node.id}
                          favorited={nodeFavorited(node)}
                          onHeart={() => heartNode(node)}
                          onPlayNow={(el) => playTrack(node, el)}
                          onMenu={(e) => openMenu(node, e)}
                          onAlbumLink={
                            node.album && linkable(node, "albums")
                              ? () => void goToAlbum(node)
                              : undefined
                          }
                          onArtistLink={
                            node.artist && linkable(node, "artists")
                              ? () => void goToArtist(node)
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })}
      </div>

      {menu && (
        <ItemMenu
          menu={menu}
          onClose={() => setMenu(null)}
          goToAlbum={
            searchMode && !menu.node.isContainer && menu.node.album && linkable(menu.node, "albums")
              ? () => {
                  setMenu(null);
                  void goToAlbum(menu.node);
                }
              : undefined
          }
          goToArtist={
            searchMode &&
            !menu.node.isContainer &&
            menu.node.artist &&
            linkable(menu.node, "artists")
              ? () => {
                  setMenu(null);
                  void goToArtist(menu.node);
                }
              : undefined
          }
          onAction={(action, playFromId) => {
            setMenu(null);
            if (action === "PLAY") void playContainer(menu.node, null);
            else if (action === "PLAY_FROM_HERE" && menu.node.parentId != null)
              // needs the parent ALBUM's DIDL, starting from this track
              void act(
                { ...menu.node, id: menu.node.parentId },
                "PLAY_FROM_HERE",
                null,
                playFromId,
              );
            else void act(menu.node, action, null, playFromId);
          }}
          onSavePreset={() => {
            setPresetPicker({ node: menu.node, x: menu.x, y: menu.y });
            setMenu(null);
          }}
          onInfo={() => {
            setMenu(null);
            const n = menu.node;
            // an artist's page is summed by NAME from the index (albums,
            // credits) — the lens's merged rows and the server's person
            // entities alike; without a pool the modal shows what it has
            const pool =
              lensPools?.find((g) => g.udn === (n.serverUdn ?? server?.udn)) ?? lensPools?.[0];
            const artist =
              n.isContainer && isArtistClass(n.upnpClass) && pool
                ? artistSummary(n.title, pool)
                : undefined;
            setMediaInfo({
              node: artist && !n.artUrl && artist.artUrl ? { ...n, artUrl: artist.artUrl } : n,
              tracks: artist ? undefined : tracksForInfo(n),
              artist,
              serverName: n.serverName ?? server?.name ?? null,
              // what the index learned about this server (the modal's Indexed line + notes)
              ...(pool?.profile ? { serverProfile: pool.profile } : {}),
            });
          }}
          onAddToPlaylist={
            !menu.node.isContainer || isAlbumClass(menu.node.upnpClass)
              ? () => {
                  setPlaylistPicker({ node: menu.node, x: menu.x, y: menu.y });
                  setMenu(null);
                }
              : undefined
          }
          // Back-link for the builders' search pivot: a browse pivot returns
          // via the position restore, a pivot out of SEARCH MODE returns via
          // find-recall (its browse position is just the search's scope root).
          // Albums and tracks are heartable; plain folders and artists aren't.
          favorite={
            !menu.node.isContainer || isAlbumClass(menu.node.upnpClass)
              ? {
                  active: nodeFavorited(menu.node),
                  toggle: () => {
                    heartNode(menu.node);
                    setMenu(null);
                  },
                }
              : undefined
          }
        />
      )}
      {playlistPicker && (
        <AddToPlaylistPanel
          label={playlistPicker.node.title}
          at={{ x: playlistPicker.x, y: playlistPicker.y }}
          onClose={() => setPlaylistPicker(null)}
          resolve={async () => {
            const node = playlistPicker.node;
            const udn = node.serverUdn ?? serverUdn;
            const name = servers?.find((s) => s.udn === udn)?.name ?? null;
            if (!node.isContainer) return [itemFromNode(node, udn, name)];
            // An album expands to its TRACKS — a playlist stores tracks, not a
            // reference that would drift as the server's album changes.
            if (!udn) return [];
            const children = await tt.mediaBrowse(udn, node.id, []);
            return children.filter((c) => !c.isContainer).map((c) => itemFromNode(c, udn, name));
          }}
        />
      )}
      {presetPicker && (
        <PresetPicker
          picker={presetPicker}
          onClose={() => setPresetPicker(null)}
          onSave={(slot, name) => savePreset(presetPicker.node, slot, name)}
        />
      )}
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
const SEARCH_SORTS: Array<{
  value: "relevance" | "title" | "artist" | "year";
  label: string;
  noReverse?: boolean;
}> = [
  // reversing relevance is meaningless — "least relevant first" isn't a thing
  { value: "relevance", label: "Relevance", noReverse: true },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "year", label: "Year (newest first)" },
];
