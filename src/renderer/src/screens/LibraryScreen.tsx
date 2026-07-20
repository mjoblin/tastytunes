import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
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
  Usb
} from 'lucide-react'
import {
  favoriteKey,
  type AppSettings,
  type Favorite,
  type FavoriteMedia,
  type MediaNode,
  type MediaQueueAction,
  type MediaServerInfo,
  type ScreenLayout
} from '@shared/ipc'
import type { QueueListItem } from '@shared/smoip'
import { tt } from '@/api'
import { useStore } from '@/store'
import { activeSourceId, cx, fmtTime, matchesFilter } from '@/lib/format'
import { flashTarget } from '@/lib/scroll'
import { isAlbumClass, stripFurniture } from '@/lib/media'
import { toggleFavorite } from '@/lib/favorites'
import { ArtImage } from '@/components/ArtImage'
import { FilterInput } from '@/components/FilterInput'
import { ContainerCard, ContainerRow, TrackCard, TrackRow } from '@/components/LibraryCards'
import { ItemMenu, PresetPicker } from '@/components/LibraryMenus'
import { EmptyState } from '@/components/EmptyState'
import { PopoverChrome } from '@/hooks/usePopover'

// Crumbs keep the entered node so an album level can render its header
// (art, artist, year) without re-fetching metadata.
type Crumb = { id: string; title: string; node?: MediaNode }

// Entering the Library always lands on the source list — "Library" in the
// nav/palette/shortcuts is the front door, not "wherever I last was" (user
// ask). Per-folder scroll and filter memories below still apply while
// browsing within a visit.
const scrollMemory = new Map<string, number>()
// Per-LEVEL filter memory: each folder keeps its own filter for the session
// (the store's screenFilters.library always holds the current level's).
const filterMemory = new Map<string, string>()

const nodeKey = (serverUdn: string | null, path: Crumb[]): string =>
  `${serverUdn ?? ''}|${path.map((c) => c.id).join('/')}`

// Synthetic crumb planted when a search RESULT is entered: the trail reads
// Library › server › “query” › Artist, and the query crumb (or Backspace)
// restores the search with its results intact. It never reaches the browse
// layer — titlePaths strip it (a result's true folder path is unknown, so
// stale-id rewalks can't recover search-entered branches either way).
const SEARCH_CRUMB_ID = '__search-results__'

/**
 * Library: browse UPnP media (LAN servers and the streamer's own USB storage)
 * and act on it — a bare click is never destructive (track click = Play now,
 * container click = drill in); queue-replacing verbs live behind explicit
 * buttons and the ⋯ menu.
 */
