import { useEffect, useRef, useState } from 'react'
import { Minus, Plus, Volume2, VolumeX } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { cx } from '@/lib/format'
import { Slider } from './Slider'

/** Accumulate trackpad/wheel deltas into discrete volume nudges. */
export function useWheelVolume(): (e: React.WheelEvent) => void {
  const acc = useRef(0)
  const lastSend = useRef(0)
  return (e) => {
    acc.current += e.deltaY
    if (Math.abs(acc.current) < 40) return
    const direction = acc.current < 0 ? 1 : -1
    acc.current = 0
    const now = Date.now()
    if (now - lastSend.current < 80) return
    lastSend.current = now
    void tt.command({ type: 'volumeStepChange', delta: direction * (e.shiftKey ? 5 : 1) })
  }
}

/**
 * Volume is only offered when the streamer can actually control it: Pre-Amp mode
 * (absolute level) or Control Bus mode (up/down nudges only). Otherwise render
 * nothing — the amplifier owns the volume.
 */
export function VolumeCluster(): React.JSX.Element | null {
  const zoneState = useStore((s) => s.zoneState)
  const volumeLimit = useStore((s) => s.settings.volumeLimitPercent)
  const onWheel = useWheelVolume()
  const [scrub, setScrub] = useState<number | null>(null)
  // Level we just committed, held until the device echoes it back — otherwise
  // the slider snaps to the stale reported volume for a beat after release.
  const [hold, setHold] = useState<number | null>(null)
  const lastSent = useRef<{ at: number; level: number } | null>(null)

  if (!zoneState) return null
  const preAmp = zoneState.pre_amp_mode === true
  const cbus = zoneState.cbus != null && !/^(off|none)$/i.test(zoneState.cbus)
  if (!preAmp && !cbus) return null

  const muted = zoneState.mute === true
  const percent = zoneState.volume_percent
  const step = zoneState.volume_step
  const max = volumeLimit ?? 100

  const muteButton = (
    <button
      onClick={() => void tt.command({ type: 'setMute', mute: !muted })}
      className={cx(
        'tip-top p-1.5 rounded-md transition-colors',
        // gold = engaged state (matches shuffle/repeat), not red: muting isn't an error
        muted ? 'text-gold' : 'text-dim hover:text-ink'
      )}
      data-tip={muted ? 'Unmute (m)' : 'Mute (m)'}
      aria-label={muted ? 'Unmute (m)' : 'Mute (m)'}
    >
      {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
    </button>
  )

  if (!preAmp) {
    // Control Bus: relative nudges only. (No tooltip on the wrapper — it would
    // fight the buttons' tips; scroll-to-adjust is in the shortcuts overlay.)
    return (
      <div className="flex items-center gap-1" onWheel={onWheel}>
        {muteButton}
        <button
          onClick={() => void tt.command({ type: 'volumeStepChange', delta: -1 })}
          className="tip-top p-1.5 rounded-md text-dim hover:text-ink transition-colors"
          data-tip="Volume down (↓)"
          aria-label="Volume down (↓)"
        >
          <Minus size={15} />
        </button>
        <button
          onClick={() => void tt.command({ type: 'volumeStepChange', delta: 1 })}
          className="tip-top p-1.5 rounded-md text-dim hover:text-ink transition-colors"
          data-tip="Volume up (↑)"
          aria-label="Volume up (↑)"
        >
          <Plus size={15} />
        </button>
        <span className="microlabel">cbus</span>
      </div>
    )
  }

  // Pre-Amp mode: absolute level. Prefer percent when the model reports it.
  const usingPercent = percent != null
  const deviceLevel = usingPercent ? percent : step
  const levelNow = hold ?? deviceLevel
  const shown = levelNow != null ? levelNow / (usingPercent ? 100 : 30) : 0

  const toLevel = (v: number): number => Math.round(v * (usingPercent ? max : 30))
  const send = (level: number): void => {
    if (usingPercent) void tt.command({ type: 'setVolumePercent', percent: level })
    else void tt.command({ type: 'setVolumeStep', step: level })
  }
  // Live volume while dragging, throttled: at most one send per 150ms and only
  // when the level actually changed.
  const scrubbing = (v: number): void => {
    setScrub(v)
    const level = toLevel(v)
    const now = Date.now()
    const last = lastSent.current
    if (last && (last.level === level || now - last.at < 150)) return
    lastSent.current = { at: now, level }
    send(level)
  }
  const commit = (v: number): void => {
    setScrub(null)
    const level = toLevel(v)
    setHold(level)
    lastSent.current = null
    send(level)
  }

  // Release the hold once the device reports (about) the committed level, or
  // give up quietly if it never does.
  useEffect(() => {
    if (hold == null) return
    if (deviceLevel != null && Math.abs(deviceLevel - hold) <= 1) {
      setHold(null)
      return
    }
    const t = setTimeout(() => setHold(null), 2000)
    return () => clearTimeout(t)
  }, [hold, deviceLevel])

  // While dragging, show the level about to be set (gold = pending).
  const pendingLevel = scrub != null ? toLevel(scrub) : null

  return (
    // min-w keeps the slider usable no matter how tight the right cluster gets —
    // it never collapses toward zero.
    <div className="flex items-center gap-2 w-44 min-w-[150px]" onWheel={onWheel}>
      {muteButton}
      <div className={cx('flex-1', muted && 'opacity-40')}>
        <Slider
          value={usingPercent ? shown * (100 / max) : shown}
          onScrub={scrubbing}
          onCancel={() => setScrub(null)}
          onCommit={commit}
          ariaLabel="Volume"
        />
      </div>
      <span
        className={cx(
          // ml matches the visual gap on the mute-icon side (button padding +
          // flex gap), so the slider sits centered between icon and readout
          'font-mono text-[11px] w-7 ml-1.5 text-left tabular-nums',
          pendingLevel != null ? 'text-gold' : 'text-dim'
        )}
      >
        {pendingLevel ?? levelNow ?? '–'}
      </span>
    </div>
  )
}
