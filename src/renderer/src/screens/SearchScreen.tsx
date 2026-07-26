import { useEffect, useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Play, Search, X } from 'lucide-react'
import type { Favorite, FavoriteMedia, MediaNode, PlaylistItem, RadioStation } from '@shared/ipc'
import { favoriteKey } from '@shared/ipc'
import { mediaKind, type MediaKind } from '@/lib/media'
import { sanitizeNavHidden } from '@/lib/screens'
import { tt } from '@/api'
import { useStore, type Screen } from '@/store'
import { EmptyState } from '@/components/EmptyState'
import { SortChip } from '@/components/SortChip'
import { MediaRow } from '@/components/MediaRow'
import { StationRow } from '@/components/StationRow'
import { RowMenu } from '@/components/RowMenu'
import { AddToPlaylistPanel } from '@/components/AddToPlaylistPanel'
import { PresetPicker } from '@/components/LibraryMenus'
import { favoriteAct, toggleFavorite } from '@/lib/favorites'
import { activatePlaylist } from '@/lib/playlists'
import { fromFavorite, fromNode, refToFavorite, refToPlaylistItem, type MediaRef } from '@/lib/mediaRef'
import { saveRefToPreset } from '@/lib/mediaActions'
import {
  albumMenuItems,
  artistMenuItems,
  trackMenuItems,
  type MediaMenuItem
} from '@/lib/mediaMenus'
import { RowAction } from '@/components/RowAction'
import { RowHeart } from '@/components/RowHeart'
import { Segmented } from '@/components/Segmented'
import { playStation, playingStationName } from '@/lib/radio'
import { useStationTuning } from '@/hooks/useStationTuning'
import { cx, matchesFilter } from '@/lib/format'

/** Radio is a network call — same debounce the Radio screen uses. */
const RADIO_DEBOUNCE_MS = 350
/** Below this, a query matches half the library and every station on earth. */
const MIN_RADIO_CHARS = 2
/** Per group while several are showing — five groups of everything is a wall. */
const GROUP_CAP = 6
/** Narrowed to ONE category, it owns the screen and can show far more. */
const ISOLATED_CAP = 50

type CategoryId = 'library' | 'favorites' | 'playlists' | 'presets' | 'radio'
/** Every category id is also a nav screen id — that 1:1 is what lets the rail
 *  seed the search rail (see hiddenSeeded). */
const CATEGORY_IDS: CategoryId[] = ['library', 'favorites', 'playlists', 'presets', 'radio']

/**
 * Only two sorts GENERALIZE across five heterogeneous groups.
 *
 * 'relevance' is each source's own ranking (the index's for library, most-
 * listened for the directory, recency for the local collections) and is the
 * neutral, non-reversible default — same contract as the library results chip.
 * Name is the one field every result has. Artist and year are library-shaped;
 * a playlist, a preset and a station have neither, and date-added is
 * favorites-shaped. Those sorts live on the owning screens, which have them.
 */
const SEARCH_SORTS: Array<{ value: 'relevance' | 'name'; label: string; noReverse?: boolean }> = [
  { value: 'relevance', label: 'Relevance', noReverse: true },
  { value: 'name', label: 'Name' }
]

/**
 * The session's last query — module scope, like the library's scroll and
 * find-recall memories. Coming back to Search mid-thought should show what you
 * were looking for, and this is never a setting.
 */
let lastQuery = ''
/** Hidden categories, and the sort — session-only like the query above. */
let lastHidden = new Set<CategoryId>()
/**
 * Seeded ONCE per session from navHidden. A row you've hidden from the rail is
 * a row you've said you don't use, so search starts without it — but only as a
 * DEFAULT: the chip is still there, still counted, one click from coming back.
 * `navHidden` has never meant "disabled" (a hidden screen keeps its shortcut,
 * its palette entry and its Go-menu item) and this doesn't change that.
 * Changing the setting mid-session won't re-seed; the chips are the live control.
 */
let hiddenSeeded = false
let lastSort: 'relevance' | 'name' = 'relevance'
let lastSortReversed = false

/**
 * Unified search: one box over library, favorites, playlists, presets and
 * internet radio.
 *
 * ADDITIVE — every per-screen search stays. Those answer "find within what I'm
 * doing"; this answers "find it when I don't know where it is". That's also why
 * ⌘F is contextual (see useShortcuts): inside the Library it still opens the
 * Library's own search, which has scoping and find-recall this screen doesn't
 * replicate.
 *
 * THE CLICK CONTRACT MATCHES THE REST OF THE APP: leaves play, containers open.
 * A track plays, an album opens in the Library, a playlist opens on the
 * Playlists screen, a station plays, and a preset recalls — a preset having no
 * inside, recall IS its open.
 *
 * LATENCY: the four local groups answer from memory and render on the
 * keystroke; radio is the only network call, so it streams in under its own
 * pending state and can fail on its own without touching the rest.
 *
 * NOT INCLUDED: queue, and recently-played. Recents was asked for and turned
 * down for a concrete reason — the Recently Played screen has no play action at
 * all (it's a read-only log), so its results would be the only ones you
 * couldn't act on. Revisit if that screen gains one.
 */
