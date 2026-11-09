import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artKeyOf } from "@/lib/artSrc";
import { Heart, Library, ListEnd, ListPlus, ListStart, Play, RotateCw, Search } from "lucide-react";
import {
  type AppSettings,
  type MediaIndexPools,
  type MediaNode,
  type MediaServerInfo,
  orderTracks,
  albumFormat,
  albumComposers,
  nameSortKey,
  albumVolume,
  indexAlbumFor,
} from "@shared/model";
import { albumDrKey, artistSummary } from "@shared/model";
import { setInfoHere } from "@/lib/infoHotkey";
import { useAlbumDr } from "@/lib/audioAnalysis";
import { FACT_SEP, albumFactsLine, albumFromTracks } from "@/lib/mediaFacts";
import { usePlayStats } from "@/lib/playStats";
import { useBestArt } from "@/lib/bestArt";
import { tt } from "@/api";
import { useStore } from "@/store";
import { cx, matchesFilter } from "@/lib/format";
import { useIndexPools } from "@/hooks/useIndexPools";
import { ViewOptions } from "@/components/library/lenses/ViewOptions";
import { useLensIndex } from "@/components/library/lenses/useLensIndex";
import { useCardDetails } from "@/components/library/useCardDetails";
import { browseWalk } from "@/components/library/browseWalk";
import { MOD } from "@/lib/screens";
import { isAlbumClass, isArtistClass, stripFurniture } from "@/lib/media";
import { FilterInput } from "@/components/controls/FilterInput";
import { ContainerCard, ContainerRow, TrackRow } from "@/components/library/LibraryCards";
import { Crumbs } from "@/components/library/Crumbs";
import type { LandingTrack } from "@/components/library/landing";
import { SortChip } from "@/components/controls/SortChip";
import {
  AlbumsLens,
  ArtistsLens,
  TracksLens,
  type LensActions,
} from "@/components/library/LibraryLenses";
import {
  LENS_ARTIST_CRUMB_ID,
  ARTIST_PAGE_CRUMB_ID,
  LENS_CRUMB_ID,
  LENS_LABEL,
  type Lens,
} from "@/components/library/lensNavigation";
import { SelectionBar, SelectionVerb } from "@/components/controls/SelectionBar";
import { EmptyState } from "@/components/chrome/EmptyState";
import { PrimaryButton, ScreenTitle, GAP_BETWEEN, GAP_WITHIN } from "@/components/chrome/Chrome";
import { useLibraryMenus, type MenusLate } from "@/components/library/useLibraryMenus";
import { useLibraryFavorites } from "@/components/library/useLibraryFavorites";
import { LibraryPopovers } from "@/components/library/LibraryPopovers";
import { LibraryRoot } from "@/components/library/LibraryRoot";
import { EmptyCrate } from "@/components/library/DoorArt";
import { useIndexDoors } from "@/components/library/useIndexDoors";
import { usePlayingMatch } from "@/components/library/usePlayingMatch";
import { useQueueMatch } from "@/components/library/useQueueMatch";
import { AlbumCompactVerbs, AlbumCrumbArt, AlbumHeader } from "@/components/library/AlbumHeader";
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
import { menuAt } from "@/lib/menuAt";
import {
  SEARCH_CRUMB_ID,
  UNIFIED_SEARCH_CRUMB_ID,
  artistPageScroll,
  filterMemory,
  nodeKey,
  scrollMemory,
  standIns,
  type Crumb,
} from "@/components/library/libraryPlaces";
import { useLibraryNavigation } from "@/components/library/useLibraryNavigation";
import {
  LibraryFolders,
  LibraryTracks,
  type ContainerItem,
  type TrackRowOpts,
} from "@/components/library/LibraryListing";
import { LibrarySearchResults } from "@/components/library/LibrarySearchResults";
import { QUEUE_FAILED, useLibraryPlay, type PlayLate } from "@/components/library/useLibraryPlay";

const NO_POOLS: MediaIndexPools[] = [];

/**
 * Library: browse UPnP media (LAN servers and the streamer's own USB storage)
 * and act on it — a bare click is never destructive (track click = Play now,
 * container click = drill in); queue-replacing verbs live behind explicit
 * buttons and the ⋯ menu.
 */
/** An artist's page as a node for Info, from the index that knows them best (Info sums an
 *  artist's page from one index, as the Artists lens's row menu does). */

