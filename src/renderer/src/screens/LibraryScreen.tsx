import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
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
  Usb
} from 'lucide-react'
import type { MediaNode, MediaQueueAction, MediaServerInfo, ScreenLayout } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { cx, fmtTime, matchesFilter } from '@/lib/format'
import { flashTarget } from '@/lib/scroll'
import { ArtImage } from '@/components/ArtImage'
import { FilterInput } from '@/components/FilterInput'

type Crumb = { id: string; title: string }

// Session memory: where you were browsing survives screen switches.
let session: { serverUdn: string | null; path: Crumb[] } = { serverUdn: null, path: [] }
const scrollMemory = new Map<string, number>()

const nodeKey = (serverUdn: string | null, path: Crumb[]): string =>
  `${serverUdn ?? ''}|${path.map((c) => c.id).join('/')}`

/**
 * Library: browse UPnP media (LAN servers and the streamer's own USB storage)
 * and act on it — a bare click is never destructive (track click = Play now,
 * container click = drill in); queue-replacing verbs live behind explicit
 * buttons and the ⋯ menu.
 */
export function LibraryScreen(): React.JSX.Element {
  const { libraryLayout, presetCardSize, presetGap, presetFillRows } = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const filter = useStore((s) => s.screenFilters.library)
  const setScreenFilter = useStore((s) => s.setScreenFilter)
  const cards = libraryLayout === 'cards'

  const [servers, setServers] = useState<MediaServerInfo[] | null>(null)
  const [serverUdn, setServerUdn] = useState<string | null>(session.serverUdn)
  const [path, setPath] = useState<Crumb[]>(session.path)
  const [nodes, setNodes] = useState<MediaNode[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
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
    session = { serverUdn, path }
  }, [serverUdn, path])

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
        path.map((c) => c.title)
      )
      .then((list) => {
        if (stale) return
        setNodes(list)
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

  // Backspace goes up a level (arrows stay with transport seek/volume);
  // above a source's root it lands back on the source list.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        if (path.length > 0) setPath(path.slice(0, -1))
        else if (serverUdn) setServerUdn(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [path, serverUdn])

  const rememberScroll = (): void => {
    if (scrollRef.current) scrollMemory.set(nodeKey(serverUdn, path), scrollRef.current.scrollTop)
  }

  const enter = (node: MediaNode): void => {
    rememberScroll()
    setPath((p) => [...p, { id: node.id, title: node.title }])
  }
  const enterServer = (udn: string): void => {
    rememberScroll()
    setServerUdn(udn)
    setPath([])
  }
  // Crumb trail: Library (source list) › source › folders…
  const jumpTo = (index: number): void => {
    rememberScroll()
    if (index === 0) {
      setServerUdn(null)
      setPath([])
    } else {
      setPath((p) => p.slice(0, index - 1))
    }
  }

  const setLayout = async (libraryLayout: ScreenLayout): Promise<void> => {
    setSettings(await tt.setSettings({ libraryLayout }))
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
  const openMenu = (node: MediaNode, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ node, x: e.clientX, y: e.clientY })
  }

  // -------------------------------------------------------------- derivation

  const atRoot = serverUdn == null
  const shown = filter
    ? nodes.filter((n) => matchesFilter(filter, [n.title, n.artist, n.album]))
    : nodes
  const containers = shown.filter((n) => n.isContainer)
  const tracks = shown.filter((n) => !n.isContainer)
  const server = servers?.find((s) => s.udn === serverUdn) ?? null
  const shownServers = (servers ?? []).filter(
    (s) => !filter || matchesFilter(filter, [s.name, s.model])
  )
  const loading = atRoot ? servers == null : state === 'loading'

  // ------------------------------------------------------------------ render

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
          <FilterInput
            value={filter}
            onChange={(t) => setScreenFilter('library', t)}
            shown={atRoot ? shownServers.length : shown.length}
            total={atRoot ? (servers?.length ?? 0) : nodes.length}
          />
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

      {/* breadcrumbs: Library (source list) › source › folders… */}
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
            <button
              onClick={() => jumpTo(i + 2)}
              className={cx(
                'px-1.5 py-0.5 rounded transition-colors',
                i === path.length - 1 ? 'text-ink' : 'text-dim hover:text-ink hover:bg-veil'
              )}
            >
              {crumb.title}
            </button>
          </span>
        ))}
      </div>

      {notice && (
        <div className="mx-8 mb-2 px-3 py-2 rounded-lg ring-1 ring-alert/40 bg-alert/10 text-[12.5px] text-alert">
          {notice}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 pb-8 pt-1">
        {loading && (
          <div className="text-[13px] text-dim pt-4 motion-safe:animate-pulse">
            Retrieving library…
          </div>
        )}

        {/* root: sources, grouped like the official app (Servers / USB drives) */}
        {!loading && atRoot && (
          <div className="max-w-2xl space-y-6 pt-1">
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
                  <div className="microlabel mb-2 px-1">
                    {kind === 'usb' ? 'USB drives' : 'Servers'}
                  </div>
                  <div className="divide-y divide-edge/50">
                    {group.map((s) => (
                      <div
                        key={s.udn}
                        data-library-source
                        onClick={() => enterServer(s.udn)}
                        className="group grid grid-cols-[44px_1fr] items-center gap-3 rounded-lg px-2 py-2 cursor-pointer hover:bg-veil transition-colors"
                      >
                        <div className="h-10 w-10 rounded ring-1 ring-edge bg-raised flex items-center justify-center text-faint">
                          {s.isStreamer ? <Usb size={16} /> : <HardDrive size={16} />}
                        </div>
                        <div className="min-w-0">
                          <div className="text-[13.5px] text-ink truncate">{s.name}</div>
                          {s.model && (
                            <div className="text-[12px] text-faint truncate">{s.model}</div>
                          )}
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
        {!atRoot && state === 'ready' && shown.length === 0 && (
          <div className="text-[15px] text-faint pt-4 px-1">
            {filter ? `No matches for “${filter}”` : 'Nothing here'}
          </div>
        )}

        {!atRoot && state === 'ready' && containers.length > 0 && (
          <div
            className={cx(!cards && 'divide-y divide-edge/50')}
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
            {containers.map((node) =>
              cards ? (
                <ContainerCard
                  key={node.id}
                  node={node}
                  onEnter={() => enter(node)}
                  onPlay={(el) => void playContainer(node, el)}
                  onMenu={(e) => openMenu(node, e)}
                />
              ) : (
                <ContainerRow
                  key={node.id}
                  node={node}
                  onEnter={() => enter(node)}
                  onMenu={(e) => openMenu(node, e)}
                />
              )
            )}
          </div>
        )}

        {!atRoot && state === 'ready' && tracks.length > 0 && (
          <div className={cx('divide-y divide-edge/50', containers.length > 0 && 'mt-4')}>
            {tracks.map((node) => (
              <TrackRow
                key={node.id}
                node={node}
                onPlayNow={(el) => void act(node, 'PLAY_NOW', el)}
                onMenu={(e) => openMenu(node, e)}
              />
            ))}
          </div>
        )}
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

// ------------------------------------------------------------- cards and rows

const isAlbumClass = (c: string): boolean => c.includes('musicAlbum')

function ContainerCard({
  node,
  onEnter,
  onPlay,
  onMenu
}: {
  node: MediaNode
  onEnter(): void
  onPlay(el: HTMLElement | null): void
  onMenu(e: React.MouseEvent): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  // Queue/preset verbs only make sense on albums — plain folders (artist
  // dirs, USB volumes, Asset's virtual views) get no chips and no menu.
  const album = isAlbumClass(node.upnpClass)
  return (
    <div ref={ref} className="group" onContextMenu={album ? onMenu : undefined} data-library-card>
      {/* the card CENTER always enters — play/menu live as corner chips on
          the art (preset-card idiom), never intercepting the open gesture */}
      <button className="block w-full cursor-pointer" onClick={onEnter}>
        <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-panel/70 ring-1 ring-edge flex items-center justify-center">
          <ArtImage
            src={node.artUrl}
            lazy
            fallback={
              album ? (
                <Disc3 size={34} strokeWidth={1.2} className="text-faint" />
              ) : (
                <Folder size={34} strokeWidth={1.2} className="text-faint" />
              )
            }
          />
          {album && (
            <span
              onClick={(e) => {
                e.stopPropagation()
                onPlay(ref.current)
              }}
              data-tip="Play — replaces the queue"
              className="tip-bottom absolute bottom-1.5 left-1.5 h-8 w-8 rounded-lg opacity-0 group-hover:opacity-100 bg-amber text-bg flex items-center justify-center transition-all motion-safe:hover:scale-110"
            >
              <Play size={15} fill="currentColor" />
            </span>
          )}
          {album && (
            <span
              aria-label="More actions"
              onClick={onMenu}
              className="absolute bottom-1.5 right-1.5 h-8 w-8 rounded-lg opacity-0 group-hover:opacity-100 bg-panel/80 ring-1 ring-edge text-dim hover:text-ink flex items-center justify-center transition-all"
            >
              <MoreHorizontal size={15} />
            </span>
          )}
        </div>
        <div className="pt-1.5 text-[12.5px] text-ink truncate text-left">{node.title}</div>
      </button>
    </div>
  )
}

function ContainerRow({
  node,
  onEnter,
  onMenu
}: {
  node: MediaNode
  onEnter(): void
  onMenu(e: React.MouseEvent): void
}): React.JSX.Element {
  // Same rule as cards: only albums carry the ⋯ menu.
  const album = isAlbumClass(node.upnpClass)
  return (
    <div
      className="group grid grid-cols-[44px_1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5 cursor-pointer hover:bg-veil transition-colors"
      onClick={onEnter}
      onContextMenu={album ? onMenu : undefined}
      data-library-row
    >
      <div className="h-10 w-10 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage
          src={node.artUrl}
          lazy
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
        <div className="text-[13.5px] text-ink truncate">{node.title}</div>
        {node.artist && <div className="text-[12px] text-faint truncate">{node.artist}</div>}
      </div>
      {album ? (
        <button
          aria-label="More actions"
          onClick={onMenu}
          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all"
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
  onPlayNow,
  onMenu
}: {
  node: MediaNode
  onPlayNow(el: HTMLElement | null): void
  onMenu(e: React.MouseEvent): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  return (
    <div
      ref={ref}
      className="group grid grid-cols-[26px_1fr_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5 cursor-pointer hover:bg-veil transition-colors"
      onClick={() => onPlayNow(ref.current)}
      onContextMenu={onMenu}
      data-library-track
    >
      <span className="font-mono text-[10.5px] text-faint tabular-nums text-right">
        {node.trackNumber ?? ''}
      </span>
      <div className="min-w-0">
        <div className="text-[13.5px] text-ink truncate">{node.title}</div>
        {node.artist && <div className="text-[12px] text-faint truncate">{node.artist}</div>}
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          aria-label="Play now"
          data-tip="Play now"
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

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={onClose} />
      <div
        className="fixed z-50 min-w-[190px] rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-1.5 space-y-0.5"
        style={{
          left: Math.min(menu.x, window.innerWidth - 210),
          top: Math.min(menu.y, window.innerHeight - items.length * 36 - 16)
        }}
      >
        <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint truncate max-w-[220px]">
          {node.title}
        </div>
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

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 w-[264px] rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-3 space-y-2.5"
        style={{
          left: Math.min(picker.x, window.innerWidth - 280),
          top: Math.min(picker.y, window.innerHeight - 260)
        }}
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
