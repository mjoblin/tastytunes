import { useEffect, useMemo, useRef, useState } from 'react'
import { Disc3, Heart, ListOrdered, Music, Radio, Search, X } from 'lucide-react'
import type { Favorite, FavoriteMedia, MediaNode, RadioStation } from '@shared/ipc'
import { favoriteKey } from '@shared/ipc'
import { tt } from '@/api'
import { useStore, type Screen } from '@/store'
import { EmptyState } from '@/components/EmptyState'
import { SearchRow } from '@/components/SearchRow'
import { StationRow } from '@/components/StationRow'
import { favoriteAct, toggleFavorite } from '@/lib/favorites'
import { playStation } from '@/lib/radio'
import { cx, matchesFilter } from '@/lib/format'

/** Radio is a network call — same debounce the Radio screen uses. */
const RADIO_DEBOUNCE_MS = 350
/** Below this, a query matches half the library and every station on earth. */
const MIN_RADIO_CHARS = 2
/** Per group, before "see all" takes over. Five groups of everything is a wall. */
const GROUP_CAP = 6

/**
 * The session's last query — module scope, like the library's scroll and
 * find-recall memories. Coming back to Search mid-thought should show what you
 * were looking for, and this is never a setting.
 */
let lastQuery = ''

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
  const inputRef = useRef<HTMLInputElement | null>(null)

  const favorites = useStore((s) => s.favorites)
  const playlists = useStore((s) => s.playlists)
  const presets = useStore((s) => s.presets?.presets ?? null)
  const connection = useStore((s) => s.connection)
  const openInLibrary = useStore((s) => s.openInLibrary)
  const jumpToPlaylist = useStore((s) => s.jumpToPlaylist)
  const setScreen = useStore((s) => s.setScreen)
  const setScreenFilter = useStore((s) => s.setScreenFilter)
  const showToast = useStore((s) => s.showToast)
  const connected = connection.phase === 'connected'

  useEffect(() => {
    lastQuery = query
  }, [query])

  // ⌘F / the nav / the palette all land here; the ask carries an id so a
  // request made before this mounted still focuses, and can't re-fire later.
  const searchRequest = useStore((s) => s.searchRequest)
  const clearSearchRequest = useStore((s) => s.clearSearchRequest)
  const doneReq = useRef(-1)
  useEffect(() => {
    const asked = searchRequest != null && doneReq.current !== searchRequest.id
    if (searchRequest) {
      doneReq.current = searchRequest.id
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
      if (asked) inputRef.current?.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [searchRequest, clearSearchRequest])

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
    if (q.length < MIN_RADIO_CHARS) {
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
  }, [q])

  // ---- actions. Every one delegates to the same helper its own screen uses.

  const playNode = (node: MediaNode): void => {
    const udn = node.serverUdn
    if (!udn) return
    if (node.isContainer) {
      openInLibrary({ serverUdn: udn, objectId: node.id, titlePath: [node.title], title: node.title })
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
          title: media.title
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

  const seeAll = (screen: Screen, filterKey: 'favorites' | 'playlists' | 'presets'): void => {
    // Land on the owning screen already filtered to what you typed, so "see
    // all" shows the same set rather than making you retype it.
    setScreenFilter(filterKey, q)
    setScreen(screen)
  }

  const favStationUrls = useMemo(
    () => new Set(favorites.filter((f) => f.kind === 'station').map((f) => (f as { url: string }).url)),
    [favorites]
  )

  const groups = [
    { id: 'library', count: libTotal, shown: libResults.length },
    { id: 'favorites', count: favResults.length, shown: favResults.length },
    { id: 'playlists', count: playlistResults.length, shown: playlistResults.length },
    { id: 'presets', count: presetResults.length, shown: presetResults.length },
    { id: 'radio', count: radio?.length ?? 0, shown: radio?.length ?? 0 }
  ]
  const anyResults = groups.some((g) => g.shown > 0)

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

      <div className="flex-1 overflow-y-auto px-8 pb-10 pt-1">
        <div className="max-w-2xl space-y-6">
          {!q && (
            <EmptyState
              icon={Search}
              title="Search everything"
              caption="Your library, favorites, playlists, presets and internet radio — all at once. Press S from anywhere, or ⌘F outside the Library."
            />
          )}

          {q && !anyResults && !radioPending && (
            <EmptyState icon={Search} title={`Nothing found for “${q}”`} caption="Try fewer words." />
          )}

          {libResults.length > 0 && (
            <Group
              label="Library"
              total={libTotal}
              shown={Math.min(libResults.length, GROUP_CAP)}
            >
              {libResults.slice(0, GROUP_CAP).map((node) => (
                <SearchRow
                  key={`${node.serverUdn}:${node.id}`}
                  title={node.title}
                  subtitle={[node.artist, node.serverName].filter(Boolean).join(' — ')}
                  artUrl={node.artUrl}
                  icon={node.isContainer ? Disc3 : Music}
                  onClick={() => playNode(node)}
                />
              ))}
            </Group>
          )}

          {favResults.length > 0 && (
            <Group
              label="Favorites"
              total={favResults.length}
              shown={Math.min(favResults.length, GROUP_CAP)}
              onSeeAll={() => seeAll('favorites', 'favorites')}
            >
              {favResults.slice(0, GROUP_CAP).map((f) => (
                <SearchRow
                  key={favoriteKey(f)}
                  title={f.kind === 'station' ? f.name : f.title}
                  subtitle={
                    f.kind === 'station'
                      ? 'Station'
                      : [f.artist, f.kind === 'album' ? 'Album' : f.album].filter(Boolean).join(' — ')
                  }
                  artUrl={f.kind === 'station' ? f.favicon : f.artUrl}
                  icon={f.kind === 'station' ? Radio : f.kind === 'album' ? Disc3 : Heart}
                  dimmed={!connected}
                  onClick={() => openFavorite(f)}
                />
              ))}
            </Group>
          )}

          {playlistResults.length > 0 && (
            <Group
              label="Playlists"
              total={playlistResults.length}
              shown={Math.min(playlistResults.length, GROUP_CAP)}
              onSeeAll={() => seeAll('playlists', 'playlists')}
            >
              {playlistResults.slice(0, GROUP_CAP).map((p) => (
                <SearchRow
                  key={p.id}
                  title={p.name}
                  subtitle={`${p.items.length} ${p.items.length === 1 ? 'track' : 'tracks'}`}
                  icon={ListOrdered}
                  onClick={() => jumpToPlaylist(p.id)}
                />
              ))}
            </Group>
          )}

          {presetResults.length > 0 && (
            <Group
              label="Presets"
              total={presetResults.length}
              shown={Math.min(presetResults.length, GROUP_CAP)}
              onSeeAll={() => seeAll('presets', 'presets')}
            >
              {presetResults.slice(0, GROUP_CAP).map((p) => (
                <SearchRow
                  key={p.id ?? p.name}
                  title={p.name ?? `Preset ${p.id}`}
                  subtitle={p.type}
                  artUrl={p.art_url}
                  icon={Radio}
                  meta={p.id != null ? `#${p.id}` : null}
                  playing={p.is_playing === true}
                  dimmed={!connected}
                  onClick={() => {
                    if (p.id != null) void tt.command({ type: 'recallPreset', presetId: p.id })
                  }}
                />
              ))}
            </Group>
          )}

          {(radioPending || radioFailed || (radio?.length ?? 0) > 0) && (
            <Group
              label="Internet radio"
              total={radio?.length ?? 0}
              shown={Math.min(radio?.length ?? 0, GROUP_CAP)}
              pending={radioPending}
            >
              {radioFailed && (
                <div className="text-[12.5px] text-faint">
                  Couldn&rsquo;t reach the station directory. Everything above is local and
                  unaffected.
                </div>
              )}
              {(radio ?? []).slice(0, GROUP_CAP).map((st) => (
                <StationRow
                  key={st.uuid}
                  station={st}
                  playing={false}
                  tuning={false}
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
                  onPlay={() => void playStation(st)}
                  // Save-to-preset belongs to the Radio screen, where the
                  // station is playing and the panel has room; it never fires
                  // here because the row only offers it while playing.
                  onSave={() => {}}
                />
              ))}
            </Group>
          )}
        </div>
      </div>
    </div>
  )
}

/** A result group: heading, count, and either "see all" or a plain remainder. */
function Group({
  label,
  total,
  shown,
  pending,
  onSeeAll,
  children
}: {
  label: string
  total: number
  shown: number
  pending?: boolean
  onSeeAll?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const more = total - shown
  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline gap-2 px-1">
        <span className="microlabel">{label}</span>
        <span className={cx('text-[11px] text-faint tabular-nums', pending && 'opacity-0')}>
          {total}
        </span>
        {pending && <span className="text-[11px] text-faint motion-safe:animate-pulse">searching…</span>}
        <div className="flex-1" />
        {more > 0 &&
          (onSeeAll ? (
            <button
              onClick={onSeeAll}
              className="text-[11.5px] text-amber hover:brightness-110 transition-all"
            >
              See all {total} →
            </button>
          ) : (
            <span className="text-[11.5px] text-faint">+{more} more</span>
          ))}
      </div>
      {children}
    </section>
  )
}