function artistPageNode(name: string, pools: MediaIndexPools[]): MediaNode {
  const best = pools
    .map((g) => ({ g, n: artistSummary(name, g).trackCount }))
    .sort((a, b) => b.n - a.n)[0].g;
  return {
    id: `artist-page:${name.toLowerCase()}`,
    parentId: null,
    title: name,
    upnpClass: "object.container.person.musicArtist",
    isContainer: true,
    artUrl: null,
    artist: null,
    album: null,
    year: null,
    trackNumber: null,
    durationSecs: null,
    serverUdn: best.udn,
    serverName: best.serverName,
  };
}

export function LibraryScreen(): React.JSX.Element {
  const {
    libraryLayout,
    lensTracksLayout,
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
  const cards = libraryLayout === "cards";
  const tracksCards = lensTracksLayout === "cards";

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
  // its own accent bar and input — visually distinct from folder filtering. Its
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
  const search = useLibrarySearch({
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
  const {
    searchMode,
    searchQuery,
    setSearchQuery,
    searchState,
    setSearchState,
    searching,
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
    exitSearch,
    enterSearch,
    runSearch,
  } = search;
  const [fetchNonce, setFetchNonce] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Which node the scroller currently shows, once its listing has landed —
  // scroll memory records only for that node, so a fresh mount (scroller at
  // 0, listing not yet fetched) can't clobber a remembered spot.
  const loadedKey = useRef<string | null>(null);
  const pendingScroll = useRef<number | null>(null);
  /** The track a destination asked to land on (LibraryTarget.track and its id and length). */
  const pendingTrack = useRef<LandingTrack | null>(null);
  const atRoot = serverUdn == null;

  // what the indexes offer: the doors' state, cross-server search (useIndexDoors)
  const { readyIndexes, crossAvailable, crossPending } = useIndexDoors();
  const [lens, setLens] = useState<Lens | null>(null);
  /** The artist page open over the Artists lens, by name (ArtistPage, 2026-10-11). */
  const [artistPage, setArtistPage] = useState<string | null>(null);

  // (⌘A/Esc keyboard handling lives below the listing memo — its deps need
  // the visible tracks.)
  // the pools snapshot (cached on the ready indexes' signature) — fetched
  // when a lens opens, shared with the queue rows via useIndexPools
  // pools also load while browsing a volume-suffixed album, so the header
  // can offer the set line without a lens ever having been opened
  const tailVol = albumVolume(path.at(-1)?.title ?? "");
  // and while an album that arrived from another screen stands in for the index's own entry
  const tailNode = path.at(-1)?.node;
  const arrived = tailNode != null && standIns.has(tailNode);
  const lensPools = useIndexPools(lens != null || tailVol != null || arrived);
  // a server's album cards take the format line too (0.14.0: every album card,
  // behind the same switch): the index's tracks give each its format, asked only while shown
  const formatLine = useStore((s) => s.settings.albumCardFormat);
  const folderPools = useIndexPools(formatLine && cards && lens == null);
  const folderIndex = useLensIndex(folderPools ?? NO_POOLS);
  const folderDetails = useCardDetails(folderPools ? folderIndex : null);

  // Action feedback: the app-wide toast for failures, an accent pulse for wins.
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
        // the folders a refused id is re-walked by: an opened album's own walked path, never the
        // app's crumbs (a lens's, an artist's, a search's), which no server has (browseWalk)
        browseWalk(
          path,
          (id) =>
            id === SEARCH_CRUMB_ID ||
            id === UNIFIED_SEARCH_CRUMB_ID ||
            id === LENS_CRUMB_ID ||
            id === LENS_ARTIST_CRUMB_ID ||
            id === ARTIST_PAGE_CRUMB_ID,
        ),
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

  // THE NAVIGATION (components/library/useLibraryNavigation, 0.15.0): every move, the arrivals,
  // the trail, Backspace and history's restores, and where a listing's scroll comes back to
  const {
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
  } = useLibraryNavigation({
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
    search,
    searchLate,
    readyIndexes,
    lensPools,
    showNotice,
  });
  /** Bring the search back exactly as it was left (no refetch). */
  const serverIndex = useStore((st) => st.mediaIndex.find((x) => x.udn === serverUdn));

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
    openInfoFor,
    volumeNavVerbs,
    analyzeVerbs,
    recentListVerbs,
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

  // THE PLAY VERBS (components/library/useLibraryPlay, 0.15.0): a queue write, Play on a
  // container, Play album from here, and Save as preset; the album shown, derived below, reaches
  // them late-bound through playLate
  const playLate = useRef<PlayLate>({ albumNode: null, albumArtist: null });
  const { act, playContainer, playAlbumFrom, savePreset } = useLibraryPlay({
    nodeUdn,
    path,
    nodes,
    lensPools,
    showNotice,
    setPresetPicker,
    late: playLate,
  });

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
  const crumbAlbum =
    !searchMode && lastCrumbNode && isAlbumClass(lastCrumbNode.upnpClass) ? lastCrumbNode : null;
  // an album that arrived from another screen is the index's own entry once the pools are in, so
  // its DR, sweep, art and favorite keys are the ones every other way in uses
  const albumNode = useMemo(() => {
    if (!crumbAlbum || !standIns.has(crumbAlbum) || !lensPools) return crumbAlbum;
    const pool = lensPools.find((g) => g.udn === (crumbAlbum.serverUdn ?? serverUdn));
    const found = pool ? indexAlbumFor(crumbAlbum, pool) : null;
    return found ? { ...found, serverUdn: found.serverUdn ?? pool?.udn } : crumbAlbum;
  }, [crumbAlbum, lensPools, serverUdn]);
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

  const crossItemCount = crossState
    ? crossState.groups.reduce((acc, g) => acc + g.items.length, 0)
    : 0;
  const crossTotal = crossState ? crossState.groups.reduce((acc, g) => acc + g.total, 0) : 0;

  // the playing row and card, by content against the playing queue entry (usePlayingMatch)
  const { md, queueSourceActive, isCurrentTrack, isPlayingAlbum } = usePlayingMatch();

  const allTracks = useMemo(() => nodes.filter((n) => !n.isContainer), [nodes]);
  const infoHereLate = useRef<(() => void) | null>(null);
  useEffect(
    () =>
      setInfoHere(() => {
        const open = infoHereLate.current;
        open?.();
        return open != null;
      }),
    [],
  );
  menusLate.current = { albumNode, setSiblings, openVolume, allTracks };
  // ⌘I here (lib/infoHotkey): the album shown, an artist's folder, an artist's page, opened as
  // their menus' Info… opens them (useLibraryMenus); late-bound, read when the key is pressed
  const shownSubject =
    !searchMode && !atRoot && state === "ready" ? (albumNode ?? artistNode) : null;
  const shownArtistPage =
    !searchMode && atRoot && lens === "artists" && artistPage && lensPools?.length
      ? artistPageNode(artistPage, lensPools)
      : null;
  const infoSubject = shownSubject ?? shownArtistPage;
  infoHereLate.current = infoSubject ? () => openInfoFor(infoSubject) : null;
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
  playLate.current = { albumNode, albumArtist };
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

  // THE COMPACT BAR (0.13.0 round 5, AlbumHeader's AlbumCompactVerbs): once the header's verbs have
  // gone above the scroller's top (under its faded strip, where they can no longer be read), the
  // trail takes the album's cover and its Play, heart and menu. Watched, not measured on scroll:
  // one observer per album page, rooted at the page's own scroller.
  const [verbsGone, setVerbsGone] = useState(false);
  const albumPageKey =
    !atRoot && state === "ready" && !searchMode && albumNode ? albumNode.id : null;
  useEffect(() => {
    setVerbsGone(false);
    const root = scrollRef.current;
    const verbs = root?.querySelector("[data-album-verbs]");
    if (albumPageKey == null || !root || !verbs) return;
    const io = new IntersectionObserver(
      ([e]) =>
        setVerbsGone(!e.isIntersecting && e.boundingClientRect.bottom <= (e.rootBounds?.top ?? 0)),
      { root, rootMargin: "-24px 0px 0px 0px" },
    );
    io.observe(verbs);
    return () => io.disconnect();
  }, [albumPageKey]);
  const compactBar = verbsGone && albumPageKey != null && albumNode != null;

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
  /** A server's folders, browsed: a plain folder takes a ⋯ (Use as Recently added, 0.13.0). */
  const folderMenus = serverUdn != null && !searchMode && lens == null;
  /** One container as the listing draws it: a card, or a row in the rows layout. */
  const containerItem: ContainerItem = (node, item) =>
    cards ? (
      <ContainerCard
        key={node.id}
        item={item}
        node={node}
        details={isAlbumClass(node.upnpClass) ? folderDetails?.(node) : undefined}
        playing={queueSourceActive && isPlayingAlbum(node)}
        menuOpen={menuNodeId === node.id}
        favorited={isAlbumClass(node.upnpClass) ? nodeFavorited(node) : undefined}
        onHeart={isAlbumClass(node.upnpClass) ? () => heartNode(node) : undefined}
        onEnter={() => enter(node)}
        onPlay={(el) => void playContainer(node, el)}
        onMenu={(e) => openMenu(node, e)}
        folderMenu={folderMenus}
        onNavDrag={
          isAlbumClass(node.upnpClass) ? (e) => startAlbumDrag([node], e, node.title) : undefined
        }
      />
    ) : (
      <ContainerRow
        key={node.id}
        item={item}
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
        folderMenu={folderMenus}
        onNavDrag={
          isAlbumClass(node.upnpClass) ? (e) => startAlbumDrag([node], e, node.title) : undefined
        }
      />
    );

  if (servers != null && servers.length === 0) {
    return (
      <EmptyState
        className="h-full"
        icon={Library}
        art={<EmptyCrate />}
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
    opts: TrackRowOpts,
  ): React.JSX.Element => (
    <TrackRow
      key={node.id}
      item={opts.item}
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
      {/* above the scroller, which reaches up under its lower strip for ring room (below) */}
      <header className="drag-region relative z-10 flex items-center gap-4 px-8 pt-8 pb-2">
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
              {analysisProgress.at > 0 &&
                `${FACT_SEP}${analysisProgress.at}/${analysisProgress.total}`}
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
                  ? "bg-accent text-bg shadow-[0_0_14px_rgb(var(--accent-rgb)_/_0.3)] hover:brightness-110 motion-safe:active:scale-95"
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
                // the Library's one Rows or Cards, the format line and the card grid's size, gap
                // and Fill rows (0.14.0: the menu wherever the button was)
                <ViewOptions kind="folders" />
              )}
          </div>
        </div>
      </header>

      {/* search mode's accent bar and the result controls (components/library/LibrarySearchBar,
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
          pushSpot();
          exitSearch();
        }}
      />
      {/* breadcrumbs: Library (source list) › source › folders… — hidden at
          the bare root, where the screen title already says it; the trail
          folds its middle when it would not fit (Crumbs) */}
      {!searchMode && (serverUdn != null || lens != null || path.length > 0) && (
        <div
          data-library-crumbs
          className="no-drag relative z-10 flex min-h-[36px] items-start gap-3 px-8 pb-3 text-[12.5px]"
        >
          <div className="min-w-0 flex-1">
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
                          lead:
                            compactBar && albumNode && i === path.length - 1 ? (
                              <AlbumCrumbArt albumNode={albumNode} albumArt={albumArt} />
                            ) : undefined,
                        },
                      ],
                ),
              ]}
            />
          </div>
          {compactBar && albumNode && (
            <AlbumCompactVerbs
              albumNode={albumNode}
              playContainer={playContainer}
              nodeFavorited={nodeFavorited}
              heartNode={heartNode}
              openMenu={openMenu}
            />
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(e) => {
          // Recorded as you scroll, not only when you navigate: leaving for
          // another screen UNMOUNTS this one, and the album you were halfway
          // down came back at the top.
          if (artistPage && atRoot && !searchMode) {
            artistPageScroll.set(artistPage.toLowerCase(), e.currentTarget.scrollTop);
            return;
          }
          if (searchMode || lens) return;
          const key = nodeKey(serverUdn, path);
          if (loadedKey.current === key) scrollMemory.set(key, e.currentTarget.scrollTop);
        }}
        // RING ROOM at the top edge (when the doors'
        // label went and their hover glow was cut flat at this edge): the scroller reaches 24px
        // up under the header and the trail, padded by as much, so nothing moves and a hover
        // glow has room above the first row; the strip fades rather than cuts (fade-top), clear
        // across its top 12px, where the heading's letters and the trail's words reach down into
        // it (nothing shows behind words: History's rule), in over the 12px below them, so the
        // glow and any row scrolled up dissolve under the heading; a row scrolled into view stops
        // below the strip (scroll-pt-6). The header and the trail sit above the scroller, their
        // controls clickable over the strip. Only while the PAGE scrolls: a lens scrolls its own
        // columns, and a mask around them stopped Chromium's own lazy loading inside them (the
        // lenses' pictures, 0.12.0-rc.3), so a lens keeps the page as it was. Under the mask
        // ArtImage looks ahead for its lazy pictures itself (S84).
        style={{ "--fade-top-clear": "12px", "--fade-top-solid": "24px" } as React.CSSProperties}
        className={cx(
          // stable gutter: without it the scrollbar's appearance shifts every
          // right-aligned control as listings shrink/grow (macOS always-on
          // scrollbars)
          "flex-1 px-8 [scrollbar-gutter:stable]",
          // every lens scrolls its own column under its toolbar (the miller view's columns, the
          // tracks list, the albums grid since 2026-10-11) — the page must not; the artist page
          // is a page, and scrolls as one
          atRoot && lens != null && !searchMode && !artistPage
            ? "pt-1 overflow-hidden min-h-0 pb-6"
            : cx(
                "-mt-6 pt-7 scroll-pt-6 fade-top",
                // the floating bar overlaps the last rows at full scroll —
                // selection mode adds scroll-room so every row can clear it
                selTracks.size > 0 ? "overflow-y-auto pb-28" : "overflow-y-auto pb-8",
              ),
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
              // a switch of layout is a fresh mount: the columns' windowing and spots attach to
              // their scrollers as the lens mounts (its memory is module scope, so nothing is lost)
              key={cards ? "cards" : "rows"}
              pools={lensPools}
              actions={lensActions}
              onOpenArtistPage={openArtistPage}
              cards={cards}
              cardSize={presetCardSize}
              cardGap={presetGap}
              fillRows={presetFillRows}
            />
          ) : (
            <TracksLens
              // the rows and the cards are two views, each from its own top and spot; the Tracks
              // view's own Rows or Cards since 0.13.0-rc.4
              key={tracksCards ? "cards" : "rows"}
              pools={lensPools}
              actions={lensActions}
              cards={tracksCards}
              cardSize={presetCardSize}
              cardGap={presetGap}
              fillRows={presetFillRows}
            />
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

        {!atRoot && state === "ready" && containers.length > 0 && !searchMode && (
          <LibraryFolders
            containers={containers}
            artistFolder={artistNode != null}
            cards={cards}
            presetFillRows={presetFillRows}
            presetCardSize={presetCardSize}
            presetGap={presetGap}
            enter={enter}
            openMenu={openMenu}
            folderMenus={folderMenus}
            containerItem={containerItem}
          />
        )}

        {/* every search result, one windowed list (components/library/LibrarySearchResults): one
            library's search and the search across libraries alike */}
        <LibrarySearchResults
          shown={Boolean(
            (!atRoot && state === "ready" && searchMode && searchState) ||
            (crossMode && crossState),
          )}
          scrollRef={scrollRef}
          crossMode={crossMode}
          crossState={crossState}
          crossGroups={crossGroups}
          searchMode={searchMode}
          searchState={searchState}
          containers={containers}
          tracks={tracks}
          cards={cards}
          presetCardSize={presetCardSize}
          presetGap={presetGap}
          presetFillRows={presetFillRows}
          servers={servers}
          enter={enter}
          trackRowClick={trackRowClick}
          playTrack={playTrack}
          openMenu={openMenu}
          containerItem={containerItem}
          trackRow={trackRow}
        />

        {/* tracks are ALWAYS rows — the app-wide idiom (Queue, Recently,
            Favorites, album tracklists). The cards ⇄ rows toggle governs
            container lists only. */}
        {/* floats over the list (toast entrance, popover surface) — in flow
            it pushed the rows being picked; anchored to the screen root, so
            the scroller neither clips nor carries it */}
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
              onClick={(e) => setPlaylistMulti({ nodes: selectedNodes(), ...menuAt(e) })}
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
        {!atRoot && state === "ready" && !searchMode && tracks.length > 0 ? (
          <LibraryTracks
            tracks={tracks}
            containers={containers}
            artistNode={artistNode}
            albumNode={albumNode}
            albumArtist={albumArtist}
            searchMode={searchMode}
            queueSourceActive={queueSourceActive}
            isCurrentTrack={isCurrentTrack}
            trackRowClick={trackRowClick}
            playTrack={playTrack}
            openMenu={openMenu}
            albumNoteFor={albumNoteFor}
            trackRow={trackRow}
          />
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
        recentListVerbs={recentListVerbs}
        linkable={linkable}
        goToAlbum={goToAlbum}
        goToArtist={goToArtist}
        openInfoFor={openInfoFor}
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