export function LibraryScreen(): React.JSX.Element {
  const { libraryLayout, librarySort, librarySortReversed, presetCardSize, presetGap, presetFillRows } =
    useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const saveSettings = useStore((s) => s.saveSettings)
  const filter = useStore((s) => s.screenFilters.library)
  const setScreenFilter = useStore((s) => s.setScreenFilter)
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const zoneState = useStore((s) => s.zoneState)
  const queue = useStore((s) => s.queue)
  const cards = libraryLayout === 'cards'

  const [servers, setServers] = useState<MediaServerInfo[] | null>(null)
  const [serverUdn, setServerUdn] = useState<string | null>(null)
  const [path, setPath] = useState<Crumb[]>([])
  const [nodes, setNodes] = useState<MediaNode[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  // Whole-library search MODE (searchable servers): an explicit state with
  // its own gold bar and input — visually distinct from folder filtering.
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchState, setSearchState] = useState<{
    query: string
    items: MediaNode[]
    total: number
  } | null>(null)
  const [searching, setSearching] = useState(false)
  // Where to come back to when a search result was entered: the results
  // themselves plus the folder the search ran over.
  const [searchReturn, setSearchReturn] = useState<{
    query: string
    items: MediaNode[]
    total: number
    prevPath: Crumb[]
  } | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (searchMode) searchInputRef.current?.focus()
  }, [searchMode])
  const [fetchNonce, setFetchNonce] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Action feedback: the app-wide toast for failures, a gold pulse for wins.
  // (The screen's original local notice banner graduated into the toast.)
  const showToast = useStore((s) => s.showToast)
  const showNotice = (msg: string): void => showToast({ kind: 'error', text: msg })

  const loadServers = useCallback((): void => {
    setServers(null)
    void tt
      .mediaServers()
      .then((list) => {
        setServers(list)
        // a remembered source that vanished falls back to the source list
        setServerUdn((cur) => (cur && list.some((s) => s.udn === cur) ? cur : null))
      })
      .catch(() => setServers([]))
  }, [])

  useEffect(() => loadServers(), [loadServers])

  useEffect(() => {
    if (!serverUdn) {
      setNodes([])
      setState('ready')
      return
    }
    let stale = false
    setState('loading')
    void tt
      .mediaBrowse(
        serverUdn,
        path.length > 0 ? path[path.length - 1].id : null,
        path.filter((c) => c.id !== SEARCH_CRUMB_ID).map((c) => c.title)
      )
      .then((list) => {
        if (stale) return
        setNodes(stripFurniture(list))
        setState('ready')
        const remembered = scrollMemory.get(nodeKey(serverUdn, path)) ?? 0
        requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: remembered }))
      })
      .catch(() => {
        if (!stale) setState('error')
      })
    return () => {
      stale = true
    }
  }, [serverUdn, path, fetchNonce])

  const rememberScroll = (): void => {
    if (scrollRef.current) scrollMemory.set(nodeKey(serverUdn, path), scrollRef.current.scrollTop)
  }

  // Each level keeps its own filter: stash the current one, restore the
  // destination's (or empty) whenever navigation happens.
  const exitSearch = (): void => {
    setSearchMode(false)
    setSearchState(null)
    setSearchQuery('')
    document.documentElement.classList.remove('filter-focused')
  }

  const moveTo = (udn: string | null, newPath: Crumb[]): void => {
    rememberScroll()
    exitSearch()
    filterMemory.set(nodeKey(serverUdn, path), filter)
    setScreenFilter('library', filterMemory.get(nodeKey(udn, newPath)) ?? '')
    setServerUdn(udn)
    setPath(newPath)
  }

  // Re-invoking "Library" (nav click, palette, L) while already here resets
  // to the source list — the nonce bumps on every setScreen('library').
  // EXCEPT when another screen planted a destination (Favorites → open
  // album): then this visit lands directly on that node. Intermediate crumbs
  // carry sentinel ids — clicking one fails the fresh browse and the
  // title-path re-walk resolves it, the same recovery stale USB ids use.
  const libraryResetNonce = useStore((s) => s.libraryResetNonce)
  const clearLibraryTarget = useStore((s) => s.clearLibraryTarget)
  useEffect(() => {
    const target = useStore.getState().libraryTarget
    // Nonce EQUALITY, not consume-and-clear: this effect must be idempotent
    // (StrictMode double-runs it in dev — clearing on first run made the
    // second run land on the source list). A leftover target with an older
    // nonce is stale — drop it and reset normally.
    if (target && target.nonce !== libraryResetNonce) clearLibraryTarget()
    if (target && target.nonce === libraryResetNonce) {
      const last = target.titlePath.length - 1
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
                  upnpClass: 'object.container.album.musicAlbum',
                  isContainer: true,
                  artUrl: null,
                  artist: null,
                  album: null,
                  year: null,
                  trackNumber: null,
                  durationSecs: null
                }
              }
            : { id: `__fav-crumb-${i}__`, title }
        )
      )
      return
    }
    moveTo(null, [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryResetNonce])

  const enter = (node: MediaNode): void => {
    if (searchMode && searchState) {
      // Entering a result: plant the query crumb so the trail offers the
      // way back, and remember the results for an instant restore.
      setSearchReturn({ ...searchState, prevPath: path })
      moveTo(serverUdn, [
        { id: SEARCH_CRUMB_ID, title: `“${searchState.query}”` },
        { id: node.id, title: node.title, node }
      ])
      return
    }
    moveTo(serverUdn, [...path, { id: node.id, title: node.title, node }])
  }
  const enterServer = (udn: string): void => moveTo(udn, [])

  /** Bring the search back exactly as it was left (no refetch). */
  const returnToSearch = (): void => {
    if (!searchReturn) return
    rememberScroll()
    filterMemory.set(nodeKey(serverUdn, path), filter)
    setScreenFilter('library', filterMemory.get(nodeKey(serverUdn, searchReturn.prevPath)) ?? '')
    setPath(searchReturn.prevPath)
    setSearchMode(true)
    setSearchQuery(searchReturn.query)
    setSearchState({
      query: searchReturn.query,
      items: searchReturn.items,
      total: searchReturn.total
    })
  }

  // Crumb trail: Library (source list) › source › folders…
  const jumpTo = (index: number): void => {
    if (index === 0) return moveTo(null, [])
    const newPath = path.slice(0, index - 1)
    if (newPath[newPath.length - 1]?.id === SEARCH_CRUMB_ID) return returnToSearch()
    moveTo(serverUdn, newPath)
  }
  const goUp = (): void => {
    if (searchMode) exitSearch() // search exits first, folder stays
    else if (path.length > 0) {
      if (path[path.length - 2]?.id === SEARCH_CRUMB_ID) return returnToSearch()
      moveTo(serverUdn, path.slice(0, -1))
    } else if (serverUdn) moveTo(null, [])
  }

  // Backspace and the mouse back button go up a level (arrows stay with
  // transport seek/volume); above a source's root they land on the source list.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        goUp()
      }
    }
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button === 3) {
        e.preventDefault()
        goUp()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mouseup', onMouseUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, serverUdn, filter, searchState, searchReturn])

  const setLayout = async (libraryLayout: ScreenLayout): Promise<void> => {
    await saveSettings({ libraryLayout })
  }

  const runSearch = (): void => {
    const query = searchQuery.trim()
    if (!serverUdn || !query) return
    // hand the keyboard back to navigation (Backspace = exit search)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    setSearching(true)
    void tt
      .mediaSearch(serverUdn, query)
      .then((res) => setSearchState({ query, ...res }))
      .catch(() => showNotice("Search failed — the server didn't answer."))
      .finally(() => setSearching(false))
  }

  // ----------------------------------------------------------------- actions

  const act = async (
    node: MediaNode,
    action: MediaQueueAction,
    el: HTMLElement | null,
    playFromId?: string
  ): Promise<void> => {
    if (!serverUdn) return
    try {
      await tt.mediaQueueAdd(serverUdn, node.id, action, playFromId)
      if (el) flashTarget(el)
    } catch {
      showNotice("Couldn't reach the streamer — nothing was queued.")
    }
  }

  // Title-keyed queue index: the content-match used to scan the whole queue
  // once per TRACK ROW per render (O(nodes × queue) under a 400-item grid);
  // one Map per queue push makes each lookup O(same-titled entries).
  const queueByTitle = useMemo(() => {
    const m = new Map<string, QueueListItem[]>()
    for (const i of queue?.items ?? []) {
      const t = i.metadata?.title
      if (t == null || i.id == null) continue
      const list = m.get(t)
      if (list) list.push(i)
      else m.set(t, [i])
    }
    return m
  }, [queue])

  /** Queue entries whose metadata content-matches a library track. */
  const queueMatches = (node: MediaNode): QueueListItem[] =>
    (queueByTitle.get(node.title) ?? []).filter((i) => {
      const m = i.metadata
      return (
        m != null &&
        (m.album == null || node.album == null || m.album === node.album) &&
        (m.artist == null || node.artist == null || m.artist === node.artist)
      )
    })
  const trackQueued = (node: MediaNode): boolean => queueMatches(node).length > 0

  /**
   * Bare track click: if the track is already in the queue, JUMP to that
   * queue entry (first occurrence at-or-after the current position) instead
   * of inserting a duplicate — clicking an album you just queued navigates
   * it. Only genuinely un-queued tracks insert (PLAY_NOW). The ⋯ verbs stay
   * literal inserts.
   */
  const playTrack = (node: MediaNode, el: HTMLElement | null): void => {
    const items = queue?.items ?? []
    const matches = queueMatches(node)
    if (matches.length > 0) {
      const playId = queue?.play_id ?? playState?.queue_id ?? null
      const curIdx = items.findIndex((i) => i.id === playId)
      const target = matches.find((mi) => items.indexOf(mi) >= curIdx) ?? matches[0]
      void tt.command({ type: 'playQueueId', queueId: target.id as number })
      if (el) flashTarget(el)
      return
    }
    void act(node, 'PLAY_NOW', el)
  }

  /** "Play" on a container: replace the queue with it and start at its first track. */
  const playContainer = async (node: MediaNode, el: HTMLElement | null): Promise<void> => {
    if (!serverUdn) return
    try {
      const children = await tt.mediaBrowse(serverUdn, node.id, [
        ...path.map((c) => c.title),
        node.title
      ])
      const firstTrack = children.find((c) => !c.isContainer)
      if (firstTrack) {
        await tt.mediaQueueAdd(serverUdn, node.id, 'PLAY_FROM_HERE', firstTrack.id)
      } else {
        await tt.mediaQueueAdd(serverUdn, node.id, 'REPLACE')
      }
      if (el) flashTarget(el)
    } catch {
      showNotice("Couldn't reach the streamer — nothing was queued.")
    }
  }

  // Throws on failure so the shared panel stays open; closes the picker itself
  // on success. A custom name rides along via presetRename (the firmware names
  // media presets from content otherwise).
  const savePreset = async (node: MediaNode, slot: number, name: string | null): Promise<void> => {
    if (!serverUdn) return
    try {
      await tt.mediaPresetSave(serverUdn, node.id, slot)
      if (name) await tt.command({ type: 'presetRename', slot, name })
    } catch {
      showNotice("Couldn't save the preset.")
      throw new Error('preset save failed')
    }
    setPresetPicker(null)
    // unlike queue-adds there's no in-place flash — the effect lives on Presets
    showToast({
      kind: 'success',
      text: `Saved “${name ?? node.title}” to preset ${slot}`,
      action: { label: 'View', screen: 'presets' }
    })
  }

  // ------------------------------------------------------------------ menus

  const [menu, setMenu] = useState<{ node: MediaNode; x: number; y: number } | null>(null)
  const [presetPicker, setPresetPicker] = useState<{ node: MediaNode; x: number; y: number } | null>(
    null
  )
  // The card/row a popover belongs to holds its hover treatment while open.
  const menuNodeId = menu?.node.id ?? presetPicker?.node.id ?? null
  const openMenu = (node: MediaNode, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ node, x: e.clientX, y: e.clientY })
  }

  // -------------------------------------------------------------- derivation

  const atRoot = serverUdn == null
  // The filter belongs to listings with playable media (albums/tracks);
  // navigation folders and the source list don't offer it. Search results
  // aren't client-filtered — the search input is the text control there.
  const hasPlayable = nodes.some((n) => !n.isContainer || isAlbumClass(n.upnpClass))
  const filterAvailable = !searchMode && !atRoot && state === 'ready' && hasPlayable
  const effFilter = filterAvailable ? filter : ''

  // Album level: header with art + album metadata; tracks drop per-row art.
  // (Derived before the listing memo — album tracklists sort by track number.)
  const lastCrumbNode = path.length > 0 ? path[path.length - 1].node : undefined
  const albumNode =
    !searchMode && lastCrumbNode && isAlbumClass(lastCrumbNode.upnpClass) ? lastCrumbNode : null

  // Filtered + sorted listings are memoized: unmemoized they re-ran the
  // localeCompare sorts and filter scans on every store push — once a second
  // during playback, under grids that can hold 400+ cards.
  const { baseNodes, shown, containers, tracks } = useMemo(() => {
    const baseNodes = searchMode ? (searchState?.items ?? []) : nodes
    const shown = effFilter
      ? baseNodes.filter((n) => matchesFilter(effFilter, [n.title, n.artist, n.album, n.year]))
      : baseNodes
    // Shared sort for albums AND loose-track listings; missing fields fall
    // back to title so folders stay sane. Album tracklists are exempt below.
    const sortNodes = (list: MediaNode[]): MediaNode[] => {
      const sorted =
        librarySort === 'server'
          ? list
          : [...list].sort((a, b) => {
              if (librarySort === 'artist')
                return (
                  (a.artist ?? '￿').localeCompare(b.artist ?? '￿') ||
                  a.title.localeCompare(b.title)
                )
              if (librarySort === 'year')
                return (b.year ?? '').localeCompare(a.year ?? '') || a.title.localeCompare(b.title)
              return a.title.localeCompare(b.title)
            })
      return librarySortReversed ? [...sorted].reverse() : sorted
    }
    // Search results keep the server's own order (sort chip is hidden there).
    const containers = searchMode
      ? shown.filter((n) => n.isContainer)
      : sortNodes(shown.filter((n) => n.isContainer))
    const rawTracks = shown.filter((n) => !n.isContainer)
    // Track order: album views always by track number (the album's own
    // order); loose listings (Title views, mixed folders) follow the sort.
    const tracks = albumNode
      ? rawTracks.length > 1 && rawTracks.every((t) => t.trackNumber != null)
        ? [...rawTracks].sort((a, b) => (a.trackNumber ?? 0) - (b.trackNumber ?? 0))
        : rawTracks
      : searchMode
        ? rawTracks
        : sortNodes(rawTracks)
    return { baseNodes, shown, containers, tracks }
  }, [nodes, searchMode, searchState, effFilter, librarySort, librarySortReversed, albumNode])
  const server = servers?.find((s) => s.udn === serverUdn) ?? null

  // Playing-item highlight, queue-screen rules: library items carry no queue
  // ids, so match the playing metadata by content (title, plus artist/album
  // when both sides have them), and only while the queue's source is audible.
  const md = playState?.metadata ?? null
  const queueSourceActive = activeSourceId(zoneState, nowPlaying) === 'MEDIA_PLAYER'
  const isPlayingState = playState?.state === 'play'
  const isCurrentTrack = (node: MediaNode): boolean =>
    md != null &&
    node.title === md.title &&
    (node.album == null || md.album == null || node.album === md.album) &&
    (node.artist == null || md.artist == null || node.artist === md.artist)
  const isPlayingAlbum = (node: MediaNode): boolean =>
    md != null &&
    md.album === node.title &&
    (node.artist == null || md.artist == null || node.artist === md.artist)

  const allTracks = useMemo(() => nodes.filter((n) => !n.isContainer), [nodes])
  const albumArt = albumNode ? (albumNode.artUrl ?? allTracks[0]?.artUrl ?? null) : null
  const albumArtist = albumNode
    ? (albumNode.artist ??
      (allTracks.length > 0 && allTracks.every((t) => t.artist === allTracks[0].artist)
        ? allTracks[0].artist
        : allTracks.length > 0
          ? 'Various artists'
          : null))
    : null
  const albumSecs = allTracks.reduce((acc, t) => acc + (t.durationSecs ?? 0), 0)
  const albumInQueue = allTracks.length > 0 && allTracks.every(trackQueued)
  const albumFacts = albumNode
    ? [
        albumNode.year ?? allTracks[0]?.year ?? null,
        allTracks.length > 0 ? `${allTracks.length} tracks` : null,
        albumSecs > 0 ? fmtTime(albumSecs) : null,
        albumInQueue ? 'in the queue' : null
      ]
        .filter(Boolean)
        .join(' · ')
    : ''
  const shownServers = servers ?? [] // the source list is short — no filter there
  const loading = atRoot ? servers == null : state === 'loading'

  // ---------------------------------------------------------------- favorites
  const favorites = useStore((s) => s.favorites)
  const favKeys = useMemo(() => new Set(favorites.map(favoriteKey)), [favorites])
  const pathTitles = path.filter((c) => c.id !== SEARCH_CRUMB_ID).map((c) => c.title)
  /**
   * A library node as a favorite payload. Content identity + resolution
   * hints: the entered album's titlePath is the current trail (it already
   * ends in the album); a listed node appends its own title. Search results
   * carry no trustworthy trail (their true folder is unknown) — null.
   */
  const mediaFav = (node: MediaNode): Omit<FavoriteMedia, 'addedAt'> => ({
    kind: node.isContainer ? 'album' : 'track',
    title: node.title,
    artist: node === albumNode ? (albumArtist ?? node.artist) : node.artist,
    album: node.isContainer ? null : node.album,
    artUrl: node === albumNode ? (albumArt ?? node.artUrl) : node.artUrl,
    serverUdn,
    serverName: server?.name ?? null,
    objectId: node.id,
    titlePath: searchMode
      ? null
      : node === albumNode
        ? pathTitles
        : node.isContainer
          ? [...pathTitles, node.title]
          : pathTitles,
    durationSecs: node.isContainer ? null : node.durationSecs
  })
  const nodeFavorited = (node: MediaNode): boolean =>
    favKeys.has(favoriteKey(mediaFav(node) as Favorite))
  const heartNode = (node: MediaNode): void => {
    void toggleFavorite(mediaFav(node))
  }

  // "Retrieving…" only appears when a browse actually takes a moment —
  // cached/fast responses swap in without a flash of loading copy.
  const [showLoading, setShowLoading] = useState(false)
  useEffect(() => {
    if (!loading) {
      setShowLoading(false)
      return
    }
    const t = setTimeout(() => setShowLoading(true), 250)
    return () => clearTimeout(t)
  }, [loading])

  // ------------------------------------------------------------------ render

  // Search-result group headings: identical under-gap everywhere (mb-0.5 —
  // the lists below carry no extra top margin in search mode), identical
  // above-gap too (mt-2 for whichever group lands first, mt-5 after).
  const groupLabelClass = (first: boolean): string =>
    cx('microlabel mb-0.5 px-1', first ? 'mt-2' : 'mt-5')

  const containerGrid = (list: MediaNode[]): React.JSX.Element => (
    <div
      className={cx(!cards && 'divide-y divide-edge/50 -mx-2')}
      style={
        cards
          ? {
              display: 'grid',
              gridTemplateColumns: presetFillRows
                ? `repeat(auto-fill, minmax(${presetCardSize}px, 1fr))`
                : `repeat(auto-fill, ${presetCardSize}px)`,
              gap: presetGap,
              paddingTop: 8
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
            audible={isPlayingState}
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
            audible={isPlayingState}
            menuOpen={menuNodeId === node.id}
            favorited={isAlbumClass(node.upnpClass) ? nodeFavorited(node) : undefined}
            onHeart={isAlbumClass(node.upnpClass) ? () => heartNode(node) : undefined}
            onEnter={() => enter(node)}
            onMenu={(e) => openMenu(node, e)}
          />
        )
      )}
    </div>
  )

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
    )
  }

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-2">
        <h1 className="font-display font-bold text-[26px] tracking-tight">Library</h1>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          {filterAvailable && (
            <FilterInput
              value={filter}
              onChange={(t) => setScreenFilter('library', t)}
              shown={shown.length}
              total={baseNodes.length}
            />
          )}
          {!searchMode && !atRoot && server?.searchable && (
            <button
              data-library-search-button
              onClick={() => setSearchMode(true)}
              className="no-drag flex items-center gap-2 px-3 h-8 rounded-lg ring-1 ring-edge bg-panel/70 text-[12.5px] text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
            >
              <Search size={14} />
              Search {server.name}
            </button>
          )}
          {!searchMode && !atRoot && (containers.length > 1 || (!albumNode && tracks.length > 1)) && (
            <SortChip
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
          {/* the rows⇄cards toggle only governs mid-level browse lists; the
              root (sources always cards) and album views (tracklist always
              rows) ignore it, so it's hidden there rather than sitting dead */}
          {!atRoot && !albumNode && (
            <button
              data-tip={cards ? 'View as rows' : 'View as cards'}
              aria-label={cards ? 'View as rows' : 'View as cards'}
              onClick={() => void setLayout(cards ? 'rows' : 'cards')}
              className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
            >
              {cards ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
            </button>
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
              if (e.key === 'Enter') {
                e.preventDefault()
                runSearch()
              }
              if (e.key === 'Escape') {
                e.stopPropagation()
                if (searchQuery) setSearchQuery('')
                else exitSearch()
              }
            }}
            onFocus={() => document.documentElement.classList.add('filter-focused')}
            onBlur={() => document.documentElement.classList.remove('filter-focused')}
            placeholder={`Search all of ${server?.name ?? 'this library'}…`}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[13.5px] text-ink placeholder:text-gold/50"
          />
          {searching ? (
            <span className="shrink-0 text-[12px] text-gold/80 motion-safe:animate-pulse">
              searching…
            </span>
          ) : searchState ? (
            <span className="shrink-0 font-mono text-[11px] text-gold/80 tabular-nums">
              {searchState.total} result{searchState.total === 1 ? '' : 's'}
              {searchState.total > searchState.items.length &&
                ` · first ${searchState.items.length}`}
            </span>
          ) : null}
          <button
            data-library-search-exit
            onClick={exitSearch}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber text-bg text-[12.5px] font-medium motion-safe:active:scale-95 transition-all"
          >
            <ArrowLeft size={13} /> Back to browsing
          </button>
        </div>
      )}

      {/* breadcrumbs: Library (source list) › source › folders… */}
      {!searchMode && (
      <div className="no-drag flex items-center gap-1 flex-wrap px-8 pb-3 text-[12.5px]">
        <button
          onClick={() => jumpTo(0)}
          className={cx(
            'px-1.5 py-0.5 rounded transition-colors',
            atRoot ? 'text-ink' : 'text-dim hover:text-ink hover:bg-veil'
          )}
        >
          Library
        </button>
        {server && (
          <span className="flex items-center gap-1">
            <ChevronRight size={12} className="text-faint" />
            <button
              onClick={() => jumpTo(1)}
              className={cx(
                'px-1.5 py-0.5 rounded transition-colors',
                path.length === 0 ? 'text-ink' : 'text-dim hover:text-ink hover:bg-veil'
              )}
            >
              {server.name}
            </button>
          </span>
        )}
        {path.map((crumb, i) => (
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
                  'px-1.5 py-0.5 rounded transition-colors',
                  i === path.length - 1 ? 'text-ink' : 'text-dim hover:text-ink hover:bg-veil'
                )}
              >
                {crumb.title}
              </button>
            )}
          </span>
        ))}
      </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 pb-8 pt-1">
        {showLoading && (
          <div className="text-[13px] text-dim pt-4 motion-safe:animate-pulse">
            Retrieving library…
          </div>
        )}

        {/* root: sources, grouped like the official app (Servers / USB drives).
            Cards, not a list built for volume — same geometry and the same
            size/gap/fill settings as every other media card grid, so the
            card-size slider governs the landing too. */}
        {!loading && atRoot && (
          <div className="space-y-7 pt-1">
            {shownServers.length === 0 && (
              <div className="text-[15px] text-faint pt-3 px-1">
                {filter ? `No matches for “${filter}”` : 'Nothing here'}
              </div>
            )}
            {(['servers', 'usb'] as const).map((kind) => {
              const group = shownServers.filter((s) => (kind === 'usb') === s.isStreamer)
              if (group.length === 0) return null
              return (
                <div key={kind}>
                  <div className="microlabel mb-0.5 px-1">
                    {kind === 'usb' ? 'USB drives' : 'Servers'}
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: presetFillRows
                        ? `repeat(auto-fill, minmax(${presetCardSize}px, 1fr))`
                        : `repeat(auto-fill, ${presetCardSize}px)`,
                      gap: presetGap,
                      paddingTop: 8
                    }}
                  >
                    {group.map((s) => (
                      <div
                        key={s.udn}
                        data-library-source
                        onClick={() => enterServer(s.udn)}
                        className="group relative rounded-2xl p-2 pb-2.5 bg-raised/70 ring-1 ring-edge card-hover-glow cursor-pointer transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]"
                      >
                        <div className="aspect-square w-full rounded-lg ring-1 ring-edge bg-panel/70 flex items-center justify-center">
                          {s.isStreamer ? (
                            <Usb
                              size={40}
                              strokeWidth={1.1}
                              className="text-faint group-hover:text-dim transition-colors"
                            />
                          ) : (
                            <HardDrive
                              size={40}
                              strokeWidth={1.1}
                              className="text-faint group-hover:text-dim transition-colors"
                            />
                          )}
                        </div>
                        <div className="pt-1.5 text-[12.5px] truncate">{s.name}</div>
                        <div className="text-[11.5px] text-faint truncate">
                          {s.model ??
                            (s.isStreamer ? 'Storage on the streamer' : 'Media server')}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {!atRoot && state === 'error' && (
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
        {!atRoot && state === 'ready' && albumNode && (
          <div className="flex items-start gap-6 pb-6 pt-2" data-album-header>
            <div className="h-[160px] w-[160px] shrink-0 rounded-xl overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
              <ArtImage
                src={albumArt}
                className="h-full w-full object-cover"
                fallback={<Disc3 size={48} strokeWidth={1} className="text-faint" />}
              />
            </div>
            <div className="min-w-0 pt-1 space-y-1.5">
              <div className="font-display font-bold text-[24px] tracking-tight leading-tight">
                {albumNode.title}
              </div>
              {albumArtist && <div className="text-[14px] text-dim truncate">{albumArtist}</div>}
              {albumFacts && <div className="text-[12.5px] text-faint">{albumFacts}</div>}
              <div className="flex items-center gap-2 pt-2">
                <button
                  data-tip="Replaces the queue"
                  onClick={(e) =>
                    void playContainer(
                      albumNode,
                      (e.currentTarget.closest('[data-album-header]') as HTMLElement) ?? null
                    )
                  }
                  className="tip-bottom flex items-center gap-2 px-4 py-2 rounded-full bg-amber text-bg text-[13px] font-medium motion-safe:active:scale-95 transition-all"
                >
                  <Play size={14} fill="currentColor" /> Play
                </button>
                <button
                  data-tip={nodeFavorited(albumNode) ? 'Remove from favorites' : 'Add to favorites'}
                  aria-label={nodeFavorited(albumNode) ? 'Remove from favorites' : 'Add to favorites'}
                  data-album-heart={nodeFavorited(albumNode) ? 'on' : 'off'}
                  onClick={() => heartNode(albumNode)}
                  className={cx(
                    'tip-bottom p-2 rounded-full ring-1 ring-edge bg-panel/70 transition-all motion-safe:active:scale-90',
                    nodeFavorited(albumNode)
                      ? 'text-gold hover:text-ink'
                      : 'text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70'
                  )}
                >
                  <Heart size={16} fill={nodeFavorited(albumNode) ? 'currentColor' : 'none'} />
                </button>
                <button
                  aria-label="More actions"
                  onClick={(e) => openMenu(albumNode, e)}
                  className="p-2 rounded-full ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 transition-all"
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
            </div>
          </div>
        )}

        {searchMode && !searchState && !searching && (
          <div className="text-[15px] text-faint pt-4 px-1">
            Search all the media on {server?.name ?? 'this library'}.
          </div>
        )}
        {searchMode && searchState && !searching && shown.length === 0 && (
          <div className="text-[15px] text-faint pt-4 px-1">
            No results for “{searchState.query}”
          </div>
        )}
        {!searchMode && !atRoot && state === 'ready' && shown.length === 0 && (
          <div className="text-[15px] text-faint pt-4 px-1">
            {effFilter ? `No matches for “${effFilter}”` : 'Nothing here'}
          </div>
        )}

        {!atRoot && state === 'ready' && containers.length > 0 && !searchMode && (
          containerGrid(containers)
        )}

        {/* search results come grouped so albums / artists / tracks read
            at a glance */}
        {!atRoot && state === 'ready' && searchMode && searchState && (
          <>
            {(() => {
              const albums = containers.filter((c) => isAlbumClass(c.upnpClass))
              const artists = containers.filter((c) => c.upnpClass.includes('musicArtist'))
              const other = containers.filter(
                (c) => !isAlbumClass(c.upnpClass) && !c.upnpClass.includes('musicArtist')
              )
              return (
                <>
                  {albums.length > 0 && (
                    <>
                      <div className={groupLabelClass(true)}>Albums</div>
                      {containerGrid(albums)}
                    </>
                  )}
                  {artists.length > 0 && (
                    <>
                      <div className={groupLabelClass(albums.length === 0)}>Artists</div>
                      {containerGrid(artists)}
                    </>
                  )}
                  {other.length > 0 && (
                    <>
                      <div className={groupLabelClass(albums.length === 0 && artists.length === 0)}>
                        Folders
                      </div>
                      {containerGrid(other)}
                    </>
                  )}
                </>
              )
            })()}
          </>
        )}

        {searchMode && searchState && state === 'ready' && tracks.length > 0 && (
          <div className={groupLabelClass(containers.length === 0)}>Tracks</div>
        )}

        {/* loose tracks honor the cards ⇄ rows toggle; album views keep rows
            (the header presents the album — rows are the tracklist idiom) */}
        {!atRoot && state === 'ready' && tracks.length > 0 && cards && !albumNode ? (
          <div
            className={cx(containers.length > 0 && !searchMode && 'mt-4')}
            style={{
              display: 'grid',
              gridTemplateColumns: presetFillRows
                ? `repeat(auto-fill, minmax(${presetCardSize}px, 1fr))`
                : `repeat(auto-fill, ${presetCardSize}px)`,
              gap: presetGap,
              paddingTop: 8
            }}
          >
            {tracks.map((node) => (
              <TrackCard
                key={node.id}
                node={node}
                isCurrent={queueSourceActive && isCurrentTrack(node)}
                audible={isPlayingState}
                queued={trackQueued(node)}
                menuOpen={menuNodeId === node.id}
                favorited={nodeFavorited(node)}
                onHeart={() => heartNode(node)}
                onPlayNow={(el) => playTrack(node, el)}
                onMenu={(e) => openMenu(node, e)}
              />
            ))}
          </div>
        ) : !atRoot && state === 'ready' && tracks.length > 0 ? (
          <div
            className={cx(
              'divide-y divide-edge/50 -mx-2',
              containers.length > 0 && !searchMode && 'mt-4'
            )}
          >
            {tracks.map((node) => (
              <TrackRow
                key={node.id}
                node={node}
                showArt={!albumNode}
                isCurrent={queueSourceActive && isCurrentTrack(node)}
                audible={isPlayingState}
                queued={trackQueued(node)}
                menuOpen={menuNodeId === node.id}
                favorited={nodeFavorited(node)}
                onHeart={() => heartNode(node)}
                onPlayNow={(el) => playTrack(node, el)}
                onMenu={(e) => openMenu(node, e)}
              />
            ))}
          </div>
        ) : null}
      </div>

      {menu && (
        <ItemMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onAction={(action, playFromId) => {
            setMenu(null)
            if (action === 'PLAY') void playContainer(menu.node, null)
            else if (action === 'PLAY_FROM_HERE' && menu.node.parentId != null)
              // needs the parent ALBUM's DIDL, starting from this track
              void act({ ...menu.node, id: menu.node.parentId }, 'PLAY_FROM_HERE', null, playFromId)
            else void act(menu.node, action, null, playFromId)
          }}
          onSavePreset={() => {
            setPresetPicker({ node: menu.node, x: menu.x, y: menu.y })
            setMenu(null)
          }}
          // Albums and tracks are heartable; plain folders and artists aren't.
          favorite={
            !menu.node.isContainer || isAlbumClass(menu.node.upnpClass)
              ? {
                  active: nodeFavorited(menu.node),
                  toggle: () => {
                    heartNode(menu.node)
                    setMenu(null)
                  }
                }
              : undefined
          }
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
  )
}

// ------------------------------------------------------------------ sort chip

const SORTS: Array<{ value: AppSettings['librarySort']; label: string }> = [
  { value: 'server', label: 'Server order' },
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'year', label: 'Year (newest first)' }
]

function SortChip({
  value,
  reversed,
  onChange,
  onToggleReverse
}: {
  value: AppSettings['librarySort']
  reversed: boolean
  onChange(value: AppSettings['librarySort']): void
  onToggleReverse(): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        data-tip="Sort"
        aria-label="Sort"
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'no-drag tip-bottom p-2 rounded-lg ring-1 transition-all',
          value !== 'server' || reversed
            ? 'ring-gold/50 bg-golddim text-gold'
            : 'ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70'
        )}
      >
        <ArrowUpDown size={16} />
      </button>
      {open && (
        <>
          <PopoverChrome onClose={() => setOpen(false)} />
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 z-30 w-48 rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-1.5 space-y-0.5">
            {SORTS.map((s) => {
              const active = s.value === value
              return (
                <button
                  key={s.value}
                  onClick={() => {
                    // clicking the active sort flips its direction
                    if (active) onToggleReverse()
                    else {
                      setOpen(false)
                      onChange(s.value)
                    }
                  }}
                  aria-label={active ? `${s.label} — click to reverse` : s.label}
                  className={cx(
                    'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[13px] transition-colors',
                    active ? 'text-gold bg-golddim' : 'text-dim hover:text-ink hover:bg-veil'
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{s.label}</span>
                  {active && (reversed ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
                </button>
              )
            })}
            <div className="px-2.5 pt-1 pb-0.5 text-[10.5px] text-faint">
              Click the active sort to reverse it
            </div>
          </div>
        </>
      )}
    </div>
  )
}

