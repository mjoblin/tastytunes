import { useEffect, useRef } from 'react'
import { Disc3, ListMusic, Radio, RadioTower, X } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { MediaRow } from '@/components/media/MediaRow'
import { MediaArt } from '@/components/media/MediaArt'
import { EmptyState } from '@/components/chrome/EmptyState'
import { fromRecent } from '@/lib/mediaRef'
import { playRefNow } from '@/lib/mediaActions'
import { scrollToVisible } from '@/lib/scroll'
import { cx } from '@/lib/format'

export type TrayTab = 'queue' | 'presets' | 'playlists' | 'recent'

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

/** How many rows the body shows before scrolling — the panel is ~9 rows tall. */
const RECENT_CAP = 9

// ------------------------------------------------------------------- the queue

/**
 * READ-MOSTLY BY DECISION, not by limitation. Click a row and it plays; that
 * is the whole contract.
 *
 * No drag reorder here on purpose: dnd-kit items are containing blocks that
 * need portaled popovers, and a drag interrupted by an accidental blur-dismiss
 * is a genuinely bad moment. Reordering is what the app is for.
 */
export function QueueTab({ opens }: { opens: number }): React.JSX.Element {
  const queue = useStore((s) => s.queue)
  const playState = useStore((s) => s.playState)
  const playingRow = useRef<HTMLDivElement | null>(null)

  const items = queue?.items ?? []
  const playId = queue?.play_id ?? playState?.queue_id ?? null

  // A queue panel that opens at row 1 of 60 is useless. Container-scoped —
  // scrollIntoView is banned app-wide, it scrolls every ancestor including
  // the window.
  useEffect(() => {
    scrollToVisible(playingRow.current)
  }, [opens, playId])

  if (items.length === 0) {
    return <TabEmpty icon={ListMusic} title="Queue is empty" hint="Play an album or a playlist to fill it." />
  }

  return (
    <>
      {items.map((item) => {
        const md = item.metadata
        const playing = item.id != null && item.id === playId
        return (
          <div key={item.id ?? item.position} ref={playing ? playingRow : undefined}>
            <MediaRow
              attrs={{ 'data-tray-row': 'queue' }}
              title={md?.title ?? md?.name ?? '—'}
              subtitle={[md?.artist, md?.album].filter(Boolean).join(' — ') || undefined}
              kind="track"
              artUrl={md?.art_url ?? null}
              playing={playing}
              duration={md?.duration ?? null}
              onClick={() => {
                if (item.id != null) void tt.command({ type: 'playQueueId', queueId: item.id })
              }}
            />
          </div>
        )
      })}
    </>
  )
}

// ----------------------------------------------------------------- the presets

/**
 * The strongest case for a tab, and given a DIFFERENT SHAPE on purpose: two
 * columns of art tiles rather than rows. Presets are the one section where the
 * art IS the identifier, and the change of shape separates "start something"
 * from the row-heavy queue at a glance.
 *
 * Fixed geometry — deliberately NOT `presetCardSize`/`presetGap`. Those are
 * tuned for the main grid at full window width and would make this either two
 * enormous tiles or a mosaic.
 *
 * THREE columns, where the design said two. Two is what the design named, but
 * at 380px wide a two-column tile is ~175px square, so the tab showed FOUR
 * presets against a device that holds up to 99 — a poster wall, not a
 * launcher. Three keeps the art unmistakably the identifier (~112px, close to
 * the main grid's own default) and shows nine. The decision the design was
 * actually making is TILES RATHER THAN ROWS, and that stands.
 */
export function PresetsTab(): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  const items = (presets?.presets ?? []).filter((p) => p.id != null)

  if (items.length === 0) {
    return <TabEmpty icon={Radio} title="No presets" hint="Save stations and albums to the streamer's presets." />
  }

  return (
    <div className="grid grid-cols-3 gap-2 p-2">
      {items.map((p) => (
        <button
          key={p.id}
          data-tray-preset={p.id}
          onClick={() => void tt.command({ type: 'recallPreset', presetId: p.id as number })}
          className={cx(
            'group relative rounded-lg overflow-hidden ring-1 text-left transition-all',
            p.is_playing ? 'ring-gold/70' : 'ring-edge hover:ring-edge2'
          )}
        >
          <div className="aspect-square bg-raised">
            <MediaArt
              src={p.art_url ?? p.art_urls?.[0] ?? null}
              kind={p.class?.includes('radio') ? 'station' : 'album'}
              className="h-full w-full"
            />
          </div>
          <div
            className={cx(
              'px-1.5 py-1 text-[10.5px] truncate',
              p.is_playing ? 'text-gold' : 'text-ink'
            )}
          >
            {p.name ?? `Preset ${p.id}`}
          </div>
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
  onActivate
}: {
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
        return (
          <MediaRow
            key={p.id}
            attrs={{ 'data-tray-row': 'playlist' }}
            title={p.name}
            subtitle={
              mine
                ? `Loading ${activation.done} of ${activation.total}…`
                : `${p.items.length} ${p.items.length === 1 ? 'track' : 'tracks'}`
            }
            kind="album"
            artUrl={p.items.find((i) => i.artUrl)?.artUrl ?? null}
            // `tuning` is the row layer's own in-flight affordance (the spinner
            // before the title) — the same one a station shows while it tunes.
            tuning={!!mine}
            // Another playlist's run is in flight: starting a second would
            // fight it for the queue, and the door is closed at the preload
            // anyway. Dim rather than hide, so the list never reshapes.
            dimmed={!!running && !mine}
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
            onClick={running ? undefined : () => onActivate({ id: p.id, name: p.name })}
          />
        )
      })}
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
export function RecentTab(): React.JSX.Element {
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
        return (
          <MediaRow
            key={`${entry.at}-${entry.title ?? ''}`}
            attrs={{ 'data-tray-row': 'recent' }}
            title={title ?? '—'}
            subtitle={
              (entry.isRadio ? entry.title : [entry.artist, entry.album].filter(Boolean).join(' — ')) ||
              undefined
            }
            kind={entry.isRadio ? 'station' : 'track'}
            artUrl={entry.artUrl}
            // Radio and songless rows carry no identity to replay — no stream
            // URL is stored for them — so they read as history, not as buttons.
            dimmed={!ref}
            onClick={ref ? () => void playRefNow(ref) : undefined}
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
    <div className="h-full flex items-center justify-center px-6">
      <EmptyState icon={Icon} title={title} caption={hint} />
    </div>
  )
}
