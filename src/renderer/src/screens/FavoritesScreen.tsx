import { useEffect, useMemo, useRef, useState } from 'react'
import { Heart, Loader2, MoreHorizontal, Play } from 'lucide-react'
import { type MediaNode, type MediaQueueAction, type MediaServerInfo } from '@shared/model'
import {
  favoriteKey,
  type Favorite,
  type FavoriteMedia,
  type FavoriteStation,
  type PlaylistItem
} from '@shared/model'
import { isRadioMetadata, type QueueListItem } from '@shared/smoip'
import { tt } from '@/api'
import { useStore } from '@/store'
import { RowAction } from '@/components/media/RowAction'
import { RowHeart } from '@/components/media/RowHeart'
import { MediaRow } from '@/components/media/MediaRow'
import { ContainerCard } from '@/components/library/LibraryCards'
import { AddToPlaylistPanel } from '@/components/overlays/AddToPlaylistPanel'
import { PresetPicker } from '@/components/library/LibraryMenus'
import { fromFavorite, fromNode, refToPlaylistItem } from '@/lib/mediaRef'
import { recordPresetSaved } from '@/lib/mediaActions'
import { albumMenuItems, trackMenuItems } from '@/lib/mediaMenus'
import { EmptyState } from '@/components/chrome/EmptyState'
import { FilterInput } from '@/components/controls/FilterInput'
import { Segmented } from '@/components/controls/Segmented'
import { RowMenu } from '@/components/media/RowMenu'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { activeSourceId, cx, matchesFilter } from '@/lib/format'
import { favoriteAct, favoriteHasRoute, type FavoriteActResult } from '@/lib/favorites'
import { flashTarget } from '@/lib/scroll'
import { ScreenTitle } from '@/components/chrome/Chrome'

/** Kind visibility — session memory, like the Radio screen's chip state. */
type FavKind = 'all' | 'station' | 'album' | 'track'
const FAV_KINDS: readonly FavKind[] = ['all', 'station', 'album', 'track']

/**
 * Favorites: the local cross-source collection — radio stations, albums, and
 * tracks hearted anywhere in the app. Grouped by kind (the search-results
 * idiom: albums render as media cards, stations/tracks as rows), with a
 * kind switch for collections too big to scan. Un-hearting here is SOFT:
 * the item stays for the session (dimmed, hollow heart — one click undoes
 * an accident) and is gone on the next visit.
 */
