import {
  Disc3,
  Expand,
  Loader2,
  Pause,
  Play,
  RadioTower,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX
} from 'lucide-react'
import { tt } from '@/api'
import { CloseButton } from '@/components/CloseButton'
import { useStore } from '@/store'
import { usePlayhead } from '@/hooks/usePlayhead'
import { useArtAccent } from '@/hooks/useArtAccent'
import { useMotionPreference } from '@/hooks/useMotionPreference'
import { useTheme } from '@/hooks/useTheme'
import { useDisplayFont } from '@/hooks/useDisplayFont'
import { useWheelVolume } from '@/components/VolumeCluster'
import { ArtImage } from '@/components/ArtImage'
import { controlSet, cx, deriveNowPlaying, fmtTime } from '@/lib/format'

/**
 * The mini player window (?mini=1): a frameless always-on-top strip with art,
 * transport, and volume. Fed by the same pushes as the main window; hover
 * state arrives from the main process (CSS :hover can't fire over the drag
 * region).
 */
export function MiniPlayer(): React.JSX.Element {
  const connection = useStore((s) => s.connection)
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const zoneState = useStore((s) => s.zoneState)
  const queue = useStore((s) => s.queue)
  const systemPower = useStore((s) => s.systemPower)
  const settings = useStore((s) => s.settings)
  const hovered = useStore((s) => s.miniHover)
  const { position, duration } = usePlayhead()
  const onWheel = useWheelVolume()
  const theme = useTheme(settings.theme)
  useDisplayFont(settings.displayFont)

  const connected = connection.phase === 'connected'
  const powered = systemPower?.power === 'ON'
  const active = connected && powered
  const meta = deriveNowPlaying(playState, nowPlaying)
  const controls = controlSet(nowPlaying)
  useArtAccent(settings.accentFollowsArt && active ? meta.artUrl : null, theme)
  useMotionPreference(settings.motion)

  const state = playState?.state
  const playing = state === 'play'
  const busy = state === 'buffering' || state === 'connecting'
  const canToggle = controls.has('play_pause') || controls.has('play') || controls.has('pause')
  const canNext = controls.has('track_next')
  const canPrev = controls.has('track_previous')

  const muted = zoneState?.mute === true
  const hasVolume =
    zoneState != null &&
    (zoneState.pre_amp_mode === true ||
      (zoneState.cbus != null && !/^(off|none)$/i.test(zoneState.cbus)))

  // what's next in the queue
  const items = queue?.items ?? []
  const currentIdx = items.findIndex((i) => i.id === (queue?.play_id ?? playState?.queue_id))
  const next = currentIdx >= 0 ? (items[currentIdx + 1] ?? null) : null

  return (
    <div className="h-screen w-screen drag-region" onWheel={onWheel}>
      <div className="h-full w-full rounded-2xl bg-panel ring-1 ring-edge2 overflow-hidden flex shadow-[0_12px_40px_rgb(0_0_0_/_0.5)]">
        {/* art */}
        <div className="h-full aspect-square shrink-0 bg-raised flex items-center justify-center">
          <ArtImage
            src={active ? meta.artUrl : null}
            fallback={
              meta.isRadio && active ? (
                <RadioTower size={30} className="text-faint" />
              ) : (
                <Disc3 size={30} className="text-faint" />
              )
            }
          />
        </div>

        {/* current track pinned top, next track pinned bottom */}
        <div className="flex-1 min-w-0 flex flex-col justify-between px-4 py-3.5">
          {/* title row + window controls (revealed while the cursor is over the window) */}
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {/* min-heights + nbsp keep both lines occupying space during the
                  brief metadata gap on track changes, so the layout never shifts */}
              <div className="text-[12.5px] text-ink truncate leading-tight min-h-[15px]">
                {active ? (meta.title ?? ' ') : 'Nothing playing'}
              </div>
              <div className="text-[11px] text-dim truncate leading-tight mt-0.5 min-h-[13px]">
                {(active && meta.subtitle) || (connected ? ' ' : 'not connected')}
              </div>
            </div>
            <div
              className={cx(
                'flex items-center gap-0.5 -mt-0.5 -mr-1 transition-opacity',
                hovered ? 'opacity-100' : 'opacity-0'
              )}
            >
              <button
                data-tip="Open TastyTunes"
                aria-label="Open TastyTunes"
                onClick={() => {
                  void tt.showMain()
                  void tt.toggleMini()
                }}
                className="no-drag tip-bottom tip-end p-1 rounded text-faint hover:text-ink transition-colors"
              >
                <Expand size={12} />
              </button>
              <CloseButton
                onClick={() => void tt.toggleMini()}
                size={13}
                label="Close mini player"
                tip="Close mini player"
                className="no-drag tip-bottom tip-end"
              />
            </div>
          </div>

          {/* transport + volume + time */}
          <div className="flex items-center gap-1.5">
            <MiniButton enabled={active && canPrev} tip="Previous" onClick={() => void tt.command({ type: 'previousTrack' })}>
              <SkipBack size={14} />
            </MiniButton>
            <button
              data-tip={playing ? 'Pause' : 'Play'}
              aria-label={playing ? 'Pause' : 'Play'}
              disabled={!active || (!canToggle && !busy)}
              onClick={() => void tt.command({ type: 'togglePlayback' })}
              className={cx(
                'no-drag tip-top h-8 w-8 rounded-full flex items-center justify-center transition-all shrink-0',
                active && (canToggle || busy)
                  ? 'bg-gold text-bg motion-safe:hover:scale-105'
                  : 'bg-veil2 text-faint'
              )}
            >
              {busy ? (
                <Loader2 size={14} className="spin" />
              ) : playing ? (
                <Pause size={14} fill="currentColor" strokeWidth={0} />
              ) : (
                <Play size={14} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />
              )}
            </button>
            <MiniButton enabled={active && canNext} tip="Next" onClick={() => void tt.command({ type: 'nextTrack' })}>
              <SkipForward size={14} />
            </MiniButton>

            {active && hasVolume && (
              <button
                data-tip={muted ? 'Unmute' : 'Mute'}
                aria-label={muted ? 'Unmute' : 'Mute'}
                onClick={() => void tt.command({ type: 'setMute', mute: !muted })}
                className={cx(
                  'no-drag tip-top p-1 ml-0.5 rounded transition-colors',
                  muted ? 'text-gold' : 'text-faint hover:text-dim'
                )}
              >
                {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
            )}

            <div className="flex-1" />
            <span className="font-mono text-[9.5px] text-faint tabular-nums shrink-0">
              {active
                ? duration != null
                  ? `${fmtTime(position)} / ${fmtTime(duration)}`
                  : fmtTime(position)
                : ''}
            </span>
          </div>

          {/* next up */}
          <div className="microlabel truncate min-h-[13px]">
            {active && next?.metadata ? `next · ${next.metadata.title ?? next.metadata.name ?? ''}` : ''}
          </div>
        </div>
      </div>
    </div>
  )
}

function MiniButton({
  children,
  tip,
  enabled,
  onClick
}: {
  children: React.ReactNode
  tip: string
  enabled: boolean
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      data-tip={tip}
      aria-label={tip}
      disabled={!enabled}
      onClick={onClick}
      className={cx(
        'no-drag tip-top p-1 rounded transition-colors',
        enabled ? 'text-dim hover:text-ink' : 'text-faint/40'
      )}
    >
      {children}
    </button>
  )
}
