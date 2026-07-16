import { useEffect, useState } from 'react'
import {
  Disc3,
  Loader2,
  Pause,
  Play,
  Power,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Square
} from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { usePlayhead } from '@/hooks/usePlayhead'
import { controlSet, cx, deriveNowPlaying, fmtTime } from '@/lib/format'
import { Slider } from './Slider'
import { VolumeCluster } from './VolumeCluster'
import { SignalLamp } from './SignalLamp'
import { SleepTimer } from './SleepTimer'
import { DeviceSwitcher } from './DeviceSwitcher'

export function PlaybackBar(): React.JSX.Element {
  const connection = useStore((s) => s.connection)
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const systemPower = useStore((s) => s.systemPower)
  const setScreen = useStore((s) => s.setScreen)
  const { position, duration } = usePlayhead()
  const [scrub, setScrub] = useState<number | null>(null)
  // Seek target held after release until the device's playhead catches up —
  // otherwise the thumb snaps back to the stale position, then jumps forward.
  const [seekHold, setSeekHold] = useState<number | null>(null)
  const [showRemaining, setShowRemaining] = useState(false)

  useEffect(() => {
    if (seekHold == null) return
    if (Math.abs(position - seekHold) < 2) {
      setSeekHold(null)
      return
    }
    const t = setTimeout(() => setSeekHold(null), 3000)
    return () => clearTimeout(t)
  }, [seekHold, position])

  const connected = connection.phase === 'connected'
  const powered = systemPower?.power === 'ON'
  const meta = deriveNowPlaying(playState, nowPlaying)
  const controls = controlSet(nowPlaying)

  const state = playState?.state
  const playing = state === 'play'
  const busy = state === 'buffering' || state === 'connecting'

  const canToggle = controls.has('play_pause') || controls.has('play') || controls.has('pause')
  const canNext = controls.has('track_next')
  const canPrev = controls.has('track_previous')
  const canSeek = controls.has('seek') && duration != null && duration > 0
  const canShuffle = controls.has('toggle_shuffle')
  const canRepeat = controls.has('toggle_repeat')
  const canStop = controls.has('stop')

  const repeatOn = playState?.mode_repeat === 'all'
  const shuffleOn = playState?.mode_shuffle === 'all'

  const active = connected && powered
  const shownPosition = scrub != null && duration ? scrub * duration : (seekHold ?? position)
  const ambientWindow = useStore((s) => s.ambientWindowActive)

  return (
    <footer
      className={cx(
        // side columns flex down on narrow windows instead of squeezing the volume slider
        'h-[92px] shrink-0 border-t border-edge grid grid-cols-[minmax(160px,280px)_1fr_minmax(215px,340px)] items-center gap-6 px-4 transition-colors',
        ambientWindow ? 'bg-transparent' : 'bg-panel/80 backdrop-blur'
      )}
    >
      {/* now playing mini */}
      <button
        className={cx(
          'flex items-center gap-3 min-w-0 text-left rounded-lg p-1.5 -m-1.5 transition-colors',
          active && 'hover:bg-veil'
        )}
        onClick={() => setScreen('now-playing')}
        disabled={!active}
      >
        <div className="h-[52px] w-[52px] shrink-0 rounded-md overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
          {active && meta.artUrl ? (
            <img src={meta.artUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <Disc3 size={22} className="text-faint" />
          )}
        </div>
        <div className="min-w-0">
          <div className="text-[13px] text-ink truncate">{(active && meta.title) || '—'}</div>
          <div className="text-[12px] text-dim truncate">{(active && meta.subtitle) || ''}</div>
        </div>
      </button>

      {/* transport + playhead */}
      <div className="flex flex-col items-center justify-center gap-1 min-w-0">
        <div className="flex items-center gap-1">
          <TransportButton
            tip="Shuffle"
            enabled={active && canShuffle}
            accent={shuffleOn}
            onClick={() => void tt.command({ type: 'setShuffle', mode: shuffleOn ? 'off' : 'all' })}
          >
            <Shuffle size={15} />
          </TransportButton>
          <TransportButton
            tip="Previous (←)"
            enabled={active && canPrev}
            onClick={() => void tt.command({ type: 'previousTrack' })}
          >
            <SkipBack size={18} />
          </TransportButton>

          <button
            data-tip={playing ? 'Pause (space)' : 'Play (space)'}
            aria-label={playing ? 'Pause (space)' : 'Play (space)'}
            disabled={!active || (!canToggle && !busy)}
            onClick={() => void tt.command({ type: 'togglePlayback' })}
            className={cx(
              'tip-top mx-1.5 h-11 w-11 rounded-full flex items-center justify-center transition-all',
              active && (canToggle || busy)
                ? 'bg-gold text-bg motion-safe:hover:scale-105 shadow-[0_0_20px_rgb(var(--gold-rgb)_/_0.35)]'
                : 'bg-veil2 text-faint'
            )}
          >
            {busy ? (
              <Loader2 size={20} className="spin" />
            ) : playing ? (
              <Pause size={20} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play size={20} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />
            )}
          </button>

          <TransportButton
            tip="Next (→)"
            enabled={active && canNext}
            onClick={() => void tt.command({ type: 'nextTrack' })}
          >
            <SkipForward size={18} />
          </TransportButton>
          <TransportButton
            tip="Repeat"
            enabled={active && canRepeat}
            accent={repeatOn}
            onClick={() => void tt.command({ type: 'setRepeat', mode: repeatOn ? 'off' : 'all' })}
          >
            <Repeat size={15} />
          </TransportButton>
          {canStop && meta.isRadio && (
            <TransportButton
              tip="Stop"
              enabled={active}
              onClick={() => void tt.command({ type: 'stop' })}
            >
              <Square size={13} fill="currentColor" strokeWidth={0} />
            </TransportButton>
          )}
        </div>

        <div className="flex items-center gap-3 w-full max-w-[560px]">
          <span className="font-mono text-[10.5px] text-faint w-11 text-right tabular-nums">
            {active ? fmtTime(shownPosition) : '–:––'}
          </span>
          <div className="flex-1">
            <Slider
              value={duration ? shownPosition / duration : 0}
              disabled={!active || !canSeek}
              ariaLabel="Playhead"
              onScrub={setScrub}
              onCancel={() => setScrub(null)}
              onCommit={(v) => {
                setScrub(null)
                if (duration) {
                  setSeekHold(v * duration)
                  void tt.command({ type: 'seek', positionSecs: v * duration })
                }
              }}
            />
          </div>
          <button
            className="tip-top font-mono text-[10.5px] text-faint w-11 text-left tabular-nums hover:text-dim"
            onClick={() => setShowRemaining((r) => !r)}
            data-tip="Toggle remaining time"
            aria-label="Toggle remaining time"
          >
            {active && duration != null
              ? showRemaining
                ? `-${fmtTime(Math.max(0, duration - shownPosition))}`
                : fmtTime(duration)
              : '–:––'}
          </button>
        </div>
      </div>

      {/* signal + volume + devices + power */}
      <div className="flex items-center justify-end gap-2 pr-2">
        {active && <SignalLamp />}
        {active && <VolumeCluster />}
        {active && <SleepTimer />}
        <DeviceSwitcher />
        <button
          data-tip={powered ? 'Standby' : 'Power on'}
          aria-label={powered ? 'Standby' : 'Power on'}
          disabled={!connected}
          onClick={() => void tt.command({ type: 'power', power: 'toggle' })}
          className={cx(
            'tip-top p-2 rounded-full flex items-center justify-center transition-all',
            powered
              ? 'bg-gold text-bg shadow-[0_0_14px_rgb(var(--gold-rgb)_/_0.35)] motion-safe:hover:scale-110 hover:shadow-[0_0_20px_rgb(var(--gold-rgb)_/_0.5)]'
              : connected
                ? 'bg-veil2 text-faint hover:bg-golddim hover:text-gold motion-safe:hover:scale-110'
                : 'bg-veil2 text-faint/40'
          )}
        >
          <Power size={16} strokeWidth={2.2} />
        </button>
      </div>
    </footer>
  )
}

function TransportButton({
  children,
  tip,
  enabled,
  accent,
  onClick
}: {
  children: React.ReactNode
  tip: string
  enabled: boolean
  accent?: boolean
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      data-tip={tip}
      aria-label={tip}
      disabled={!enabled}
      onClick={onClick}
      className={cx(
        'tip-top p-2 rounded-md transition-colors',
        !enabled ? 'text-faint/40' : accent ? 'text-gold' : 'text-dim hover:text-ink'
      )}
    >
      {children}
    </button>
  )
}