export function FavoritesScreen(): React.JSX.Element {
  const favorites = useStore((s) => s.favorites)
  const filter = useStore((s) => s.screenFilters.favorites)
  const setScreenFilter = useStore((s) => s.setScreenFilter)
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const zoneState = useStore((s) => s.zoneState)
  const queue = useStore((s) => s.queue)
  const connected = useStore((s) => s.connection.phase === 'connected')
  const { presetCardSize, presetGap, presetFillRows } = useStore((s) => s.settings)
  const openInLibrary = useStore((s) => s.openInLibrary)
  const setLastStation = useStore((s) => s.setLastStation)
  const showToast = useStore((s) => s.showToast)
  const scrollRef = useScrollMemory('favorites')

  // Soft removal: what's displayed is the list AS ENTERED (plus anything
  // hearted while here); the live list only decides each item's heart state.
  const entered = useRef<Favorite[] | null>(null)
  if (entered.current === null) entered.current = favorites
  const activeKeys = useMemo(() => new Set(favorites.map(favoriteKey)), [favorites])
  const displayed = useMemo(() => {
    const base = entered.current ?? []
    const baseKeys = new Set(base.map(favoriteKey))
    return [...favorites.filter((f) => !baseKeys.has(favoriteKey(f))), ...base]
  }, [favorites])

  // Media servers decide whether album/track favorites have a play route.
  // null = NOT YET KNOWN — favorites stay bright on a guess, never dimmed
  // (the old []-initial state flashed "server is offline" on every visit
  // while the streamer answered /system/upnp, and a single transient fetch
  // failure stuck the false "offline" for the whole visit — user report).
  // A failed fetch retries twice before offline is ever declared.
  const [servers, setServers] = useState<MediaServerInfo[] | null>(null)
  useEffect(() => {
    if (!connected) {
      setServers(null)
      return
    }
    let stale = false
    const attempt = (n: number): void => {
      void tt
        .mediaServers()
        .then((list) => {
          if (!stale) setServers(list)
        })
        .catch(() => {
          if (stale) return
          if (n < 2) setTimeout(() => attempt(n + 1), 700 * (n + 1))
          else setServers([])
        })
    }
    attempt(0)
    return () => {
      stale = true
    }
  }, [connected])

  // View default, persisted (2026-08-06); sanitized on use so a hand-edited
  // settings file can't blank every section.
  const storedKind = useStore((s) => s.settings.favoritesKind)
  const kind: FavKind = FAV_KINDS.includes(storedKind) ? storedKind : 'all'
  const saveSettings = useStore((s) => s.saveSettings)
  const setKind = (k: FavKind): void => {
    void saveSettings({ favoritesKind: k })
  }
  const stations = displayed.filter((f): f is FavoriteStation => f.kind === 'station')
  const albums = displayed.filter((f): f is FavoriteMedia => f.kind === 'album')
  const tracks = displayed.filter((f): f is FavoriteMedia => f.kind === 'track')
  const match = (f: Favorite): boolean =>
    matchesFilter(
      filter,
      f.kind === 'station' ? [f.name] : [f.title, f.artist, f.album, f.serverName]
    )
  const kindShown = (k: Exclude<FavKind, 'all'>): boolean => kind === 'all' || kind === k
  const shownStations = kindShown('station') ? stations.filter(match) : []
  const shownAlbums = kindShown('album') ? albums.filter(match) : []
  const shownTracks = kindShown('track') ? tracks.filter(match) : []
  const shownCount = shownStations.length + shownAlbums.length + shownTracks.length
  const kindTotal =
    (kindShown('station') ? stations.length : 0) +
    (kindShown('album') ? albums.length : 0) +
    (kindShown('track') ? tracks.length : 0)

  // ---------------------------------------------------------------- stations

  const md = playState?.metadata
  const playingStation =
    isRadioMetadata(md) && (playState?.state === 'play' || playState?.state === 'buffering')
      ? (md?.station ?? md?.name)?.trim().toLowerCase()
      : null
  const [tuning, setTuning] = useState<string | null>(null) // station url
  const tuningTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playStation = async (st: FavoriteStation): Promise<void> => {
    setLastStation({ url: st.url, name: st.name, favicon: st.favicon, radioBrowserUuid: st.radioBrowserUuid })
    setTuning(st.url)
    if (tuningTimeout.current) clearTimeout(tuningTimeout.current)
    tuningTimeout.current = setTimeout(() => setTuning(null), 15_000)
    try {
      await tt.command({ type: 'streamRadio', url: st.url, name: st.name })
    } catch {
      setTuning(null) // failure is toasted by the api layer
    }
  }
  useEffect(() => {
    if (tuning && stations.some((s) => s.url === tuning && s.name.trim().toLowerCase() === playingStation))
      setTuning(null)
  }, [tuning, playingStation, stations])
  useEffect(
    () => () => {
      if (tuningTimeout.current) clearTimeout(tuningTimeout.current)
    },
    []
  )

  // ------------------------------------------------------------------- media

  const queueSourceActive = activeSourceId(zoneState, nowPlaying) === 'MEDIA_PLAYER'
  const albumPlaying = (f: FavoriteMedia): boolean =>
    queueSourceActive &&
    md != null &&
    md.album === f.title &&
    (f.artist == null || md.artist == null || md.artist === f.artist)
  const trackPlaying = (f: FavoriteMedia): boolean =>
    queueSourceActive &&
    md != null &&
    md.title === f.title &&
    (f.artist == null || md.artist == null || md.artist === f.artist)

  const reportAct = (f: FavoriteMedia, res: FavoriteActResult): void => {
    if (res === 'missing')
      showToast({ kind: 'error', text: `Couldn't find “${f.title}” in the library.` })
    if (res === 'no-server')
      showToast({ kind: 'error', text: 'No media servers are available right now.' })
  }

  const [busyKey, setBusyKey] = useState<string | null>(null)
  const act = async (
    f: FavoriteMedia,
    el: HTMLElement | null,
    run: (serverUdn: string, objectId: string) => Promise<void>
  ): Promise<void> => {
    const key = favoriteKey(f)
    setBusyKey(key)
    try {
      const res = await favoriteAct(f, run)
      reportAct(f, res)
      if ((res === 'ok' || res === 'healed') && el) flashTarget(el)
    } finally {
      setBusyKey((cur) => (cur === key ? null : cur))
    }
  }

  /** Album "Play": replace the queue and start at the first track. */
  const playAlbum = (f: FavoriteMedia, el: HTMLElement | null): void =>
    void act(f, el, async (udn, id) => {
      const children = await tt.mediaBrowse(udn, id, f.titlePath ?? [f.title])
      const first = children.find((c) => !c.isContainer)
      if (first) await tt.mediaQueueAdd(udn, id, 'PLAY_FROM_HERE', first.id)
      else await tt.mediaQueueAdd(udn, id, 'REPLACE')
    })

  const queueAction = (f: FavoriteMedia, action: MediaQueueAction, el: HTMLElement | null): void =>
    void act(f, el, (udn, id) => tt.mediaQueueAdd(udn, id, action))

  /** Queue entries content-matching a track favorite (shared by the play
   *  path and the play button's queue-aware tooltip). */
  const favQueueMatches = (f: FavoriteMedia): QueueListItem[] =>
    (queue?.items ?? []).filter((i) => {
      const m = i.metadata
      return (
        m?.title === f.title &&
        (f.artist == null || m?.artist == null || m.artist === f.artist) &&
        (f.album == null || m?.album == null || m.album === f.album)
      )
    })

  /** Bare track click, queue-aware like the Library: jump if already queued. */
  const playTrack = (f: FavoriteMedia, el: HTMLElement | null): void => {
    const items = queue?.items ?? []
    const matches = favQueueMatches(f)
    if (matches.length > 0) {
      const playId = queue?.play_id ?? playState?.queue_id ?? null
      const curIdx = items.findIndex((i) => i.id === playId)
      const target = matches.find((mi) => items.indexOf(mi) >= curIdx) ?? matches[0]
      void tt.command({ type: 'playQueueId', queueId: target.id as number })
      if (el) flashTarget(el)
      return
    }
    queueAction(f, 'PLAY_NOW', el)
  }

  /** Album card click: open it in the Library (validated + healed route). */
  const enterAlbum = (f: FavoriteMedia): void =>
    void act(f, null, async (udn, id) => {
      await tt.mediaBrowse(udn, id, f.titlePath ?? [f.title])
      openInLibrary({
        serverUdn: udn,
        objectId: id,
        titlePath: f.titlePath ?? [f.title],
        title: f.title
      })
    })

  const unheart = (f: Favorite): void => void tt.favoriteRemove(favoriteKey(f))
  /**
   * Re-hearting on THIS screen is an undo, not a fresh heart — soft removal
   * leaves the row sitting there with an empty heart precisely so a misclick
   * costs one click back. So it keeps the ORIGINAL addedAt: stamping Date.now()
   * (as this did) silently moved the row to the top of a newest-first list, and
   * you'd only find out next time you opened the screen. Hearting from anywhere
   * else in the app is a genuine add and still stamps now.
   *
   * This is also why there's no undo toast here: the reversal affordance never
   * left the screen. Toasts are for removals that take their own undo with them
   * (a playlist track, a whole playlist).
   */
  const reheart = (f: Favorite): void => void tt.favoriteAdd(f)
  const toggleHeart = (f: Favorite): void =>
    activeKeys.has(favoriteKey(f)) ? unheart(f) : reheart(f)

  // ------------------------------------------------------------------- menus

  const [menu, setMenu] = useState<{ fav: FavoriteMedia; x: number; y: number } | null>(null)
  const [playlistFor, setPlaylistFor] = useState<{ fav: FavoriteMedia; x: number; y: number } | null>(
    null
  )
  const [presetFor, setPresetFor] = useState<{ fav: FavoriteMedia; x: number; y: number } | null>(
    null
  )

  /** A favorite's items for the playlist panel: tracks map straight over; an
   *  album expands to its tracks through the same favoriteAct resolution
   *  (heals rotted ids) playing it uses. */
  const resolvePlaylistItems = async (f: FavoriteMedia): Promise<PlaylistItem[]> => {
    if (f.kind === 'track') return [refToPlaylistItem(fromFavorite(f))]
    const items: PlaylistItem[] = []
    await favoriteAct(f, async (udn, id) => {
      const children = await tt.mediaBrowse(udn, id, f.titlePath ?? [f.title])
      for (const c of children) if (!c.isContainer) items.push(refToPlaylistItem(fromNode(c, udn)))
    })
    return items
  }

  /** Save through favoriteAct (album-capable, heals) then the shared preset
   *  bookkeeping. Throws on failure so the panel stays open. */
  const savePresetFor = async (f: FavoriteMedia, slot: number, name: string | null): Promise<void> => {
    const res = await favoriteAct(f, (udn, id) => tt.mediaPresetSave(udn, id, slot))
    if (res === 'missing' || res === 'no-server') {
      showToast({ kind: 'error', text: `Couldn't find “${f.title}” to save` })
      throw new Error('preset save failed')
    }
    await recordPresetSaved(fromFavorite(f), slot, name)
  }
  const openMenu = (fav: FavoriteMedia, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ fav, x: e.clientX, y: e.clientY })
  }

  /** Adapter: a media favorite rendered through the Library's card component. */
  const asNode = (f: FavoriteMedia): MediaNode => ({
    id: f.objectId ?? favoriteKey(f),
    parentId: null,
    title: f.title,
    upnpClass: 'object.container.album.musicAlbum',
    isContainer: true,
    artUrl: f.artUrl,
    artist: f.artist,
    album: null,
    year: null,
    trackNumber: null,
    durationSecs: null
  })

  const total = displayed.length

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-3 px-8 pt-8 pb-4">
        <ScreenTitle>Favorites</ScreenTitle>
        <div className="flex-1" />
        {total > 0 && (
          <>
            <Segmented
              value={kind}
              onChange={setKind}
              options={[
                { value: 'all' as const, label: 'All' },
                { value: 'station' as const, label: 'Stations' },
                { value: 'album' as const, label: 'Albums' },
                { value: 'track' as const, label: 'Tracks' }
              ]}
            />
            <FilterInput
              value={filter}
              onChange={(text) => setScreenFilter('favorites', text)}
              shown={shownCount}
              total={kindTotal}
            />
          </>
        )}
      </header>

      {total === 0 ? (
        <EmptyState
          icon={Heart}
          title="Nothing favorited yet"
          caption="Heart albums and tracks in the Library, stations on the Radio screen, or whatever's playing on Now Playing — they all gather here."
        />
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 pb-8 pt-1">
          {shownCount === 0 && (
            <div className="text-[15px] text-faint pt-4 px-1">
              {filter
                ? `No matches for “${filter}”`
                : `No ${kind === 'station' ? 'Stations' : kind === 'album' ? 'Albums' : 'Tracks'} favorited yet.`}
            </div>
          )}

          {shownStations.length > 0 && (
            <>
              <div className="microlabel mt-2 mb-2 px-1">Stations</div>
              <div className="space-y-1.5 max-w-2xl">
                {shownStations.map((st) => {
                  const active = activeKeys.has(favoriteKey(st))
                  const playing = playingStation != null && st.name.trim().toLowerCase() === playingStation
                  return (
                    <StationFavRow
                      key={st.url}
                      station={st}
                      active={active}
                      playing={playing}
                      tuning={!playing && tuning === st.url}
                      onPlay={() => void playStation(st)}
                      onHeart={() => toggleHeart(st)}
                    />
                  )
                })}
              </div>
            </>
          )}

          {shownAlbums.length > 0 && (
            <>
              <div className="microlabel mt-5 mb-1 px-1">Albums</div>
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
                {shownAlbums.map((f) => {
                  const key = favoriteKey(f)
                  const active = activeKeys.has(key)
                  const routed = servers == null || favoriteHasRoute(f, servers)
                  return (
                    <div
                      key={key}
                      data-fav-album={f.title}
                      className={cx('relative', (!active || !routed) && 'opacity-50')}
                    >
                      {/* heart rides INSIDE the card (favorited/onHeart) so it
                          zooms and lifts with the hover animation */}
                      <ContainerCard
                        node={asNode(f)}
                        playing={albumPlaying(f)}
                        menuOpen={menu?.fav === f}
                        favorited={active}
                        onHeart={() => toggleHeart(f)}
                        onEnter={() => routed && enterAlbum(f)}
                        onPlay={(el) => routed && playAlbum(f, el)}
                        onMenu={(e) => openMenu(f, e)}
                      />
                      {busyKey === key && (
                        <Loader2 size={13} className="spin text-gold/80 absolute top-3.5 left-3.5 z-10" />
                      )}
                      {!routed && f.serverName && (
                        <div className="px-2 pt-0.5 text-[10.5px] text-faint truncate">
                          {f.serverName} is offline
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {shownTracks.length > 0 && (
            <>
              <div className="microlabel mt-5 mb-2 px-1">Tracks</div>
              <div className="space-y-1.5 max-w-2xl">
                {shownTracks.map((f) => {
                  const key = favoriteKey(f)
                  const active = activeKeys.has(key)
                  const routed = servers == null || favoriteHasRoute(f, servers)
                  return (
                    // MediaRow's reserved duration column is what keeps every
                    // heart on one vertical line — a track with no captured
                    // length shows '–:––' instead of letting the heart drift
                    <MediaRow
                      key={key}
                      attrs={{ 'data-fav-track': f.title }}
                      title={f.title}
                      kind="track"
                      artUrl={f.artUrl}
                      subtitle={
                        [
                          [f.artist, f.album].filter(Boolean).join(' — '),
                          !routed && f.serverName ? `${f.serverName} is offline` : ''
                        ]
                          .filter(Boolean)
                          .join(' · ') || undefined
                      }
                      playing={trackPlaying(f)}
                      dimmed={!active || !routed}
                      duration={f.durationSecs ?? null}
                      onClick={(el) => playTrack(f, el)}
                      onContextMenu={(e) => openMenu(f, e)}
                      actions={
                        <>
                          {routed && active && (
                            <>
                              <RowAction
                                icon={Play}
                                label="Play"
                                tip={
                                  favQueueMatches(f).length > 0
                                    ? 'Play — already in the queue'
                                    : 'Play now — slots in after the current track'
                                }
                                pinned={menu?.fav === f}
                                onClick={(e: React.MouseEvent) =>
                                  playTrack(
                                    f,
                                    (e.currentTarget as HTMLElement).closest(
                                      '[data-fav-track]'
                                    ) as HTMLElement
                                  )
                                }
                              />
                              <RowAction
                                icon={MoreHorizontal}
                                label="More actions"
                                pinned={menu?.fav === f}
                                onClick={(e) => openMenu(f, e)}
                              />
                            </>
                          )}
                          {busyKey === key && (
                            <Loader2 size={13} className="spin text-gold/80 shrink-0" />
                          )}
                          {/* held: on THIS screen the heart is the state marker,
                              so it stays visible even unset (soft removal keeps
                              the row; the hollow heart is the one-click undo) */}
                          <RowHeart favorited={active} held onHeart={() => toggleHeart(f)} />
                        </>
                      }
                    />
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

      {menu && (
        <RowMenu
          title={menu.fav.title}
          at={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          // The shared per-entity builders (lib/mediaMenus): a favorite's menu
          // is now the same track/album menu as everywhere else — including
          // the playlist, preset and search-everywhere verbs this screen
          // never offered before the consistency pass.
          items={(() => {
            const shared = {
              playNext: () => queueAction(menu.fav, 'PLAY_NEXT' as MediaQueueAction, null),
              append: () => queueAction(menu.fav, 'APPEND' as MediaQueueAction, null),
              replaceQueue: () => queueAction(menu.fav, 'REPLACE' as MediaQueueAction, null),
              saveToPreset: () => setPresetFor({ fav: menu.fav, x: menu.x, y: menu.y }),
              addToPlaylist: () => setPlaylistFor({ fav: menu.fav, x: menu.x, y: menu.y }),
              heart: {
                active: activeKeys.has(favoriteKey(menu.fav)),
                toggle: () => toggleHeart(menu.fav)
              },
              searchFrom: { screen: 'favorites' as const }
            }
            return menu.fav.kind === 'album'
              ? albumMenuItems(fromFavorite(menu.fav), {
                  ...shared,
                  playNow: () => playAlbum(menu.fav, null),
                  openInLibrary: () => enterAlbum(menu.fav)
                })
              : trackMenuItems(fromFavorite(menu.fav), {
                  ...shared,
                  playNow: () => playTrack(menu.fav, null)
                })
          })()}
        />
      )}
      {playlistFor && (
        <AddToPlaylistPanel
          label={playlistFor.fav.title}
          at={{ x: playlistFor.x, y: playlistFor.y }}
          onClose={() => setPlaylistFor(null)}
          resolve={() => resolvePlaylistItems(playlistFor.fav)}
        />
      )}
      {presetFor && (
        <PresetPicker
          picker={{ node: { title: presetFor.fav.title }, x: presetFor.x, y: presetFor.y }}
          onClose={() => setPresetFor(null)}
          onSave={async (slot, name) => {
            await savePresetFor(presetFor.fav, slot, name)
            setPresetFor(null)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- components

function StationFavRow({
  station,
  active,
  playing,
  tuning,
  onPlay,
  onHeart
}: {
  station: FavoriteStation
  active: boolean
  playing: boolean
  tuning: boolean
  onPlay(): void
  onHeart(): void
}): React.JSX.Element {
  // MediaRow carries the whole station treatment (tuning half-light, inline
  // eqbars); a soft-removed station dims and, like a soft-removed track, needs
  // its heart back before it plays again.
  return (
    <MediaRow
      attrs={{ 'data-fav-station': station.name }}
      title={station.name}
      kind="station"
      artUrl={station.favicon}
      playing={playing}
      tuning={tuning}
      dimmed={!active}
      meta={
        tuning ? (
          <span className="text-gold/80 motion-safe:animate-pulse">tuning in…</span>
        ) : undefined
      }
      onClick={() => onPlay()}
      actions={<RowHeart favorited={active} held onHeart={onHeart} />}
    />
  )
}

/** Small portal menu (the ItemMenu idiom, but favorites-shaped items). */
