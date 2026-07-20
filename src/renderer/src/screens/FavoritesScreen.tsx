import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Heart, Loader2, Music2, RadioTower } from 'lucide-react'
import {
  favoriteKey,
  type Favorite,
  type FavoriteMedia,
  type FavoriteStation,
  type MediaNode,
  type MediaQueueAction,
  type MediaServerInfo
} from '@shared/ipc'
import { isRadioMetadata } from '@shared/smoip'
import { tt } from '@/api'
import { useStore } from '@/store'
import { ArtImage } from '@/components/ArtImage'
import { ContainerCard } from '@/components/LibraryCards'
import { EmptyState } from '@/components/EmptyState'
import { Eqbars } from '@/components/Eqbars'
import { FilterInput } from '@/components/FilterInput'
import { Segmented } from '@/components/Segmented'
import { useClampedPosition, usePopoverChrome } from '@/hooks/usePopover'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { activeSourceId, cx, matchesFilter } from '@/lib/format'
import { favoriteAct, favoriteHasRoute, type FavoriteActResult } from '@/lib/favorites'
import { flashTarget } from '@/lib/scroll'

/** Kind visibility — session memory, like the Radio screen's chip state. */
type FavKind = 'all' | 'station' | 'album' | 'track'
let lastKind: FavKind = 'all'

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
  const [servers, setServers] = useState<MediaServerInfo[]>([])
  useEffect(() => {
    if (!connected) {
      setServers([])
      return
    }
    void tt
      .mediaServers()
      .then(setServers)
      .catch(() => setServers([]))
  }, [connected])

  const [kind, setKindState] = useState<FavKind>(lastKind)
  const setKind = (k: FavKind): void => {
    lastKind = k
    setKindState(k)
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
  const audible = queueSourceActive && playState?.state === 'play'
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

  /** Bare track click, queue-aware like the Library: jump if already queued. */
  const playTrack = (f: FavoriteMedia, el: HTMLElement | null): void => {
    const items = queue?.items ?? []
    const matches = items.filter((i) => {
      const m = i.metadata
      return (
        m?.title === f.title &&
        (f.artist == null || m?.artist == null || m.artist === f.artist) &&
        (f.album == null || m?.album == null || m.album === f.album)
      )
    })
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
  const reheart = (f: Favorite): void => void tt.favoriteAdd({ ...f, addedAt: Date.now() })
  const toggleHeart = (f: Favorite): void =>
    activeKeys.has(favoriteKey(f)) ? unheart(f) : reheart(f)

  // ------------------------------------------------------------------- menus

  const [menu, setMenu] = useState<{ fav: FavoriteMedia; x: number; y: number } | null>(null)
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
        <h1 className="font-display font-bold text-[26px] tracking-tight">Favorites</h1>
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
              {filter ? `No matches for “${filter}”` : 'Nothing of this kind favorited yet.'}
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
                  const routed = favoriteHasRoute(f, servers)
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
                        audible={audible}
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
              <div className="space-y-1 max-w-2xl">
                {shownTracks.map((f) => {
                  const key = favoriteKey(f)
                  const active = activeKeys.has(key)
                  const routed = favoriteHasRoute(f, servers)
                  const playing = trackPlaying(f)
                  return (
                    <div
                      key={key}
                      data-fav-track={f.title}
                      onClick={(e) =>
                        routed && active !== false && playTrack(f, e.currentTarget as HTMLElement)
                      }
                      onContextMenu={(e) => openMenu(f, e)}
                      className={cx(
                        'group flex items-center gap-3 rounded-xl px-3 py-2 transition-colors',
                        routed ? 'cursor-pointer' : 'cursor-default',
                        playing
                          ? 'row-playing bg-gold/10'
                          : 'ring-1 ring-edge bg-panel/60 hover:bg-raised/70 hover:ring-edge2',
                        (!active || !routed) && 'opacity-50'
                      )}
                    >
                      <div className="h-9 w-9 shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
                        <ArtImage
                          src={f.artUrl}
                          lazy
                          fallback={<Music2 size={14} className="text-faint" />}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div
                          className={cx(
                            'flex items-center gap-2 text-[13px] truncate',
                            playing ? 'text-gold' : 'text-ink'
                          )}
                        >
                          {playing && <Eqbars playing={audible} />}
                          <span className="truncate">{f.title}</span>
                        </div>
                        <div className="text-[11.5px] text-dim truncate">
                          {[f.artist, f.album].filter(Boolean).join(' — ')}
                          {!routed && f.serverName ? ` · ${f.serverName} is offline` : ''}
                        </div>
                      </div>
                      {busyKey === key && <Loader2 size={13} className="spin text-gold/80 shrink-0" />}
                      <HeartButton active={active} onClick={() => toggleHeart(f)} />
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

      {menu && (
        <FavMenu
          menu={menu}
          onClose={() => setMenu(null)}
          items={
            menu.fav.kind === 'album'
              ? [
                  { label: 'Play', run: () => playAlbum(menu.fav, null) },
                  { label: 'Play next', run: () => queueAction(menu.fav, 'PLAY_NEXT', null) },
                  { label: 'Add to end of queue', run: () => queueAction(menu.fav, 'APPEND', null) },
                  { label: 'Replace queue', run: () => queueAction(menu.fav, 'REPLACE', null) },
                  { label: 'Open in Library', run: () => enterAlbum(menu.fav) },
                  {
                    label: activeKeys.has(favoriteKey(menu.fav))
                      ? 'Remove from favorites'
                      : 'Add to favorites',
                    run: () => toggleHeart(menu.fav)
                  }
                ]
              : [
                  { label: 'Play now', run: () => playTrack(menu.fav, null) },
                  { label: 'Play next', run: () => queueAction(menu.fav, 'PLAY_NEXT', null) },
                  { label: 'Add to end of queue', run: () => queueAction(menu.fav, 'APPEND', null) },
                  {
                    label: activeKeys.has(favoriteKey(menu.fav))
                      ? 'Remove from favorites'
                      : 'Add to favorites',
                    run: () => toggleHeart(menu.fav)
                  }
                ]
          }
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- components

function HeartButton({
  active,
  onClick,
  reveal
}: {
  active: boolean
  onClick(): void
  /** 'hover' shows only on row/card hover unless active; default always shows. */
  reveal?: 'hover'
}): React.JSX.Element {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      data-tip={active ? 'Remove from favorites' : 'Add to favorites'}
      aria-label={active ? 'Remove from favorites' : 'Add to favorites'}
      data-fav-heart={active ? 'on' : 'off'}
      className={cx(
        'p-1.5 rounded-full transition-all motion-safe:active:scale-90 shrink-0',
        active ? 'text-gold hover:text-ink' : 'text-dim hover:text-ink hover:bg-veil2',
        reveal === 'hover' && !active && 'opacity-0 group-hover:opacity-100'
      )}
    >
      <Heart size={15} fill={active ? 'currentColor' : 'none'} />
    </button>
  )
}

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
  return (
    <div
      data-fav-station={station.name}
      onClick={onPlay}
      className={cx(
        'group flex items-center gap-4 rounded-xl px-3 py-2.5 cursor-pointer transition-colors',
        playing
          ? 'row-playing bg-gold/10'
          : tuning
            ? 'ring-1 ring-gold/40 bg-golddim/40'
            : 'ring-1 ring-edge bg-panel/60 hover:bg-raised/70 hover:ring-edge2',
        !active && 'opacity-50'
      )}
    >
      <div className="h-11 w-11 shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage
          src={station.favicon}
          lazy
          fallback={<RadioTower size={17} className="text-faint" />}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cx(
            'flex items-center gap-2 text-[13.5px] truncate',
            playing ? 'text-gold' : tuning ? 'text-gold/80' : 'text-ink'
          )}
        >
          {playing && <Eqbars playing />}
          {tuning && <Loader2 size={13} className="spin shrink-0" />}
          <span className="truncate">{station.name}</span>
        </div>
        {tuning && (
          <div className="text-[10.5px] text-gold/80 motion-safe:animate-pulse">tuning in…</div>
        )}
      </div>
      <HeartButton active={active} onClick={onHeart} />
    </div>
  )
}

/** Small portal menu (the ItemMenu idiom, but favorites-shaped items). */
function FavMenu({
  menu,
  items,
  onClose
}: {
  menu: { fav: FavoriteMedia; x: number; y: number }
  items: Array<{ label: string; run: () => void }>
  onClose(): void
}): React.JSX.Element {
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
        <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint truncate">{menu.fav.title}</div>
        {items.map((item) => (
          <button
            key={item.label}
            onClick={() => {
              onClose()
              item.run()
            }}
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
