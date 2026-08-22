import { useEffect, useRef } from 'react'
import { Disc3, ListMusic, Radio, RadioTower, X } from 'lucide-react'
import { playlistTotalSecs, type ScreenLayout } from '@shared/model'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useQueuePerformer } from '@/hooks/useQueuePerformer'
import { MediaRow } from '@/components/media/MediaRow'
import { MediaArt } from '@/components/media/MediaArt'
import { DurationCell } from '@/components/media/DurationCell'
import { Eqbars } from '@/components/media/Eqbars'
import { EmptyState } from '@/components/chrome/EmptyState'
import { fromRecent } from '@/lib/mediaRef'
import { playRefNow } from '@/lib/mediaActions'
import { scrollToVisible } from '@/lib/scroll'
import { activeSourceId, cx, fmtDuration, fmtRelative } from '@/lib/format'
import { useLitPresets } from '@/hooks/useLitPresets'

export type TrayTab = 'queue' | 'presets' | 'playlists' | 'recent'
export type TrayDensity = 'detailed' | 'compressed'

/**
 * The panel's four tab bodies.
 *
 * The rule that produced this list, and that keeps the panel from becoming a
 * second app: a section earns a tab only if it is (1) one click to an outcome,
 * (2) bounded — no typing, no facets, no minutes of scrolling — and (3) wanted
 * WITHOUT opening the app. Search and Library fail (2) outright: typing into a
 * blur-dismiss surface loses the query on any focus slip.
 *
 * Everything here is ASSEMBLY over the shared media layer, never a second
 * implementation of a row.
 */

/** How many Recent entries the tab shows. The cap is the point — see RecentTab. */
const RECENT_CAP = 12

// ------------------------------------------------------------ the compressed row

/**
 * One line, no art: position (where there is one), title, duration.
 *
 * This is the app's FLAT skin, which the row doctrine already assigns to
 * "dense ordered lists" — the same shape the Queue screen itself uses, minus
 * the drag handles the panel deliberately doesn't have. It is NOT a shrunken
 * `MediaRow`: shrinking one would break the 40px art token, and that token is
 * what makes a row recognisably the same object everywhere. Dropping the art
 * entirely is an honest different row, not a violated one.
 *
 * Worth ~30px against the detailed row's ~52 — the difference between six rows
 * of queue and eleven.
 */
