import { useEffect, useRef, useState } from 'react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { cx } from '@/lib/format'
import { audioCaps, EQ_GAIN_MAX, EQ_GAIN_MIN } from '@shared/smoip'

// The 7-band table is fixed firmware-side (freq/filter/q never written by us);
// labels only — the live band list still comes from /zone/audio.
const BAND_LABELS = ['80', '120', '315', '800', '2k', '5k', '8k']
const GAIN_SPAN = EQ_GAIN_MAX - EQ_GAIN_MIN

/** Round to the slider's 0.5 dB steps and clamp to the official envelope. */
const snapGain = (g: number): number =>
  Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, Math.round(g * 2) / 2))

const fmtDb = (g: number): string =>
  `${g > 0 ? '+' : ''}${Number.isInteger(g) ? g : g.toFixed(1)}`

/**
 * Tone & EQ section on the Device screen — rendered ONLY when the streamer's
 * /zone/audio/spec says the controls exist and are writable (per-model; the
 * whole section vanishes on streamers without a DSP chain). Sliders commit on
 * release: one SMOIP frame per gesture, one logical control per frame (writes
 * are atomic firmware-side). External changes (official app, another
 * controller) arrive as /zone/audio pushes and move these controls live.
 */
export function ToneEq(): React.JSX.Element | null {
  const zoneAudio = useStore((s) => s.zoneAudio)
  const spec = useStore((s) => s.audioSpec)
  const caps = audioCaps(spec)
  if (!caps || !zoneAudio) return null

  const eq = zoneAudio.user_eq
  const tilt = zoneAudio.tilt_eq
  const balance = zoneAudio.balance

  return (
    <section className="space-y-3">
      <div className="microlabel">tone &amp; eq</div>
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-4" data-toneeq>
        {caps.userEq && eq && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-[13px] flex-1">Equalizer</span>
              <button
                onClick={() => void tt.command({ type: 'setEqBands', gains: BAND_LABELS.map(() => 0) })}
                disabled={eq.bands.every((b) => b.gain === 0)}
                className="text-[12px] px-2.5 h-7 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-95 transition-all disabled:opacity-40 disabled:hover:text-dim disabled:hover:ring-edge disabled:hover:bg-panel/70"
                data-eq-flat
              >
                Flat
              </button>
              <ToneSwitch
                checked={eq.enabled}
                label="Equalizer on"
                onChange={(enabled) => void tt.command({ type: 'setUserEq', enabled })}
              />
            </div>
            {/* Sliders stay live while the EQ is off (the firmware accepts band
                writes regardless) — the toggle governs whether it's applied. */}
            <div className={cx('flex items-end gap-1 transition-opacity', !eq.enabled && 'opacity-60')}>
              <div className="flex flex-col justify-between self-stretch pb-9 pr-1.5 text-right">
                <span className="text-[10px] text-faint leading-none">+{EQ_GAIN_MAX}</span>
                <span className="text-[10px] text-faint leading-none">0</span>
                <span className="text-[10px] text-faint leading-none">{EQ_GAIN_MIN}</span>
              </div>
              {eq.bands.slice(0, BAND_LABELS.length).map((band, i) => (
                <BandSlider
                  key={band.index}
                  label={BAND_LABELS[i]}
                  gain={band.gain}
                  onCommit={(gain) =>
                    void tt.command({ type: 'setEqBandGain', index: band.index, gain })
                  }
                />
              ))}
            </div>
          </div>
        )}

        {caps.tilt && tilt && (
          <div className="flex items-center gap-3 border-t border-edge pt-3.5" data-tilt>
            <span className="text-[13px] w-20 shrink-0">Tone tilt</span>
            <ToneSwitch
              checked={tilt.enabled}
              label="Tone tilt on"
              onChange={(enabled) => void tt.command({ type: 'setTiltEq', enabled })}
            />
            <div className={cx('flex-1 flex items-center gap-2.5', !tilt.enabled && 'opacity-60')}>
              <span className="text-[10.5px] text-faint shrink-0">darker</span>
              <CenteredSlider
                value={tilt.intensity}
                min={caps.tiltRange.min}
                max={caps.tiltRange.max}
                ariaLabel="Tone tilt intensity"
                onCommit={(intensity) => void tt.command({ type: 'setTiltIntensity', intensity })}
              />
              <span className="text-[10.5px] text-faint shrink-0">brighter</span>
              <span className="font-mono text-[11px] text-dim w-8 text-right shrink-0" data-tilt-value>
                {tilt.intensity > 0 ? `+${tilt.intensity}` : tilt.intensity}
              </span>
            </div>
          </div>
        )}

        {caps.balance && balance != null && (
          <div className="flex items-center gap-3 border-t border-edge pt-3.5" data-balance>
            <span className="text-[13px] w-20 shrink-0">Balance</span>
            <div className="flex-1 flex items-center gap-2.5">
              <span className="text-[10.5px] text-faint shrink-0">L</span>
              <CenteredSlider
                value={balance}
                min={caps.balanceRange.min}
                max={caps.balanceRange.max}
                ariaLabel="Balance"
                onCommit={(b) => void tt.command({ type: 'setBalance', balance: b })}
              />
              <span className="text-[10.5px] text-faint shrink-0">R</span>
              <span className="font-mono text-[11px] text-dim w-8 text-right shrink-0" data-balance-value>
                {balance === 0 ? '·' : balance < 0 ? `L${-balance}` : `R${balance}`}
              </span>
            </div>
          </div>
        )}

        <div className="text-[11.5px] text-faint">
          Applied inside the streamer&rsquo;s DSP. Changes made in the Cambridge Audio app show up
          here too.
        </div>
      </div>
    </section>
  )
}

