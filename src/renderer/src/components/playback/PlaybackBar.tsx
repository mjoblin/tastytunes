import { useState } from 'react'
import {
  Disc3,
  Moon,
  Power,
  RadioTower,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Square
} from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { usePlayhead } from '@/hooks/usePlayhead'
import { useSeekScrub } from '@/hooks/useSeekScrub'
import { cx, deriveNowPlaying, fmtTime } from '@/lib/format'
import { Slider } from '../controls/Slider'
import { ArtImage } from '../media/ArtImage'
import { VolumeCluster } from './VolumeCluster'
import { PlayPauseButton, TransportIconButton, useTransport } from './Transport'
import { SignalLamp } from '../device/SignalLamp'
import { SleepTimer } from './SleepTimer'
import { DeviceSwitcher } from '../device/DeviceSwitcher'

export function PlaybackBar(): React.JSX.Element {
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const setScreen = useStore((s) => s.setScreen)
  const { position, duration } = usePlayhead()
  const t = useTransport(duration)
  const { shownPosition, slider } = useSeekScrub(position, duration, t.seek)
  const [showRemaining, setShowRemaining] = useState(false)

  const waking = useStore((s) => s.waking)
  const meta = deriveNowPlaying(playState, nowPlaying)
  const { connected, powered, active } = t
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
          <ArtImage
            src={active ? meta.artUrl : null}
            fallback={
              meta.isRadio && active ? (
                <RadioTower size={22} className="text-faint" />
              ) : (
                <Disc3 size={22} className="text-faint" />
              )
            }
          />
        </div>
        <div className="min-w-0">
          <div className="font-display font-bold text-[15px] leading-tight tracking-tight text-ink truncate">
            {(active && meta.title) || '—'}
          </div>
          <div className="font-display text-[13px] leading-tight tracking-tight text-dim truncate mt-0.5">
            {(active && meta.subtitle) || ''}
          </div>
        </div>
      </button>

      {/* transport + playhead */}
      <div className="flex flex-col items-center justify-center gap-1 min-w-0">
        <div className="flex items-center gap-1">
          <TransportIconButton
            size="bar"
            tip="Shuffle"
            enabled={active && t.canShuffle}
            accent={t.shuffleOn}
            onClick={t.toggleShuffle}
          >
            <Shuffle size={12} />
          </TransportIconButton>
          <TransportIconButton
            size="bar"
            tip="Previous (←)"
            enabled={active && t.canPrev}
            onClick={t.prev}
          >
            <SkipBack size={18} />
          </TransportIconButton>

          <PlayPauseButton size="bar" tipHint=" (space)" className="mx-1.5" />

          <TransportIconButton size="bar" tip="Next (→)" enabled={active && t.canNext} onClick={t.next}>
            <SkipForward size={18} />
          </TransportIconButton>
          <TransportIconButton
            size="bar"
            tip="Repeat"
            enabled={active && t.canRepeat}
            accent={t.repeatOn}
            onClick={t.toggleRepeat}
          >
            <Repeat size={12} />
          </TransportIconButton>
          {t.canStop && meta.isRadio && (
            <TransportIconButton size="bar" tip="Stop" enabled={active} onClick={t.stop}>
              <Square size={13} fill="currentColor" strokeWidth={0} />
            </TransportIconButton>
          )}
        </div>

        <div className="flex items-center gap-3 w-full max-w-[560px]">
          <span className="font-mono text-[10.5px] text-faint w-11 text-right tabular-nums">
            {active ? fmtTime(shownPosition) : '–:––'}
          </span>
          <div className="flex-1">
            <Slider
              value={duration ? shownPosition / duration : 0}
              disabled={!active || !t.canSeek}
              ariaLabel="Playhead"
              scrubLabel={duration ? (v) => fmtTime(v * duration) : undefined}
              {...slider}
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
        {connected && !powered && (
          // Standby note lives beside its remedy (the power lamp), in the
          // space the volume cluster vacates — no layout shift anywhere.
          <div data-standby-note className="flex items-center gap-1.5 text-[12px] text-amber pr-1">
            {waking ? (
              <span className="motion-safe:animate-pulse">Waking…</span>
            ) : (
              <>
                <Moon size={12} strokeWidth={2} />
                <span>In standby — play anything to wake</span>
              </>
            )}
          </div>
        )}
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