function CompressedRow({
  position,
  withIndex,
  title,
  subtitle,
  duration,
  meta,
  playing,
  parked,
  dimmed,
  onClick,
  attrs
}: {
  position?: number | null
  /** Does this LIST have indices at all? Set per list, not per row, so the
   *  titles stay on one line even where a particular row has no number. */
  withIndex?: boolean
  title: string
  subtitle?: string | null
  /**
   * Reserved PER LIST, like the index cell: a list whose rows have durations
   * passes `?? null` so unknown ones still hold the '–:––' cell, and a list
   * that has no durations at all (recents, playlists) passes nothing — a
   * column of placeholders against nothing told the user precisely nothing.
   */
  duration?: number | null
  /** Trailing content where a duration makes no sense — the recents' "ago",
   *  the playlists' "3 tracks · 11 min" pair. */
  meta?: React.ReactNode
  playing?: boolean
  parked?: boolean
  dimmed?: boolean
  onClick?: () => void
  attrs?: Record<string, string | undefined>
}): React.JSX.Element {
  return (
    <div
      {...attrs}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick && !dimmed ? 0 : undefined}
      onClick={() => !dimmed && onClick?.()}
      onKeyDown={(e) => {
        if (dimmed || !onClick) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={cx(
        'group w-full text-left flex items-center gap-2 px-2.5 py-1 rounded-md transition-colors',
        onClick && !dimmed && 'cursor-pointer',
        playing ? 'bg-gold/10' : parked ? 'bg-veil/50 hover:bg-veil' : 'hover:bg-raised/60',
        dimmed && 'opacity-45'
      )}
    >
      {/* The position cell is the flat skin's playing marker — eqbars replace
          the number, exactly as on the Queue screen, so the eye looks in one
          place for "where am I" on both surfaces.
          ONLY WHERE THE LIST HAS NUMBERS. Recent and Playlists have none, and
          reserving the cell for them indented every title by 20px against
          nothing. Those lists put the playing marker inline instead — which is
          the floating skin's rule, and the right one when there's no cell. */}
      {withIndex ? (
        <span className="w-5 shrink-0 flex justify-center font-mono text-[10.5px] text-faint tabular-nums">
          {playing ? <Eqbars /> : position != null ? position : ''}
        </span>
      ) : (
        playing && <Eqbars />
      )}
      <span
        className={cx(
          'flex-1 min-w-0 truncate text-[12.5px]',
          playing ? 'text-gold' : 'text-ink'
        )}
      >
        {title}
        {subtitle && <span className="text-faint"> · {subtitle}</span>}
      </span>
      {meta && (
        <span className="shrink-0 font-mono text-[10.5px] text-faint tabular-nums">{meta}</span>
      )}
      {duration !== undefined && <DurationCell secs={duration} />}
    </div>
  )
}

// ------------------------------------------------------------------- the queue

/**
 * READ-MOSTLY BY DECISION, not by limitation. Click a row and it plays; that
 * is the whole contract.
 *
 * No drag reorder here on purpose: dnd-kit items are containing blocks that
 * need portaled popovers, and a drag interrupted by an accidental blur-dismiss
 * is a genuinely bad moment. Reordering is what the app is for.
 */
export function QueueTab({
  opens,
  density
}: {
  opens: number
  density: TrayDensity
}): React.JSX.Element {
  const performerOf = useQueuePerformer()
  const queue = useStore((s) => s.queue)
  const playState = useStore((s) => s.playState)
  const zoneState = useStore((s) => s.zoneState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const followQueue = useStore((s) => s.settings.followQueue)
  const playingRow = useRef<HTMLDivElement | null>(null)

  const offline = useOffline()
  const items = queue?.items ?? []
  const playId = queue?.play_id ?? playState?.queue_id ?? null
  // THE QUEUE BELONGS TO MEDIA_PLAYER. Switch to a radio preset (or AirPlay)
  // and the device still reports a play_id — that row is just where the queue
  // is PARKED, and a panel that leaves eqbars dancing on it is claiming a
  // track is playing when it stopped minutes ago. The Queue screen has drawn
  // this distinction since the AirPlay round; the panel was missing it.
  const queueAudible = activeSourceId(zoneState, nowPlaying) === 'MEDIA_PLAYER'

  // TWO DIFFERENT SCROLLS, deliberately split.
  //
  // On OPEN, always: a queue panel that opens at row 1 of 60 is useless, and
  // this isn't "following" anything — it's landing where you already are.
  //
  // On TRACK CHANGE, only if `followQueue` is on. That is the app's existing
  // answer to "don't yank the list while I'm reading it", and the panel honours
  // it rather than growing a second one — a preference travels between
  // surfaces even where a fit setting wouldn't.
  //
  // Container-scoped: scrollIntoView is banned app-wide, it scrolls every
  // scrollable ancestor including the window.
  // pad 8: detailed rows are RINGED cards, and the ring is a box-shadow
  // outside the row's border box — a flush follow-scroll clipped the playing
  // row's gold ring at the scrollport edge (user, 2026-08-04, seen switching
  // compact -> detailed). 8px matches the body's own pb-2 rhythm.
  useEffect(() => {
    scrollToVisible(playingRow.current, 8)
  }, [opens, density])
  useEffect(() => {
    if (followQueue) scrollToVisible(playingRow.current, 8)
  }, [playId, followQueue])

  if (offline) return <OfflineTab icon={ListMusic} what="Queue" they="It lives" />
  if (items.length === 0) {
    return <TabEmpty icon={ListMusic} title="Queue is empty" hint="Play an album or a playlist to fill it." />
  }

  return (
    <>
      {items.map((item) => {
        const md = item.metadata
        const current = item.id != null && item.id === playId
        // Current AND audible = the full playing treatment. Current while
        // another source plays = the parked resume point, quietly set apart.
        const playing = current && queueAudible
        const play = (): void => {
          if (item.id != null) void tt.command({ type: 'playQueueId', queueId: item.id })
        }
        return (
          <div key={item.id ?? item.position} ref={playing ? playingRow : undefined}>
            {density === 'compressed' ? (
              <CompressedRow
                withIndex
                attrs={{ 'data-tray-row': 'queue' }}
                // 1-BASED, like the Queue screen's cell — the wire's position
                // is 0-based, and a list that counts from 0 in one window and
                // 1 in the other is the same number telling two stories.
                position={(item.position ?? 0) + 1}
                title={md?.title ?? md?.name ?? '—'}
                subtitle={performerOf(md) ?? md?.artist}
                duration={md?.duration ?? null}
                playing={playing}
                parked={current && !queueAudible}
                onClick={play}
              />
            ) : (
              <MediaRow
                dense
                parked={current && !queueAudible}
                attrs={{ 'data-tray-row': 'queue' }}
                title={md?.title ?? md?.name ?? '—'}
                subtitle={[performerOf(md) ?? md?.artist, md?.album].filter(Boolean).join(' — ') || undefined}
                kind="track"
                artUrl={md?.art_url ?? null}
                playing={playing}
                duration={md?.duration ?? null}
                onClick={play}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

// ----------------------------------------------------------------- the presets

/**
 * The strongest case for a tab, and given a DIFFERENT SHAPE by default: art
 * tiles rather than rows. Presets are the one section where the art IS the
 * identifier, and the change of shape separates "start something" from the
 * row-heavy queue at a glance.
 *
 * THREE columns, where the design said two. At 380px wide a two-column tile is
 * ~175px square, so the tab showed FOUR presets against a device that holds up
 * to 99 — a poster wall, not a launcher. Three keeps the art unmistakably the
 * identifier (~112px, close to the main grid's own default) and shows nine.
 *
 * Rows are offered as well, and unlike the track tabs that is NOT a
 * contradiction: the app's standing rule is "tracks always rows, and the
 * rows⇄cards toggle is scoped to CONTAINER lists" — presets are containers.
 * Geometry stays fixed either way, never `presetCardSize`/`presetGap`, which
 * are tuned for the main grid at full window width.
 */
export function PresetsTab({
  layout,
  density
}: {
  layout: ScreenLayout
  density: TrayDensity
}): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  const offline = useOffline()
  const items = (presets?.presets ?? []).filter((p) => p.id != null)
  // NOT `p.is_playing` — the device's flags are unreliable in both directions
  // and lit almost nothing here. `useLitPresets` is the derivation the Presets
  // screen has always used, now shared.
  const lit = useLitPresets(items)
  const isPlaying = (id: number | null): boolean => id != null && lit.has(id)

  if (offline) return <OfflineTab icon={Radio} what="Presets" they="They live" />
  if (items.length === 0) {
    return <TabEmpty icon={Radio} title="No presets" hint="Save stations and albums to the streamer's presets." />
  }

  const recall = (id: number) => (): void => {
    void tt.command({ type: 'recallPreset', presetId: id })
  }

  if (layout === 'rows') {
    return (
      <>
        {items.map((p) =>
          density === 'compressed' ? (
            <CompressedRow
              withIndex
              key={p.id}
              attrs={{ 'data-tray-row': 'preset' }}
              position={p.id}
              title={p.name ?? `Preset ${p.id}`}
              playing={isPlaying(p.id)}
              onClick={recall(p.id as number)}
            />
          ) : (
            <MediaRow
              dense
              key={p.id}
              attrs={{ 'data-tray-row': 'preset' }}
              // The slot number moved out of the second line and into a
              // position cell beside the name: "Preset N" under every row was
              // boilerplate wearing a subtitle's clothes — 24 rows all saying
              // the same word — where the queue's second line actually varies
              // (user call, 2026-08-04). The cell is fixed-width and padded,
              // so names share one left edge from slot 1 to slot 99.
              slot={p.id as number}
              title={p.name ?? `Preset ${p.id}`}
              kind="preset"
              artUrl={p.art_url ?? p.art_urls?.[0] ?? null}
              playing={isPlaying(p.id)}
              onClick={recall(p.id as number)}
            />
          )
        )}
      </>
    )
  }

  // COMPACT CARDS: art only, four across. The density chip means something on
  // this tab too — "show me more of them" is the same request whether the
  // things are rows or tiles, and for presets the art IS the identifier, so
  // the label is the part that can go.
  const compact = density === 'compressed'
  return (
    // No padding of its own: the body already supplies the window's gutter,
    // and adding to it indented the grid further than everything above it.
    <div className={cx('grid gap-2', compact ? 'grid-cols-4 gap-1.5' : 'grid-cols-3')}>
      {items.map((p) => (
        <button
          key={p.id}
          data-tray-preset={p.id}
          title={compact ? (p.name ?? `Preset ${p.id}`) : undefined}
          onClick={recall(p.id as number)}
          className={cx(
            // THE MAIN GRID'S CARD TREATMENT, not an approximation of it. It
            // grows slightly on hover (scale is layout-free, so an edge card
            // just clips at the scrollport) and picks up the shared
            // `card-hover-glow` outline; a playing card wears `tile-playing`,
            // the same gold ring and bloom it has on the Presets screen. This
            // was a raise plus a ring change, which is a different gesture and
            // a nearly invisible one over album art.
            'group relative rounded-lg overflow-hidden text-left transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]',
            isPlaying(p.id) ? 'tile-playing' : 'ring-1 ring-edge card-hover-glow'
          )}
        >
          <div className="aspect-square bg-raised">
            {/* `preset`, not a guess at the class. A preset is its own kind of
                thing — an input source, a saved queue and a station are all
                presets — and the main grid has always drawn the radio mark for
                every one of them. Guessing radio-vs-album here made a TV ARC
                input a disc in this window and a radio in the other. */}
            <MediaArt
              src={p.art_url ?? p.art_urls?.[0] ?? null}
              kind="preset"
              size="card"
            />
          </div>
          {!compact && (
            <div
              className={cx(
                'px-1.5 py-1 text-[10.5px] truncate transition-colors',
                isPlaying(p.id) ? 'text-gold' : 'text-dim group-hover:text-ink'
              )}
            >
              {p.name ?? `Preset ${p.id}`}
            </div>
          )}
        </button>
      ))}
    </div>
  )
}

// --------------------------------------------------------------- the playlists

/**
 * Activation is a slow, cancellable batch, which is why this tab carries the
 * panel's one piece of genuinely novel behaviour — see TrayPanel for the
 * dismissal rules it drives.
 */
export function PlaylistsTab({
  density,
  onActivate
}: {
  density: TrayDensity
  onActivate(playlist: { id: string; name: string }): void
}): React.JSX.Element {
  const playlists = useStore((s) => s.playlists)
  const activation = useStore((s) => s.playlistActivation)
  const running = activation && !activation.finished

  if (playlists.length === 0) {
    return <TabEmpty icon={ListMusic} title="No playlists" hint="Build one in the app, start it from here." />
  }

  return (
    <>
      {playlists.map((p) => {
        const mine = running && activation.playlistId === p.id
        const count = `${p.items.length} ${p.items.length === 1 ? 'track' : 'tracks'}`
        const progress = mine ? `Loading ${activation.done} of ${activation.total}…` : count
        // The runtime the Playlists screen already shows beside the count —
        // same sum (`playlistTotalSecs`), worn as the row's trailing fact, the
        // slot recents use for their relative time. Absent when no item knows
        // its length; constant through activation so the right edge never
        // reshapes with the state.
        const total = playlistTotalSecs(p)
        const runtime = total > 0 ? fmtDuration(total) : undefined
        // Another playlist's run is in flight: starting a second would fight it
        // for the queue, and the door is closed at the preload anyway. Dim
        // rather than hide, so the list never reshapes.
        const dimmed = !!running && !mine
        const start = (): void => onActivate({ id: p.id, name: p.name })
        return density === 'compressed' ? (
          <CompressedRow
            key={p.id}
            attrs={{ 'data-tray-row': 'playlist' }}
            title={p.name}
            // The inline slot carries only the ACTIVATION progress; at rest
            // the row's facts live right-aligned in the meta cell below.
            subtitle={mine ? progress : undefined}
            // COMPACT: count and runtime together where the time sits —
            // "3 tracks · 11 min", the status line's own dot with a touch
            // more air on each side (user call, 2026-08-04). One fact, one
            // place; splitting its two halves across the row's full width
            // read as two facts.
            meta={
              runtime ? (
                <>
                  {count}
                  <span className="mx-1">·</span>
                  {runtime}
                </>
              ) : (
                count
              )
            }
            playing={!!mine}
            dimmed={dimmed}
            onClick={running ? undefined : start}
          />
        ) : (
          <MediaRow
            dense
            key={p.id}
            attrs={{ 'data-tray-row': 'playlist' }}
            title={p.name}
            subtitle={progress}
            meta={runtime}
            kind="album"
            artUrl={p.items.find((i) => i.artUrl)?.artUrl ?? null}
            // `tuning` is the row layer's own in-flight affordance (the spinner
            // before the title) — the same one a station shows while it tunes.
            tuning={!!mine}
            dimmed={dimmed}
            actions={
              mine ? (
                <button
                  aria-label="Stop loading"
                  data-tip="Stop loading"
                  onClick={(e) => {
                    e.stopPropagation()
                    void tt.playlistActivateCancel()
                  }}
                  className="tip-top p-1 rounded text-dim hover:text-alert transition-colors"
                >
                  <X size={13} />
                </button>
              ) : undefined
            }
            onClick={running ? undefined : start}
          />
        )
      })}
      {/* Compressed rows have no room for a cancel button, so the run's own
          row carries it beneath them rather than being uncancellable. */}
      {density === 'compressed' && running && (
        <button
          onClick={() => void tt.playlistActivateCancel()}
          aria-label="Stop loading"
          className="w-full text-left px-2.5 py-1 text-[11.5px] text-dim hover:text-alert transition-colors"
        >
          Stop loading “{activation.name}”
        </button>
      )}
    </>
  )
}

// ------------------------------------------------------------------ the recent

/**
 * CAPPED, with no filter and no sort — and the cap is the discipline that
 * makes the whole panel work. The full ring is 200 entries with filters and a
 * Segmented on its own screen: that's a browse surface. The top handful
 * answers the sharper question ("what was that, this morning?"). Want the real
 * thing, open the app.
 */
export function RecentTab({ density }: { density: TrayDensity }): React.JSX.Element {
  const recents = useStore((s) => s.recents)
  const items = recents.slice(0, RECENT_CAP)

  if (items.length === 0) {
    return <TabEmpty icon={Disc3} title="Nothing played yet" hint="Tracks you play show up here." />
  }

  return (
    <>
      {items.map((entry) => {
        const ref = fromRecent(entry)
        const title = entry.isRadio ? (entry.station ?? entry.title) : entry.title
        const subtitle =
          (entry.isRadio ? entry.title : [entry.artist, entry.album].filter(Boolean).join(' — ')) || undefined
        // Radio and songless rows carry no identity to replay — no stream URL
        // is stored for them — so they read as history, not as buttons.
        const play = ref ? () => void playRefNow(ref) : undefined
        const attrs = { 'data-tray-row': 'recent' }
        // The main Recently Played screen's trailing fact, from the same
        // formatter — a history row's useful number is WHEN, not how long.
        const ago = fmtRelative(entry.at)
        return density === 'compressed' ? (
          <CompressedRow
            key={`${entry.at}-${entry.title ?? ''}`}
            attrs={attrs}
            title={title ?? '—'}
            subtitle={entry.isRadio ? entry.title : entry.artist}
            meta={ago}
            dimmed={!ref}
            onClick={play}
          />
        ) : (
          <MediaRow
            dense
            key={`${entry.at}-${entry.title ?? ''}`}
            attrs={attrs}
            title={title ?? '—'}
            subtitle={subtitle}
            kind={entry.isRadio ? 'station' : 'track'}
            artUrl={entry.artUrl}
            meta={ago}
            dimmed={!ref}
            onClick={play}
          />
        )
      })}
    </>
  )
}

// ------------------------------------------------------------------- the empty

function TabEmpty({
  icon: Icon,
  title,
  hint
}: {
  icon: typeof RadioTower
  title: string
  hint: string
}): React.JSX.Element {
  return (
    <div className="h-full flex items-center justify-center px-2">
      <EmptyState compact icon={Icon} title={title} caption={hint} />
    </div>
  )
}

/**
 * QUEUE AND PRESETS ARE DEVICE STATE. With no streamer they'd otherwise show
 * the last one's — a full queue sitting under a panel header that says "No
 * streamer connected" (user, 2026-08-04). Playlists and Recent are local and
 * stay honest offline, which is exactly why only these two go quiet.
 */
function useOffline(): boolean {
  return useStore((s) => s.connection.phase !== 'connected')
}

function OfflineTab({
  icon,
  what,
  they
}: {
  icon: typeof RadioTower
  what: string
  they: string
}): React.JSX.Element {
  // KEEPS THE TAB'S OWN GLYPH AND EXPLAINS THE CONSEQUENCE, rather than
  // repeating the header. The panel's offline face is right above this saying
  // "No streamer connected" with an unplug mark; a second unplug mark and a
  // second "Not connected" underneath it is the same sentence twice, and the
  // question it leaves unanswered is why THIS tab is empty when Recent isn't.
  return <TabEmpty icon={icon} title={`${what} unavailable`} hint={`${they} on the streamer.`} />
}