export function SearchScreen(): React.JSX.Element {
  const [query, setQuery] = useState(lastQuery)
  const navHidden = useStore((s) => s.settings.navHidden)
  const [hidden, setHidden] = useState<Set<CategoryId>>(() => {
    if (!hiddenSeeded) {
      hiddenSeeded = true
      const ids = new Set<string>(CATEGORY_IDS)
      lastHidden = new Set(
        sanitizeNavHidden(navHidden).filter((id): id is CategoryId => ids.has(id))
      )
    }
    return lastHidden
  })
  const [sort, setSort] = useState(lastSort)
  const [sortReversed, setSortReversed] = useState(lastSortReversed)
  const [libKind, setLibKind] = useState<'all' | 'artists' | 'albums' | 'tracks'>('all')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const favorites = useStore((s) => s.favorites)
  const playlists = useStore((s) => s.playlists)
  const presets = useStore((s) => s.presets?.presets ?? null)
  const connection = useStore((s) => s.connection)
  const openInLibrary = useStore((s) => s.openInLibrary)
  const requestLibrarySearch = useStore((s) => s.requestLibrarySearch)
  const mediaIndex = useStore((s) => s.mediaIndex)
  const jumpToPlaylist = useStore((s) => s.jumpToPlaylist)
  const setScreen = useStore((s) => s.setScreen)
  const setScreenFilter = useStore((s) => s.setScreenFilter)
  const showToast = useStore((s) => s.showToast)
  const connected = connection.phase === 'connected'
  // OFF is absolute — the category isn't offered at all, so there is no chip to
  // switch back on and no way to reach the directory from here. HIDDEN is the
  // softer state above it: offered, off by default, one click away.
  const radioDirectory = useStore((s) => s.settings.radioDirectory)

  useEffect(() => {
    lastQuery = query
    lastHidden = hidden
    lastSort = sort
    lastSortReversed = sortReversed
  }, [query, hidden, sort, sortReversed])

  // ⌘F / the nav / the palette all land here; the ask carries an id so a
  // request made before this mounted still focuses, and can't re-fire later.
  const searchRequest = useStore((s) => s.searchRequest)
  const clearSearchRequest = useStore((s) => s.clearSearchRequest)
  const doneReq = useRef(-1)
  /** A seeded query whose select() must wait for its VALUE to commit. */
  const selectPending = useRef<string | null>(null)
  useEffect(() => {
    const asked = searchRequest != null && doneReq.current !== searchRequest.id
    if (searchRequest) {
      doneReq.current = searchRequest.id
      // A seeded ask (the Library→Search pivot: "Search everywhere for X")
      // replaces the recalled query. Chips stay as they are — the point of a
      // pivot is seeing which collections answer, so nothing gets hidden.
      // The select happens in the [query] effect below, NOT here: selecting in
      // this effect's frame grabs the OLD value, and the seeded value's commit
      // then collapses the caret to the end — which silently killed ⌘←'s
      // just-landed navigation after a pivot.
      if (asked && searchRequest.query != null) {
        selectPending.current = searchRequest.query
        setQuery(searchRequest.query)
      }
      clearSearchRequest()
    }
    // FOCUS ON THE NEXT FRAME, never synchronously in the effect. Arriving here
    // by pressing `S` means this mount happens during that keydown, and a synchronous
    // focus hands the keystroke's own default action to the newly focused
    // input — which typed the "s" into the box (the query read "smock").
    // A frame later the keystroke is long finished.
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      // find idiom: an asked-for search arrives with the recalled query
      // selected, so typing replaces it. A plain visit leaves the caret alone.
      if (asked && selectPending.current == null) inputRef.current?.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [searchRequest, clearSearchRequest])
  // The seeded-ask select, once the value it belongs to is really in the box.
  useEffect(() => {
    if (selectPending.current == null || query !== selectPending.current) return
    selectPending.current = null
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [query])

  const q = query.trim()

  // ---- local groups: straight off the store, no awaiting anything

  const favResults = useMemo(() => {
    if (!q) return []
    return favorites.filter((f) =>
      f.kind === 'station'
        ? matchesFilter(q, [f.name])
        : matchesFilter(q, [f.title, f.artist, f.album])
    )
  }, [q, favorites])

  const playlistResults = useMemo(() => {
    // Name only. Matching a playlist by the tracks INSIDE it sounds helpful and
    // isn't: every playlist holding a common artist would answer every query.
    if (!q) return []
    return playlists.filter((p) => matchesFilter(q, [p.name]))
  }, [q, playlists])

  const presetResults = useMemo(() => {
    if (!q) return []
    return (presets ?? []).filter((p) => p.name && matchesFilter(q, [p.name]))
  }, [q, presets])

  // ---- library: index-backed, so also instant, but it crosses the IPC bridge

  const [libResults, setLibResults] = useState<MediaNode[]>([])
  const [libTotal, setLibTotal] = useState(0)
  const libSeq = useRef(0)
  useEffect(() => {
    if (!q) {
      setLibResults([])
      setLibTotal(0)
      return
    }
    const seq = ++libSeq.current
    void (async () => {
      try {
        const groups = await tt.mediaSearchAll(q)
        if (seq !== libSeq.current) return // superseded by a newer keystroke
        setLibResults(groups.flatMap((g) => g.items))
        setLibTotal(groups.reduce((n, g) => n + g.total, 0))
      } catch {
        if (seq !== libSeq.current) return
        setLibResults([])
        setLibTotal(0)
      }
    })()
  }, [q])

  // ---- radio: the one network call. Debounced, superseded, and allowed to
  // ---- fail without taking the local groups down with it.

  const [radio, setRadio] = useState<RadioStation[] | null>(null)
  const [radioPending, setRadioPending] = useState(false)
  const [radioFailed, setRadioFailed] = useState(false)
  const radioSeq = useRef(0)
  useEffect(() => {
    // Hidden means DON'T ASK. radio-browser is the only third party this screen
    // touches, and the app promises that a lookup you've turned off makes zero
    // requests — hiding the group while still querying every keystroke would
    // break that quietly. There is no separate "disable radio" setting; this
    // chip is it, and it persists for the session like the rest of the rail.
    if (!radioDirectory || hidden.has('radio') || q.length < MIN_RADIO_CHARS) {
      radioSeq.current++
      setRadio(null)
      setRadioPending(false)
      setRadioFailed(false)
      return
    }
    const seq = ++radioSeq.current
    setRadioPending(true)
    setRadioFailed(false)
    const t = setTimeout(async () => {
      try {
        const stations = await tt.radioSearch(q)
        if (seq !== radioSeq.current) return
        setRadio(stations)
      } catch {
        if (seq !== radioSeq.current) return
        setRadio(null)
        setRadioFailed(true)
      } finally {
        if (seq === radioSeq.current) setRadioPending(false)
      }
    }, RADIO_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q, hidden, radioDirectory])

  // ---- actions. Every one delegates to the same helper its own screen uses.

  const playNode = (node: MediaNode): void => {
    const udn = node.serverUdn
    if (!udn) return
    if (node.isContainer) {
      openInLibrary({
        serverUdn: udn,
        objectId: node.id,
        titlePath: [node.title],
        title: node.title,
        fromSearch: true
      })
      return
    }
    void tt.mediaQueueAdd(udn, node.id, 'PLAY_NOW')
  }

  const openFavorite = (f: Favorite): void => {
    if (f.kind === 'station') {
      void playStation({ url: f.url, name: f.name, favicon: f.favicon })
      return
    }
    const media = f as FavoriteMedia
    if (media.kind === 'album') {
      void favoriteAct(media, async (udn, id) => {
        await tt.mediaBrowse(udn, id, media.titlePath ?? [media.title])
        openInLibrary({
          serverUdn: udn,
          objectId: id,
          titlePath: media.titlePath ?? [media.title],
          title: media.title,
          fromSearch: true
        })
      })
      return
    }
    void (async () => {
      const res = await favoriteAct(media, (udn, id) => tt.mediaQueueAdd(udn, id, 'PLAY_NOW'))
      if (res === 'missing' || res === 'no-server') {
        showToast({ kind: 'error', text: `Couldn't find “${media.title}”` })
      }
    })()
  }

  // WHAT a library result is — the ONE classifier (lib/media), shared with the
  // Library's own results filter. The index returns artists, albums AND tracks,
  // and until the kind was on the row the click contract read as arbitrary: a
  // track played, an album navigated, and nothing said which was which.
  const nodeKind = (n: MediaNode): MediaKind => mediaKind(n.upnpClass, n.isContainer)
  const kindLabel = (k: MediaKind): string => k[0].toUpperCase() + k.slice(1)

  const favKeys = useMemo(() => new Set(favorites.map(favoriteKey)), [favorites])
  /** Hearted, by content key — null fav (artists, identity-less) = no heart. */
  const refFavorited = (ref: MediaRef): boolean => {
    const fav = refToFavorite(ref)
    return fav != null && favKeys.has(favoriteKey(fav as Favorite))
  }

  // ---- the ⋯ (and right-click): items built at open time from the shared
  // ---- per-entity builders, so a result's menu is the same menu the Library,
  // ---- Queue and Favorites show for the same thing
  const [rowMenu, setRowMenu] = useState<{
    title: string
    x: number
    y: number
    items: MediaMenuItem[]
  } | null>(null)
  const [playlistFor, setPlaylistFor] = useState<{
    label: string
    x: number
    y: number
    resolve(): Promise<PlaylistItem[]>
  } | null>(null)
  const [presetFor, setPresetFor] = useState<{ ref: MediaRef; x: number; y: number } | null>(null)

  const openNodeMenu = (node: MediaNode, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const ref = fromNode(node)
    const udn = node.serverUdn
    const at = { x: e.clientX, y: e.clientY }
    const queueVerb = (action: 'PLAY_NOW' | 'PLAY_NEXT' | 'APPEND' | 'REPLACE') =>
      udn ? () => void tt.mediaQueueAdd(udn, node.id, action) : undefined
    const caps = {
      playNow: queueVerb('PLAY_NOW'),
      playNext: queueVerb('PLAY_NEXT'),
      append: queueVerb('APPEND'),
      replaceQueue: queueVerb('REPLACE'),
      saveToPreset: () => setPresetFor({ ref, ...at }),
      addToPlaylist: () =>
        setPlaylistFor({
          label: node.title,
          ...at,
          resolve: async () => {
            if (!node.isContainer) return [refToPlaylistItem(ref)]
            if (!udn) return []
            // an album expands to its TRACKS — a playlist stores tracks
            const children = await tt.mediaBrowse(udn, node.id, [])
            return children.filter((c) => !c.isContainer).map((c) => refToPlaylistItem(fromNode(c, udn)))
          }
        })
    }
    const kind = nodeKind(node)
    const items =
      kind === 'artist'
        ? artistMenuItems(ref)
        : kind === 'album'
          ? albumMenuItems(ref, {
              ...caps,
              openInLibrary: () => playNode(node) // container click contract: open
            })
          : trackMenuItems(ref, caps)
    setRowMenu({ title: node.title, ...at, items })
  }

  const openFavMenu = (f: Favorite, e: React.MouseEvent): void => {
    if (f.kind === 'station') return // stations: heart + click; no menu anywhere
    const media = f as FavoriteMedia
    e.preventDefault()
    e.stopPropagation()
    const ref = fromFavorite(media)
    const at = { x: e.clientX, y: e.clientY }
    const favQueue = (action: 'PLAY_NEXT' | 'APPEND' | 'REPLACE') => () =>
      void favoriteAct(media, (udn, id) => tt.mediaQueueAdd(udn, id, action))
    const caps = {
      playNext: favQueue('PLAY_NEXT'),
      append: favQueue('APPEND'),
      replaceQueue: favQueue('REPLACE'),
      saveToPreset: () => setPresetFor({ ref, ...at }),
      addToPlaylist: () =>
        setPlaylistFor({
          label: media.title,
          ...at,
          resolve: async () => {
            if (media.kind === 'track') return [refToPlaylistItem(ref)]
            const items: PlaylistItem[] = []
            await favoriteAct(media, async (udn, id) => {
              const children = await tt.mediaBrowse(udn, id, media.titlePath ?? [media.title])
              for (const c of children)
                if (!c.isContainer) items.push(refToPlaylistItem(fromNode(c, udn)))
            })
            return items
          }
        })
    }
    setRowMenu({
      title: media.title,
      ...at,
      items:
        media.kind === 'album'
          ? albumMenuItems(ref, { ...caps, playNow: () => openFavorite(f) })
          : trackMenuItems(ref, { ...caps, playNow: () => openFavorite(f) })
    })
  }

  // Library sub-filter, offered only when the library IS the screen — the same
  // All/Artists/Albums/Tracks partition its own results screen uses.
  const libShown = useMemo(
    () =>
      libKind === 'all'
        ? libResults
        : libResults.filter((n) => `${nodeKind(n)}s` === libKind),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [libResults, libKind]
  )

  const favStationUrls = useMemo(
    () => new Set(favorites.filter((f) => f.kind === 'station').map((f) => (f as { url: string }).url)),
    [favorites]
  )

  // The library group answers from the INDEXES only; a server that isn't
  // indexed (yet, or ever) is invisible here while the Library's own search
  // still reaches it live. Silent disagreement between the two searches is
  // what erodes trust — so when that gap exists, this screen says so.
  const libUnindexed = useMemo(() => mediaIndex.filter((x) => x.state !== 'ready'), [mediaIndex])

  // Station rows light up like the Radio screen's — same audible-name match,
  // same tuning-in window, from the same shared helpers, so the row for a
  // playing stream can't be lit on one screen and dead on the other.
  const playState = useStore((s) => s.playState)
  const radioPlayingName = playingStationName(playState)
  const { tuningUrl, play: playRadio } = useStationTuning(radioPlayingName)

  // ---- The five categories, as data. Every group renders from this list, so a
  // ---- chip, a count, a cap and a sort can't disagree about what a category
  // ---- is — and the ORDER is the NAV RAIL'S (user, 2026-07-25):
  // ---- Library · Presets · Playlists · Favorites · Radio. One spatial habit
  // ---- for the whole app, so scanning results reuses the muscle memory the
  // ---- sidebar already built. Radio lands last either way, which suits the
  // ---- one group that arrives late.

  const byName = (a: { sortKey: string }, b: { sortKey: string }): number =>
    a.sortKey.localeCompare(b.sortKey)

  const cats: Array<{
    id: CategoryId
    label: string
    /** What the count MEANS: matches found, which may exceed what's listed. */
    total: number
    pending?: boolean
    /** Not asked (a hidden lookup) — show no count rather than a false zero. */
    unknown?: boolean
    rows: Array<{ key: string; sortKey: string; kind?: MediaKind; node: React.ReactNode }>
    /** Where the whole set lives, once this screen can't show more of it. */
    owner?: { screen: Screen; filterKey: 'favorites' | 'playlists' | 'presets' }
  }> = [
    {
      id: 'library',
      label: 'Library',
      total: libTotal,
      rows: libShown.map((node) => {
        const ref = fromNode(node)
        const fav = refToFavorite(ref)
        return {
          key: `${node.serverUdn}:${node.id}`,
          sortKey: node.title,
          kind: nodeKind(node),
          node: (
            <MediaRow
              title={node.title}
              subtitle={[node.artist, node.serverName].filter(Boolean).join(' — ')}
              artUrl={node.artUrl}
              kind={nodeKind(node)}
              badge={kindLabel(nodeKind(node))}
              duration={nodeKind(node) === 'track' ? node.durationSecs : undefined}
              actions={
                <>
                  {/* A container's click OPENS it, so playing needs its own
                      button; a track's click already plays. */}
                  {node.isContainer && nodeKind(node) !== 'artist' && (
                    <RowAction
                      icon={Play}
                      label={`Play ${node.title}`}
                      onClick={() => {
                        if (node.serverUdn) void tt.mediaQueueAdd(node.serverUdn, node.id, 'PLAY_NOW')
                      }}
                    />
                  )}
                  <RowAction
                    icon={MoreHorizontal}
                    label="More actions"
                    onClick={(e) => openNodeMenu(node, e)}
                  />
                  {fav && (
                    <RowHeart
                      favorited={refFavorited(ref)}
                      held={false}
                      onHeart={() => void toggleFavorite(fav)}
                    />
                  )}
                </>
              }
              onClick={() => playNode(node)}
              onContextMenu={(e) => openNodeMenu(node, e)}
            />
          )
        }
      })
    },
    {
      id: 'presets',
      label: 'Presets',
      total: presetResults.length,
      owner: { screen: 'presets', filterKey: 'presets' },
      rows: presetResults.map((p) => ({
        key: String(p.id ?? p.name),
        sortKey: p.name ?? '',
        node: (
          <MediaRow
            title={p.name ?? `Preset ${p.id}`}
            subtitle={p.type}
            artUrl={p.art_url}
            kind="preset"
            badge="Preset"
            meta={p.id != null ? `#${p.id}` : undefined}
            playing={p.is_playing === true}
            dimmed={!connected}
            onClick={() => {
              if (p.id != null) void tt.command({ type: 'recallPreset', presetId: p.id })
            }}
          />
        )
      }))
    },
    {
      id: 'playlists',
      label: 'Playlists',
      total: playlistResults.length,
      owner: { screen: 'playlists', filterKey: 'playlists' },
      rows: playlistResults.map((p) => ({
        key: p.id,
        sortKey: p.name,
        node: (
          <MediaRow
            title={p.name}
            subtitle={`${p.items.length} ${p.items.length === 1 ? 'track' : 'tracks'}`}
            kind="playlist"
            badge="Playlist"
            // never dimmed: the row's CLICK opens the playlist, which is local
            // and fine offline — only the Play action needs the streamer, and
            // activatePlaylist reports that failure itself
            actions={
              <RowAction
                icon={Play}
                label={`Play ${p.name}`}
                onClick={() => void activatePlaylist(p)}
              />
            }
            onClick={() => jumpToPlaylist(p.id)}
          />
        )
      }))
    },
    {
      id: 'favorites',
      label: 'Favorites',
      total: favResults.length,
      owner: { screen: 'favorites', filterKey: 'favorites' },
      rows: favResults.map((f) => ({
        key: favoriteKey(f),
        sortKey: f.kind === 'station' ? f.name : f.title,
        node: (
          <MediaRow
            title={f.kind === 'station' ? f.name : f.title}
            subtitle={
              f.kind === 'station'
                ? 'Station'
                : [f.artist, f.kind === 'album' ? 'Album' : f.album].filter(Boolean).join(' — ')
            }
            artUrl={f.kind === 'station' ? f.favicon : f.artUrl}
            kind={f.kind === 'station' ? 'station' : f.kind}
            badge={f.kind === 'station' ? 'Station' : f.kind === 'album' ? 'Album' : 'Track'}
            duration={f.kind === 'track' ? (f.durationSecs ?? null) : undefined}
            dimmed={!connected}
            actions={
              <>
                {f.kind !== 'station' && (
                  <RowAction
                    icon={MoreHorizontal}
                    label="More actions"
                    onClick={(e) => openFavMenu(f, e)}
                  />
                )}
                <RowHeart favorited held={false} onHeart={() => void tt.favoriteRemove(favoriteKey(f))} />
              </>
            }
            onClick={() => openFavorite(f)}
            onContextMenu={(e) => openFavMenu(f, e)}
          />
        )
      }))
    }
  ]

  // The directory setting decides whether this category EXISTS. Pushed after
  // the literal rather than filtered out of it, so "off" leaves no chip, no
  // count and no way to reach radio-browser from this screen at all.
  if (radioDirectory) {
    cats.push(
      {
        id: 'radio',
        label: 'Internet radio',
        total: radio?.length ?? 0,
        pending: radioPending,
        // Hidden and never asked: we don't KNOW the count, and printing 0 would
        // claim we looked. The chip stays live so it can be switched back on.
        unknown: hidden.has('radio') && radio === null,
        rows: (radio ?? []).map((st) => {
          const playing =
            radioPlayingName != null && st.name.trim().toLowerCase() === radioPlayingName
          return {
            key: st.uuid,
            sortKey: st.name,
            node: (
              <StationRow
                station={st}
                playing={playing}
                tuning={!playing && tuningUrl === st.url}
                favorited={favStationUrls.has(st.url)}
                onHeart={() =>
                  void toggleFavorite({
                    kind: 'station',
                    name: st.name,
                    url: st.url,
                    favicon: st.favicon,
                    radioBrowserUuid: st.uuid !== st.url ? st.uuid : null
                  })
                }
                onPlay={() => void playRadio(st)}
                // no onSave: save-to-preset belongs to the Radio screen, where
                // the panel has room — omitting the prop omits the button
              />
            )
          }
        })
      }
    )
  }

  // An empty category is never "shown" — it has nothing to show, and counting
  // it would make the isolation arithmetic wrong (chips vs one result set).
  const shownCats = cats.filter((c) => !hidden.has(c.id) && (c.total > 0 || c.pending))
  // ISOLATED = you've narrowed to one category, so it owns the screen and can
  // show far more of itself than it could as one group among five.
  const isolated = shownCats.length === 1
  const cap = isolated ? ISOLATED_CAP : GROUP_CAP
  const anyResults = shownCats.some((c) => c.rows.length > 0)
  const anyPending = shownCats.some((c) => c.pending)

  const toggleCat = (id: CategoryId): void => {
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    // Hiding the last visible category would leave a blank screen saying
    // nothing — treat that as "show everything again".
    setHidden(next.size >= cats.length ? new Set() : next)
  }

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <h1 className="font-display screen-title font-bold text-[26px] tracking-tight">Search</h1>
        <div className="relative flex-1 max-w-xl">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Just-landed after a pivot (the seeded query arrives selected):
              // ⌘← NAVIGATES back to where the pivot left — the library search
              // bar's exact rule. Once the selection collapses, ⌘-arrows are
              // ordinary text-editing keys again; the blurred-box case is
              // handled globally (useShortcuts).
              if ((e.metaKey || e.altKey) && !e.ctrlKey && e.key === 'ArrowLeft') {
                const el = e.currentTarget
                const s = useStore.getState()
                if (
                  s.searchBack &&
                  el.selectionStart === 0 &&
                  el.selectionEnd === el.value.length &&
                  el.value.length > 0
                ) {
                  e.preventDefault()
                  s.searchGoBack()
                  return
                }
              }
              if (e.key !== 'Escape') return
              // Escape clears, then LETS GO. The box takes focus on arrival and
              // screen keys are suppressed while an input has it, so without the
              // blur there is no keyboard way off this screen — you'd have to
              // reach for the mouse to press N.
              e.stopPropagation() // ...before it closes anything else
              if (query) setQuery('')
              else e.currentTarget.blur()
            }}
            placeholder="Search everything"
            aria-label="Search everything"
            data-search-input
            className="no-drag w-full bg-bg rounded-lg ring-1 ring-edge focus:ring-edge2 outline-none pl-9 pr-8 py-2 text-[13.5px] placeholder:text-faint"
          />
          {query && (
            <button
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              aria-label="Clear search"
              className="no-drag absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-faint hover:text-ink transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </header>

      {rowMenu && (
        <RowMenu
          title={rowMenu.title}
          at={{ x: rowMenu.x, y: rowMenu.y }}
          onClose={() => setRowMenu(null)}
          items={rowMenu.items}
        />
      )}
      {playlistFor && (
        <AddToPlaylistPanel
          label={playlistFor.label}
          at={{ x: playlistFor.x, y: playlistFor.y }}
          onClose={() => setPlaylistFor(null)}
          resolve={playlistFor.resolve}
        />
      )}
      {presetFor && (
        <PresetPicker
          picker={{ node: { title: presetFor.ref.title }, x: presetFor.x, y: presetFor.y }}
          onClose={() => setPresetFor(null)}
          onSave={async (slot, name) => {
            await saveRefToPreset(presetFor.ref, slot, name)
            setPresetFor(null)
          }}
        />
      )}

      {/* The category rail: what was searched, how much each holds, and which
          are showing. Counts are the POINT — a category with 0 still gets a
          chip, because "we looked and found nothing" is an answer and its
          absence would read as "we didn't look". */}
      {q && (
        <div className="no-drag flex items-center gap-1.5 flex-wrap px-8 pb-3">
          {/* The library is the only category with KINDS inside it (the index
              answers artists, albums and tracks). Its partition appears once
              the library is the screen — same All/Artists/Albums/Tracks
              Segmented its own results use, and a partition is single-select
              by the app's rule, unlike the multi-select category chips. */}
          {isolated && shownCats[0]?.id === 'library' && (
            <Segmented<'all' | 'artists' | 'albums' | 'tracks'>
              value={libKind}
              onChange={setLibKind}
              options={[
                { value: 'all', label: 'All' },
                { value: 'artists', label: 'Artists' },
                { value: 'albums', label: 'Albums' },
                { value: 'tracks', label: 'Tracks' }
              ]}
            />
          )}
          {cats.map((c) => {
            // THREE states, not two: matched-and-showing, matched-and-hidden,
            // and NOTHING TO SHOW. The third is disabled rather than merely
            // unlit — a chip you can toggle to no effect is a lie about what
            // is behind it. It still renders, because "we looked here and
            // found nothing" is the answer it exists to give.
            const empty = c.total === 0 && !c.pending && !c.unknown
            const on = !hidden.has(c.id) && !empty
            return (
              <button
                key={c.id}
                data-search-chip={c.id}
                data-on={on}
                data-empty={empty || undefined}
                onClick={() => !empty && toggleCat(c.id)}
                disabled={empty}
                aria-pressed={on}
                title={empty ? `No ${c.label.toLowerCase()} matches` : undefined}
                className={cx(
                  'rounded-full px-3 py-1 text-[12px] ring-1 transition-all',
                  empty
                    ? 'ring-edge/60 bg-panel/40 text-faint/50 cursor-default'
                    : on
                      ? 'ring-gold/50 bg-golddim text-gold motion-safe:active:scale-95'
                      : 'ring-edge bg-panel/60 text-faint hover:text-dim hover:ring-edge2 motion-safe:active:scale-95'
                )}
              >
                {c.label}{' '}
                <span className="tabular-nums opacity-70">
                  {c.pending ? '…' : c.unknown ? '—' : c.total}
                </span>
              </button>
            )
          })}
          <div className="flex-1" />
          {/* Only two sorts generalize across five heterogeneous groups: each
              source's own ranking, and A–Z. Artist/year are library-shaped and
              date-added is favorites-shaped — those live on the owning screens,
              which already sort by them. */}
          <SortChip
            sorts={SEARCH_SORTS}
            neutral="relevance"
            value={sort}
            reversed={sortReversed}
            onChange={(v) => {
              setSort(v)
              setSortReversed(false)
            }}
            onToggleReverse={() => setSortReversed((r) => !r)}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-8 pb-10 pt-1">
        {!q ? (
          // Centered: with no query there is nothing else on the screen, and a
          // block hugging the top of an empty page reads as a loading state.
          <div className="h-full flex items-center justify-center">
            <EmptyState
              icon={Search}
              title="Search everything"
              caption="Your library, favorites, playlists, presets and internet radio — all at once. Press S from anywhere, or ⇧⌘F even inside the Library (whose own ⌘F search digs deeper there)."
            />
          </div>
        ) : (
          <div className="max-w-2xl space-y-6">
            {!anyResults && !anyPending && (
              <EmptyState
                icon={Search}
                title={`Nothing found for “${q}”`}
                caption={
                  hidden.size > 0
                    ? 'Some categories are hidden — try showing them again.'
                    : 'Try fewer words.'
                }
              />
            )}

            {shownCats.map((c) => {
              if (c.rows.length === 0 && !c.pending && !(c.id === 'radio' && radioFailed)) return null
              const rows = sort === 'name' ? [...c.rows].sort(byName) : c.rows
              const ordered = sortReversed ? [...rows].reverse() : rows
              const more = c.total - Math.min(ordered.length, cap)
              return (
                <section key={c.id} className="space-y-1.5">
                  <div className="flex items-baseline gap-2 px-1">
                    {/* the CATEGORY heading — tagged so it can't be confused
                        with the kind sub-headings below it, which share the
                        microlabel look */}
                    <span data-search-group={c.id} className="microlabel">
                      {c.label}
                    </span>
                    <span className="text-[11px] text-faint tabular-nums">{c.total}</span>
                    {c.pending && (
                      <span className="text-[11px] text-faint motion-safe:animate-pulse">
                        searching…
                      </span>
                    )}
                    <div className="flex-1" />
                    {more > 0 &&
                      (isolated ? (
                        // Already the whole screen and STILL more — the rest
                        // lives on the owning screen, which has the room and
                        // the sorting for it.
                        c.owner ? (
                          <button
                            data-search-more={c.id}
                            onClick={() => {
                              setScreenFilter(c.owner!.filterKey, q)
                              setScreen(c.owner!.screen)
                            }}
                            className="text-[11.5px] text-amber hover:brightness-110 transition-all"
                          >
                            See all {c.total} in {c.label} →
                          </button>
                        ) : c.id === 'library' ? (
                          // The library's deeper tool IS its own search —
                          // complete results, four sorts, live reach into
                          // unindexed servers. Handing the query over (rather
                          // than dead-ending at "narrow the search") is what
                          // teaches the two-tier model: Search skims, the
                          // Library digs.
                          <button
                            data-search-more={c.id}
                            onClick={() => requestLibrarySearch(q)}
                            className="text-[11.5px] text-amber hover:brightness-110 transition-all"
                          >
                            See all {c.total} in the Library →
                          </button>
                        ) : (
                          <span className="text-[11.5px] text-faint">
                            +{more} more — narrow the search
                          </span>
                        )
                      ) : (
                        // Not isolated: showing more of THIS is the obvious
                        // meaning of the click, and it keeps you on the screen.
                        <button
                          data-search-more={c.id}
                          onClick={() => setHidden(new Set(cats.filter((x) => x.id !== c.id).map((x) => x.id)))}
                          className="text-[11.5px] text-amber hover:brightness-110 transition-all"
                        >
                          +{more} more →
                        </button>
                      ))}
                  </div>
                  {c.id === 'radio' && radioFailed && (
                    <div className="text-[12.5px] text-faint">
                      Couldn&rsquo;t reach the station directory. Everything above is local and
                      unaffected.
                    </div>
                  )}
                  {/* SECTIONED BY KIND once the library owns the screen. The
                      taxonomy is closed at three (lib/media), and the Library's
                      own results already read artists → albums → tracks — the
                      hierarchy order, artists make albums, albums contain
                      tracks. Mixed into one list it read as an unsorted jumble:
                      the order was always artists→albums→tracks, but nothing
                      said so. Headings ALWAYS (user, 2026-07-25) — six rows
                      split three ways still beats six rows that look shuffled. */}
                  {c.id === 'library'
                    ? (['artist', 'album', 'track'] as const).map((k) => {
                        const inKind = ordered.slice(0, cap).filter((r) => r.kind === k)
                        if (inKind.length === 0) return null
                        return (
                          <div key={k} className="space-y-1.5">
                            <div className="microlabel pt-2 px-1 opacity-70">
                              {k === 'artist' ? 'Artists' : k === 'album' ? 'Albums' : 'Tracks'}{' '}
                              <span className="tabular-nums">{inKind.length}</span>
                            </div>
                            {inKind.map((r) => (
                              <div key={r.key}>{r.node}</div>
                            ))}
                          </div>
                        )
                      })
                    : ordered.slice(0, cap).map((r) => <div key={r.key}>{r.node}</div>)}
                </section>
              )
            })}

            {/* The coverage confession — deliberately OUTSIDE the sections, so
                it still shows when the library group found nothing precisely
                BECAUSE the content lives on an unindexed server. */}
            {libUnindexed.length > 0 && !hidden.has('library') && (
              <div data-search-unindexed className="flex items-baseline gap-2 text-[12px] text-faint">
                <span className="min-w-0">
                  {libUnindexed.length === 1
                    ? `${libUnindexed[0].serverName} isn't in the search index`
                    : `${libUnindexed.length} media servers aren't in the search index`}
                  {' — the Library’s own search reaches unindexed servers live.'}
                </span>
                <button
                  onClick={() => requestLibrarySearch(q)}
                  className="shrink-0 text-amber hover:brightness-110 transition-all"
                >
                  Search the Library →
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
