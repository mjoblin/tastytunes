import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Disc3,
  Folder,
  HardDrive,
  LayoutGrid,
  Library,
  MoreHorizontal,
  Play,
  RotateCw,
  Rows3,
  Search,
  Usb
} from 'lucide-react'
import type {
  AppSettings,
  MediaNode,
  MediaQueueAction,
  MediaServerInfo,
  ScreenLayout
} from '@shared/ipc'
import type { QueueListItem } from '@shared/smoip'
import { tt } from '@/api'
import { useStore } from '@/store'
import { cx, fmtTime, matchesFilter } from '@/lib/format'
import { flashTarget } from '@/lib/scroll'
import { ArtImage } from '@/components/ArtImage'
import { FilterInput } from '@/components/FilterInput'

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
  const [notice, setNotice] = useState<string | null>(null)
  const [fetchNonce, setFetchNonce] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Action feedback: a transient banner for failures, a gold pulse for wins.
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showNotice = (msg: string): void => {
    setNotice(msg)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 4000)
  }

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
  const libraryResetNonce = useStore((s) => s.libraryResetNonce)
  useEffect(() => {
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
    setSettings(await tt.setSettings({ libraryLayout }))
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

  /** Queue entries whose metadata content-matches a library track. */
  const queueMatches = (node: MediaNode): QueueListItem[] =>
    (queue?.items ?? []).filter((i) => {
      const m = i.metadata
      return (
        m != null &&
        i.id != null &&
        m.title === node.title &&
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

  const savePreset = async (node: MediaNode, slot: number): Promise<void> => {
    if (!serverUdn) return
    try {
      await tt.mediaPresetSave(serverUdn, node.id, slot)
    } catch {
      showNotice("Couldn't save the preset.")
    }
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
  const server = servers?.find((s) => s.udn === serverUdn) ?? null

  // Playing-item highlight, queue-screen rules: library items carry no queue
  // ids, so match the playing metadata by content (title, plus artist/album
  // when both sides have them), and only while the queue's source is audible.
  const md = playState?.metadata ?? null
  const queueSourceActive = (nowPlaying?.source?.id ?? zoneState?.source) === 'MEDIA_PLAYER'
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

  // Album level: header with art + album metadata; tracks drop per-row art.
  const lastCrumbNode = path.length > 0 ? path[path.length - 1].node : undefined
  const albumNode =
    !searchMode && lastCrumbNode && isAlbumClass(lastCrumbNode.upnpClass) ? lastCrumbNode : null
  const allTracks = nodes.filter((n) => !n.isContainer)
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
  // Track order: album views always by track number (the album's own order);
  // loose listings (Title views, mixed folders) follow the sort setting.
  const tracks = albumNode
    ? rawTracks.length > 1 && rawTracks.every((t) => t.trackNumber != null)
      ? [...rawTracks].sort((a, b) => (a.trackNumber ?? 0) - (b.trackNumber ?? 0))
      : rawTracks
    : searchMode
      ? rawTracks
      : sortNodes(rawTracks)
  const shownServers = servers ?? [] // the source list is short — no filter there
  const loading = atRoot ? servers == null : state === 'loading'

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
            onEnter={() => enter(node)}
            onMenu={(e) => openMenu(node, e)}
          />
        )
      )}
    </div>
  )

  if (servers != null && servers.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-8">
        <Library size={56} strokeWidth={1} className="text-faint/50" />
        <div className="font-display text-2xl text-dim">No media libraries found</div>
        <div className="text-[13px] text-faint max-w-sm">
          UPnP servers on your network and USB storage attached to the streamer show up here.
        </div>
        <button
          onClick={loadServers}
          className="mt-1 flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-[12.5px] text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
        >
          <RotateCw size={13} /> Find libraries
        </button>
      </div>
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
              onChange={(librarySort) => void tt.setSettings({ librarySort }).then(setSettings)}
              onToggleReverse={() =>
                void tt
                  .setSettings({ librarySortReversed: !librarySortReversed })
                  .then(setSettings)
              }
            />
          )}
          <button
            data-tip={cards ? 'View as rows' : 'View as cards'}
            aria-label={cards ? 'View as rows' : 'View as cards'}
            onClick={() => void setLayout(cards ? 'rows' : 'cards')}
            className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
          >
            {cards ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
          </button>
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

      {notice && (
        <div className="mx-8 mb-2 px-3 py-2 rounded-lg ring-1 ring-alert/40 bg-alert/10 text-[12.5px] text-alert">
          {notice}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 pb-8 pt-1">
        {showLoading && (
          <div className="text-[13px] text-dim pt-4 motion-safe:animate-pulse">
            Retrieving library…
          </div>
        )}

        {/* root: sources, grouped like the official app (Servers / USB drives).
            There will only ever be a handful — big preset-card-style tiles
            (squat 4:3 icon area: these are PLACES, not albums), not a list
            built for volume. */}
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
                  <div className="microlabel mb-2.5 px-1">
                    {kind === 'usb' ? 'USB drives' : 'Servers'}
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,228px)] gap-4">
                    {group.map((s) => (
                      <div
                        key={s.udn}
                        data-library-source
                        onClick={() => enterServer(s.udn)}
                        className="group relative rounded-2xl p-3 pb-3.5 bg-raised/70 ring-1 ring-edge card-hover-glow cursor-pointer transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]"
                      >
                        <div className="aspect-[4/3] w-full rounded-xl ring-1 ring-edge bg-panel/70 flex items-center justify-center">
                          {s.isStreamer ? (
                            <Usb
                              size={46}
                              strokeWidth={1.1}
                              className="text-faint group-hover:text-dim transition-colors"
                            />
                          ) : (
                            <HardDrive
                              size={46}
                              strokeWidth={1.1}
                              className="text-faint group-hover:text-dim transition-colors"
                            />
                          )}
                        </div>
                        <div className="pt-2.5 font-display font-semibold text-[15.5px] tracking-tight truncate">
                          {s.name}
                        </div>
                        <div className="text-[12px] text-faint truncate">
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
        />
      )}
      {presetPicker && (
        <PresetPicker
          picker={presetPicker}
          onClose={() => setPresetPicker(null)}
          onSave={(slot) => {
            void savePreset(presetPicker.node, slot)
            setPresetPicker(null)
          }}
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

// ------------------------------------------------------------- cards and rows

const isAlbumClass = (c: string): boolean => c.includes('musicAlbum')
const isEntityClass = (c: string): boolean =>
  c.includes('musicAlbum') || c.includes('musicArtist') || c.includes('audioItem')

/**
 * Server action-furniture: Asset (and kin) inject rows like " [All Tracks]" /
 * " [Shuffle Tracks]" beside an artist's albums — redundant re-listings of the
 * siblings around them, not places to go. The signature is a DIDL shape, not a
 * server name: bracketed title on an entirely bare `object.container`, sitting
 * beside properly-classed media entities. The sibling guard keeps this general —
 * in a pure folder tree (USB drives, filesystem servers) nothing is
 * entity-classed, so a real folder named "[Bootlegs]" survives. Navigation
 * views with class leaves (Asset's `object.container.person` letter tiles,
 * "[All Artists]") also survive — they lead somewhere and already render muted.
 */
const stripFurniture = (list: MediaNode[]): MediaNode[] => {
  if (!list.some((n) => isEntityClass(n.upnpClass))) return list
  return list.filter(
    (n) =>
      !(n.isContainer && n.upnpClass === 'object.container' && /^\[.+\]$/.test(n.title.trim()))
  )
}

/**
 * Mute navigation-folder art so it recedes into the app's palette; real
 * media art stays vivid. The upnp:class LEAF is the discriminator (probed
 * against Asset): real entities carry the specific classes musicAlbum /
 * musicArtist, while virtual views and folders are bare containers — Asset's
 * letter tiles are `object.container.person` (no .musicArtist leaf).
 */
const isMutedArt = (node: MediaNode): boolean =>
  !isAlbumClass(node.upnpClass) && !node.upnpClass.includes('musicArtist')

function ContainerCard({
  node,
  playing,
  audible,
  menuOpen,
  onEnter,
  onPlay,
  onMenu
}: {
  node: MediaNode
  /** The playing track belongs to this album (and the queue source is live). */
  playing: boolean
  /** Transport is actually in the play state (eqbars animate vs freeze). */
  audible: boolean
  /** This card's ⋯ menu or preset picker is open — hold the hover treatment. */
  menuOpen: boolean
  onEnter(): void
  onPlay(el: HTMLElement | null): void
  onMenu(e: React.MouseEvent): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  // Queue/preset verbs only make sense on albums — plain folders (artist
  // dirs, USB volumes, Asset's virtual views) get no chips and no menu.
  const album = isAlbumClass(node.upnpClass)
  const muted = isMutedArt(node)
  const subtitle = [node.artist, node.year].filter(Boolean).join(' · ')
  return (
    // Preset-card idiom: inset tile, hover grow + lift + glow; the highlight
    // wraps the gray tile so it stays legible over gold/orange covers.
    <div
      ref={ref}
      onContextMenu={album ? onMenu : undefined}
      data-library-card
      className={cx(
        'group relative text-left rounded-2xl p-2 pb-2.5 transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]',
        playing ? 'bg-goldtile/70 tile-playing' : 'bg-raised/70 ring-1 ring-edge card-hover-glow',
        // held while this card's ⋯ menu / preset picker is open — the pointer
        // has left, but the card is still what's being acted on: keep the
        // full hover treatment (grow + glow), not just a ring
        menuOpen && 'ring-1 ring-edge2 z-10 motion-safe:scale-[1.04] card-glow-held'
      )}
    >
      {/* the card CENTER always enters — play/menu are corner chips on the
          art, never intercepting the open gesture (unlike preset cards,
          whose whole-card click IS the play action) */}
      <button className="block w-full cursor-pointer" onClick={onEnter}>
        <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-panel/70 flex items-center justify-center">
          <ArtImage
            src={node.artUrl}
            lazy
            className={cx('h-full w-full object-cover', muted && 'opacity-60 saturate-[.6]')}
            fallback={
              album ? (
                <Disc3 size={34} strokeWidth={1.2} className="text-faint" />
              ) : (
                <Folder size={34} strokeWidth={1.2} className="text-faint" />
              )
            }
          />
          {muted && node.artUrl && (
            <div className="absolute inset-0 pointer-events-none bg-panel/30" />
          )}
          {playing && (
            <span className="absolute top-1.5 left-1.5 h-7 w-7 rounded-lg bg-panel/80 ring-1 ring-edge flex items-center justify-center">
              <Eqbars playing={audible} />
            </span>
          )}
          {album && (
            <span
              onClick={(e) => {
                e.stopPropagation()
                onPlay(ref.current)
              }}
              data-tip="Play — replaces the queue"
              className={cx(
                'tip-bottom absolute bottom-1.5 left-1.5 h-11 w-11 rounded-full bg-amber text-bg flex items-center justify-center transition-all duration-150 motion-safe:hover:scale-110 hover:shadow-[0_0_24px_rgb(var(--amber-rgb)_/_0.6)]',
                menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
            >
              <Play size={18} fill="currentColor" />
            </span>
          )}
          {album && (
            <span
              aria-label="More actions"
              onClick={onMenu}
              className={cx(
                'absolute bottom-1.5 right-1.5 h-8 w-8 rounded-lg bg-panel/80 ring-1 ring-edge text-dim hover:text-ink flex items-center justify-center transition-all',
                menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
            >
              <MoreHorizontal size={15} />
            </span>
          )}
        </div>
        <div
          className={cx(
            'pt-1.5 text-[12.5px] truncate text-left',
            playing ? 'text-gold' : 'text-ink'
          )}
        >
          {node.title}
        </div>
        {subtitle && (
          <div className="text-[11.5px] text-faint truncate text-left">{subtitle}</div>
        )}
      </button>
    </div>
  )
}

function ContainerRow({
  node,
  playing,
  audible,
  menuOpen,
  onEnter,
  onMenu
}: {
  node: MediaNode
  playing: boolean
  audible: boolean
  menuOpen: boolean
  onEnter(): void
  onMenu(e: React.MouseEvent): void
}): React.JSX.Element {
  // Same rule as cards: only albums carry the ⋯ menu.
  const album = isAlbumClass(node.upnpClass)
  const muted = isMutedArt(node)
  return (
    <div
      className={cx(
        'group grid grid-cols-[44px_1fr_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5 cursor-pointer transition-colors',
        playing ? 'row-playing bg-gold/10' : menuOpen ? 'bg-veil' : 'hover:bg-veil'
      )}
      onClick={onEnter}
      onContextMenu={album ? onMenu : undefined}
      data-library-row
    >
      <div className="h-10 w-10 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage
          src={node.artUrl}
          lazy
          className={cx('h-full w-full object-cover', muted && 'opacity-60 saturate-[.6]')}
          fallback={
            album ? (
              <Disc3 size={16} className="text-faint" />
            ) : (
              <Folder size={16} className="text-faint" />
            )
          }
        />
      </div>
      <div className="min-w-0">
        <div className={cx('text-[13.5px] truncate', playing ? 'text-gold' : 'text-ink')}>
          {node.title}
        </div>
        {node.artist && <div className="text-[12px] text-faint truncate">{node.artist}</div>}
      </div>
      {playing ? <Eqbars playing={audible} /> : <span />}
      {album ? (
        <button
          aria-label="More actions"
          onClick={onMenu}
          className={cx(
            'p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all',
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          <MoreHorizontal size={14} />
        </button>
      ) : (
        <span />
      )}
    </div>
  )
}

function TrackRow({
  node,
  showArt,
  isCurrent,
  audible,
  queued,
  menuOpen,
  onPlayNow,
  onMenu
}: {
  node: MediaNode
  /** Loose tracks in mixed folders get a thumb; album views carry the art in the header. */
  showArt: boolean
  /** This is what's playing right now (queue source live) — queue-row treatment. */
  isCurrent: boolean
  audible: boolean
  /** Already in the queue — a click jumps there instead of inserting. */
  queued: boolean
  menuOpen: boolean
  onPlayNow(el: HTMLElement | null): void
  onMenu(e: React.MouseEvent): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  return (
    <div
      ref={ref}
      className={cx(
        'group grid items-center gap-3 rounded-lg px-2 py-1.5 cursor-pointer transition-colors',
        showArt ? 'grid-cols-[26px_44px_1fr_auto_auto]' : 'grid-cols-[26px_1fr_auto_auto]',
        isCurrent ? 'row-playing bg-gold/10' : menuOpen ? 'bg-veil' : 'hover:bg-veil'
      )}
      onClick={() => onPlayNow(ref.current)}
      onContextMenu={onMenu}
      data-library-track
    >
      {/* left-justified: numbers sit flush with the header/art above */}
      <span className="font-mono text-[10.5px] text-faint tabular-nums">
        {isCurrent ? <Eqbars playing={audible} /> : (node.trackNumber ?? '')}
      </span>
      {showArt && (
        <div className="h-10 w-10 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
          <ArtImage src={node.artUrl} lazy fallback={<Disc3 size={16} className="text-faint" />} />
        </div>
      )}
      <div className="min-w-0">
        <div className={cx('text-[13.5px] truncate', isCurrent ? 'text-gold' : 'text-ink')}>
          {node.title}
        </div>
        {node.artist && <div className="text-[12px] text-faint truncate">{node.artist}</div>}
      </div>
      <div
        className={cx(
          'flex items-center gap-0.5 transition-opacity',
          menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
      >
        <button
          aria-label="Play"
          data-tip={queued ? 'Play — already in the queue' : 'Play now'}
          onClick={(e) => {
            e.stopPropagation()
            onPlayNow(ref.current)
          }}
          className="tip-bottom p-1.5 rounded-lg text-dim hover:text-gold hover:bg-veil2 transition-all"
        >
          <Play size={14} />
        </button>
        <button
          aria-label="More actions"
          onClick={onMenu}
          className="p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      <span className="font-mono text-[11px] text-faint tabular-nums">
        {node.durationSecs != null ? fmtTime(node.durationSecs) : ''}
      </span>
    </div>
  )
}

/** A loose track as a card (Title views, mixed folders) — click = Play now. */
function TrackCard({
  node,
  isCurrent,
  audible,
  queued,
  menuOpen,
  onPlayNow,
  onMenu
}: {
  node: MediaNode
  isCurrent: boolean
  audible: boolean
  queued: boolean
  menuOpen: boolean
  onPlayNow(el: HTMLElement | null): void
  onMenu(e: React.MouseEvent): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  return (
    <div
      ref={ref}
      onContextMenu={onMenu}
      data-library-track-card
      className={cx(
        'group relative text-left rounded-2xl p-2 pb-2.5 transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]',
        isCurrent ? 'bg-goldtile/70 tile-playing' : 'bg-raised/70 ring-1 ring-edge card-hover-glow',
        menuOpen && 'ring-1 ring-edge2 z-10 motion-safe:scale-[1.04] card-glow-held'
      )}
    >
      <button className="block w-full cursor-pointer" onClick={() => onPlayNow(ref.current)}>
        <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-panel/70 flex items-center justify-center">
          <ArtImage
            src={node.artUrl}
            lazy
            fallback={<Disc3 size={34} strokeWidth={1.2} className="text-faint" />}
          />
          {isCurrent && (
            <span className="absolute top-1.5 left-1.5 h-7 w-7 rounded-lg bg-panel/80 ring-1 ring-edge flex items-center justify-center">
              <Eqbars playing={audible} />
            </span>
          )}
          <span
            data-tip={queued ? 'Play — already in the queue' : 'Play now'}
            className={cx(
              'tip-bottom absolute bottom-1.5 left-1.5 h-11 w-11 rounded-full bg-amber text-bg flex items-center justify-center transition-all duration-150 motion-safe:hover:scale-110 hover:shadow-[0_0_24px_rgb(var(--amber-rgb)_/_0.6)]',
              menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <Play size={18} fill="currentColor" />
          </span>
          <span
            aria-label="More actions"
            onClick={onMenu}
            className={cx(
              'absolute bottom-1.5 right-1.5 h-8 w-8 rounded-lg bg-panel/80 ring-1 ring-edge text-dim hover:text-ink flex items-center justify-center transition-all',
              menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <MoreHorizontal size={15} />
          </span>
        </div>
        <div
          className={cx(
            'pt-1.5 text-[12.5px] truncate text-left',
            isCurrent ? 'text-gold' : 'text-ink'
          )}
        >
          {node.title}
        </div>
        {node.artist && (
          <div className="text-[11.5px] text-faint truncate text-left">{node.artist}</div>
        )}
      </button>
    </div>
  )
}

/**
 * Popover plumbing shared by the ⋯ menu and preset picker: Escape closes
 * (capture phase, so the app's Escape cascade underneath doesn't also fire),
 * and drag regions go inert while open so the full-window click-catcher can
 * hear clicks on the header (app-region swallows pointer events natively).
 */
function usePopoverChrome(onClose: () => void): void {
  useEffect(() => {
    document.documentElement.classList.add('popover-open')
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.documentElement.classList.remove('popover-open')
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])
}

/** Clamp a click-anchored popover fully on-screen using its MEASURED size. */
function useClampedPosition(
  ref: React.RefObject<HTMLDivElement | null>,
  x: number,
  y: number
): { left: number; top: number } {
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos({
      left: Math.max(12, Math.min(x, window.innerWidth - r.width - 12)),
      top: Math.max(12, Math.min(y, window.innerHeight - r.height - 12))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y])
  return pos
}

/** Gold playing bars (queue idiom); frozen while paused. Rendered only on the
 *  current item, so always gold. */
function Eqbars({ playing }: { playing: boolean }): React.JSX.Element {
  return (
    <span className={cx('eqbars text-gold', !playing && 'paused')}>
      <span style={{ height: 6 }} />
      <span style={{ height: 10 }} />
      <span style={{ height: 5 }} />
    </span>
  )
}

// ------------------------------------------------------------------- ⋯ menu

function ItemMenu({
  menu,
  onClose,
  onAction,
  onSavePreset
}: {
  menu: { node: MediaNode; x: number; y: number }
  onClose(): void
  onAction(action: MediaQueueAction | 'PLAY', playFromId?: string): void
  onSavePreset(): void
}): React.JSX.Element {
  const { node } = menu
  const items: Array<{ label: string; run: () => void }> = node.isContainer
    ? [
        { label: 'Play', run: () => onAction('PLAY') },
        { label: 'Play next', run: () => onAction('PLAY_NEXT') },
        { label: 'Add to end of queue', run: () => onAction('APPEND') },
        { label: 'Replace queue', run: () => onAction('REPLACE') },
        { label: 'Save to preset…', run: onSavePreset }
      ]
    : [
        { label: 'Play now', run: () => onAction('PLAY_NOW') },
        { label: 'Play next', run: () => onAction('PLAY_NEXT') },
        { label: 'Add to end of queue', run: () => onAction('APPEND') },
        { label: 'Replace queue', run: () => onAction('REPLACE') },
        ...(node.parentId
          ? [
              {
                label: 'Play album from here',
                run: () => onAction('PLAY_FROM_HERE', node.id)
              }
            ]
          : []),
        { label: 'Save to preset…', run: onSavePreset }
      ]

  usePopoverChrome(onClose)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pos = useClampedPosition(boxRef, menu.x, menu.y)

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={onClose} />
      <div
        ref={boxRef}
        className="fixed z-50 w-52 rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-1.5 space-y-0.5"
        style={pos}
      >
        <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint truncate">{node.title}</div>
        {items.map((item) => (
          <button
            key={item.label}
            onClick={item.run}
            className="w-full px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim hover:text-ink hover:bg-veil transition-colors"
          >
            {item.label}
          </button>
        ))}
      </div>
    </>,
    document.body
  )
}

// -------------------------------------------------------------- preset picker

function PresetPicker({
  picker,
  onClose,
  onSave
}: {
  picker: { node: MediaNode; x: number; y: number }
  onClose(): void
  onSave(slot: number): void
}): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  const occupied = new Map<number, string | null>()
  for (const p of presets?.presets ?? []) {
    if (p.id != null) occupied.set(p.id, p.art_url)
  }
  let nextFree = 1
  while (occupied.has(nextFree) && nextFree < 99) nextFree++
  const slotCount = Math.max(24, Math.min(99, (Math.max(0, ...occupied.keys()) ?? 0) + 6))
  const [confirmSlot, setConfirmSlot] = useState<number | null>(null)
  usePopoverChrome(onClose)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pos = useClampedPosition(boxRef, picker.x, picker.y)

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={boxRef}
        className="fixed z-50 w-[264px] rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-3 space-y-2.5"
        style={pos}
      >
        <div className="text-[11px] text-faint truncate">{picker.node.title}</div>
        <button
          onClick={() => onSave(nextFree)}
          className="w-full px-3 py-2 rounded-lg bg-amber text-bg text-[13px] font-medium motion-safe:active:scale-95 transition-all"
          data-preset-save-primary
        >
          Save to preset {nextFree}
        </button>
        <div className="grid grid-cols-6 gap-1.5 max-h-[168px] overflow-y-auto">
          {Array.from({ length: slotCount }, (_, i) => i + 1).map((slot) => {
            const art = occupied.get(slot)
            const taken = occupied.has(slot)
            const confirming = confirmSlot === slot
            return (
              <button
                key={slot}
                onClick={() => {
                  if (!taken) return onSave(slot)
                  if (confirming) return onSave(slot)
                  setConfirmSlot(slot)
                }}
                data-tip={taken ? `Overwrite preset ${slot}` : `Preset ${slot}`}
                className={cx(
                  'relative aspect-square rounded-md overflow-hidden ring-1 flex items-center justify-center text-[10.5px] font-mono transition-all',
                  confirming
                    ? 'ring-alert bg-alert text-white'
                    : taken
                      ? 'ring-edge2 bg-panel text-dim hover:ring-alert/60'
                      : 'ring-edge bg-panel/60 text-faint hover:text-ink hover:ring-edge2'
                )}
              >
                {confirming ? (
                  'sure?'
                ) : taken && art ? (
                  <ArtImage src={art} lazy fallback={<span>{slot}</span>} />
                ) : (
                  slot
                )}
              </button>
            )
          })}
        </div>
        <div className="text-[10.5px] text-faint leading-snug">
          Occupied slots need a second click to overwrite.
        </div>
      </div>
    </>,
    document.body
  )
}