/** SettingsScreen's MiniSwitch idiom, local to the tone panel. */
function ToneSwitch({
  checked,
  label,
  onChange
}: {
  checked: boolean
  label: string
  onChange(next: boolean): void
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors',
        checked ? 'bg-gold' : 'bg-veil2 ring-1 ring-edge'
      )}
    >
      <span
        className={cx(
          'absolute top-0.5 h-4 w-4 rounded-full bg-bg transition-all',
          checked ? 'left-[18px]' : 'left-0.5'
        )}
      />
    </button>
  )
}

/**
 * One vertical gain slider. The fill grows from the 0 dB line (up for boost,
 * down for cut) so the curve reads at a glance; commits on release in 0.5 dB
 * steps; Escape aborts the drag (Slider's contract).
 */
function BandSlider({
  label,
  gain,
  onCommit
}: {
  label: string
  gain: number
  onCommit(gain: number): void
}): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragGain, setDragGain] = useState<number | null>(null)

  const dragging = dragGain !== null
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDragGain(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragging])

  const gainFromEvent = (e: React.PointerEvent): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return 0
    const ratio = Math.max(0, Math.min(1, (rect.bottom - e.clientY) / rect.height))
    return snapGain(EQ_GAIN_MIN + ratio * GAIN_SPAN)
  }

  const shown = dragGain ?? Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, gain))
  const ratio = (shown - EQ_GAIN_MIN) / GAIN_SPAN
  const zeroRatio = (0 - EQ_GAIN_MIN) / GAIN_SPAN

  return (
    <div className="flex-1 flex flex-col items-center gap-1 min-w-0">
      <div
        role="slider"
        aria-label={`${label} Hz gain`}
        aria-valuemin={EQ_GAIN_MIN}
        aria-valuemax={EQ_GAIN_MAX}
        aria-valuenow={shown}
        data-eq-band={label}
        className="group relative h-36 w-full max-w-9 cursor-pointer no-drag flex justify-center"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragGain(gainFromEvent(e))
        }}
        onPointerMove={(e) => {
          if (dragGain !== null) setDragGain(gainFromEvent(e))
        }}
        onPointerUp={() => {
          if (dragGain === null) return
          const g = dragGain
          setDragGain(null)
          if (g !== gain) onCommit(g)
        }}
        onPointerCancel={() => setDragGain(null)}
      >
        <div ref={trackRef} className="relative w-[3px] h-full rounded-full bg-veil2">
          {/* hairline 0 dB tick across the track */}
          <div
            className="absolute left-1/2 -translate-x-1/2 w-3 h-px bg-edge2"
            style={{ bottom: `${zeroRatio * 100}%` }}
          />
          <div
            className="absolute left-0 right-0 rounded-full bg-gold"
            style={{
              bottom: `${Math.min(ratio, zeroRatio) * 100}%`,
              top: `${(1 - Math.max(ratio, zeroRatio)) * 100}%`
            }}
          />
          <div
            className={cx(
              'absolute left-1/2 -translate-x-1/2 translate-y-1/2 h-3 w-3 rounded-full bg-gold',
              'shadow-[0_0_8px_rgb(var(--gold-rgb)_/_0.7)] transition-opacity',
              dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
            style={{ bottom: `${ratio * 100}%` }}
          />
        </div>
      </div>
      <span
        className={cx(
          'font-mono text-[10px] leading-none',
          shown !== 0 ? 'text-gold' : 'text-faint'
        )}
        data-eq-gain={label}
      >
        {fmtDb(shown)}
      </span>
      <span className="text-[10.5px] text-faint leading-none">{label}</span>
    </div>
  )
}

/**
 * A horizontal ±range slider whose fill grows outward from the CENTER (tilt,
 * balance) — Slider.tsx fills from the left, which reads wrong for signed
 * values. Same pointer/Escape contract; integer steps; commit on release.
 */
function CenteredSlider({
  value,
  min,
  max,
  ariaLabel,
  onCommit
}: {
  value: number
  min: number
  max: number
  ariaLabel: string
  onCommit(value: number): void
}): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragValue, setDragValue] = useState<number | null>(null)

  const dragging = dragValue !== null
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDragValue(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragging])

  const valueFromEvent = (e: React.PointerEvent): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return 0
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    return Math.round(min + ratio * (max - min))
  }

  const shown = dragValue ?? Math.max(min, Math.min(max, value))
  const ratio = (shown - min) / (max - min)
  const centerRatio = (0 - min) / (max - min)

  return (
    <div
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      className="group relative h-4 flex-1 flex items-center cursor-pointer no-drag"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragValue(valueFromEvent(e))
      }}
      onPointerMove={(e) => {
        if (dragValue !== null) setDragValue(valueFromEvent(e))
      }}
      onPointerUp={() => {
        if (dragValue === null) return
        const v = dragValue
        setDragValue(null)
        if (v !== value) onCommit(v)
      }}
      onPointerCancel={() => setDragValue(null)}
    >
      <div ref={trackRef} className="relative h-[3px] w-full rounded-full bg-veil2">
        <div
          className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 h-[7px] w-px bg-edge2"
          style={{ left: `${centerRatio * 100}%` }}
        />
        <div
          className="absolute inset-y-0 rounded-full bg-gold"
          style={{
            left: `${Math.min(ratio, centerRatio) * 100}%`,
            right: `${(1 - Math.max(ratio, centerRatio)) * 100}%`
          }}
        />
        <div
          className={cx(
            'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full bg-gold',
            'shadow-[0_0_8px_rgb(var(--gold-rgb)_/_0.7)] transition-opacity',
            dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          style={{ left: `${ratio * 100}%` }}
        />
      </div>
    </div>
  )
}
