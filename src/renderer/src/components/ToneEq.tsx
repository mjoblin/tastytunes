import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useClampedPosition, usePopoverChrome } from '@/hooks/usePopover'
import { cx } from '@/lib/format'
import { audioCaps, EQ_GAIN_MAX, EQ_GAIN_MIN } from '@shared/smoip'

// The 7-band table is fixed firmware-side (freq/filter/q never written by us);
// labels only — the live band list still comes from /zone/audio.
const BAND_LABELS = ['80', '120', '315', '800', '2k', '5k', '8k']
const GAIN_SPAN = EQ_GAIN_MAX - EQ_GAIN_MIN

/**
 * Built-in gain-sets, mirroring the official app's preset NAMES (user
 * expectation) with OUR OWN conventional curves: the Cambridge app's presets
 * are client-side state inside that app — invisible on the wire — so their
 * actual values can't be read or imported, only the list echoed. User-saved
 * sets live in settings.eqPresets and render after these.
 */
const BUILTIN_EQ_PRESETS: Array<{ name: string; gains: number[] }> = [
  { name: 'Normal', gains: [0, 0, 0, 0, 0, 0, 0] },
  { name: 'Bass Boost', gains: [3, 2, 1, 0, 0, 0, 0] },
  { name: 'Bass Reduction', gains: [-4, -3, -1.5, 0, 0, 0, 0] },
  { name: 'Voice Clarity', gains: [-1, -1, 0, 1.5, 2.5, 2, 0] },
  { name: 'Treble Boost', gains: [0, 0, 0, 0, 1, 2.5, 3] },
  { name: 'Treble Reduction', gains: [0, 0, 0, 0, -1.5, -3, -4] },
  // the official app's home-theater trio, as sensible speech/cinema/V curves
  { name: 'TV', gains: [-2, -1, 0.5, 2, 2.5, 1, 0] },
  { name: 'Movie', gains: [3, 2, 0, -1, -0.5, 1, 2] },
  { name: 'Gaming', gains: [2.5, 1.5, -0.5, -1.5, -0.5, 1.5, 2.5] }
]

const gainsMatch = (bands: Array<{ gain: number }>, gains: number[]): boolean =>
  gains.length >= bands.length && bands.every((b, i) => Math.abs(b.gain - gains[i]) < 0.05)

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
export function ToneEq({ label = true }: { label?: boolean } = {}): React.JSX.Element | null {
  const zoneAudio = useStore((s) => s.zoneAudio)
  const spec = useStore((s) => s.audioSpec)
  const eqPresets = useStore((s) => s.settings.eqPresets)
  const saveSettings = useStore((s) => s.saveSettings)
  const [savePos, setSavePos] = useState<{ x: number; y: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const caps = audioCaps(spec)
  if (!caps || !zoneAudio) return null

  const eq = zoneAudio.user_eq
  const tilt = zoneAudio.tilt_eq
  const balance = zoneAudio.balance

  /** Apply a gain-set: ONE multi-band frame; a preset tap while the EQ is
   *  off also switches it on (its own frame — atomic rule) so the tap is
   *  audible, not a silent no-op. */
  const applyPreset = (gains: number[]): void => {
    void tt.command({ type: 'setEqBands', gains })
    if (eq && !eq.enabled) void tt.command({ type: 'setUserEq', enabled: true })
  }
  const saveNewPreset = async (name: string): Promise<void> => {
    if (!eq) return
    const gains = eq.bands.slice(0, BAND_LABELS.length).map((b) => b.gain)
    await saveSettings({
      eqPresets: [...eqPresets.filter((p) => p.name !== name), { name, gains }]
    })
    setSavePos(null)
  }
  const deletePreset = async (name: string): Promise<void> => {
    setConfirmDelete(null)
    await saveSettings({ eqPresets: eqPresets.filter((p) => p.name !== name) })
  }

  return (
    <section className="space-y-3">
      {/* the Device screen's tab bar names this panel — no double label there */}
      {label && <div className="microlabel">tone &amp; eq</div>}
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-4" data-toneeq>
        {caps.userEq && eq && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-[13px] flex-1">Equalizer</span>
              <ToneSwitch
                checked={eq.enabled}
                label="Equalizer on"
                onChange={(enabled) => void tt.command({ type: 'setUserEq', enabled })}
              />
            </div>
            {/* Sliders stay live while the EQ is off (the firmware accepts band
                writes regardless) — the toggle governs whether it's applied. */}
            <div className={cx('flex items-end gap-1 transition-opacity', !eq.enabled && 'opacity-60')}>
              {/* The scale column mirrors a band column's exact structure —
                  the h-36 block plus INVISIBLE value/freq spacers — so its
                  labels sit level with the tracks: "0" lands exactly on the
                  zero tick (it used to float mid-column, user catch). */}
              <div className="flex flex-col items-end gap-1 pr-1.5">
                <div className="relative h-36 w-5 text-right">
                  <span className="absolute right-0 top-0 -translate-y-1/2 text-[10px] text-faint leading-none">
                    +{EQ_GAIN_MAX}
                  </span>
                  <span
                    className="absolute right-0 translate-y-1/2 text-[10px] text-faint leading-none"
                    style={{ bottom: `${((0 - EQ_GAIN_MIN) / GAIN_SPAN) * 100}%` }}
                  >
                    0
                  </span>
                  <span className="absolute right-0 bottom-0 translate-y-1/2 text-[10px] text-faint leading-none">
                    {EQ_GAIN_MIN}
                  </span>
                </div>
                <span className="font-mono text-[10px] leading-none invisible">0</span>
                <span className="text-[10.5px] leading-none invisible">80</span>
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

            {/* gain-set chips: built-ins, then user-saved, then Save. The
                active chip is derived (gains match), so presets applied
                before a manual tweak un-light themselves honestly. */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1" data-eq-presets>
              {BUILTIN_EQ_PRESETS.map((p) => {
                const active = gainsMatch(eq.bands, p.gains)
                return (
                  <button
                    key={p.name}
                    onClick={() => applyPreset(p.gains)}
                    data-eq-preset={p.name}
                    className={cx(
                      'rounded-full px-3 py-1 text-[12px] ring-1 transition-all motion-safe:active:scale-95',
                      active
                        ? 'ring-gold/50 bg-golddim text-gold'
                        : 'ring-edge bg-panel/60 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70'
                    )}
                  >
                    {p.name}
                  </button>
                )
              })}
              {eqPresets.map((p) => {
                const active = gainsMatch(eq.bands, p.gains)
                const confirming = confirmDelete === p.name
                return (
                  <span
                    key={p.name}
                    className={cx(
                      'group/chip flex items-center rounded-full ring-1 transition-all',
                      active
                        ? 'ring-gold/50 bg-golddim text-gold'
                        : 'ring-edge bg-panel/60 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70'
                    )}
                  >
                    <button
                      onClick={() => applyPreset(p.gains)}
                      data-eq-preset={p.name}
                      className="pl-3 pr-1 py-1 text-[12px] motion-safe:active:scale-95 transition-all"
                    >
                      {p.name}
                    </button>
                    <button
                      onClick={() => (confirming ? void deletePreset(p.name) : setConfirmDelete(p.name))}
                      onMouseLeave={() => confirming && setConfirmDelete(null)}
                      data-tip={confirming ? undefined : 'Delete preset'}
                      aria-label={`Delete preset ${p.name}`}
                      className={cx(
                        'mr-1 rounded-full p-0.5 transition-all',
                        confirming
                          ? 'bg-alert text-white px-1.5 text-[10.5px]'
                          : 'text-faint hover:text-alert opacity-0 group-hover/chip:opacity-100'
                      )}
                    >
                      {confirming ? 'sure?' : <X size={11} />}
                    </button>
                  </span>
                )
              })}
              <button
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setSavePos({ x: r.left, y: r.bottom + 6 })
                }}
                data-eq-save-preset
                className="rounded-full px-3 py-1 text-[12px] ring-1 ring-edge bg-panel/60 text-amber hover:brightness-110 hover:ring-edge2 transition-all motion-safe:active:scale-95"
              >
                Save as preset…
              </button>
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
            {/* end labels carry FIXED widths (and balance mirrors the switch
                with a spacer) so the tilt and balance tracks span the same
                pixels — their center ticks line up vertically */}
            <div className={cx('flex-1 flex items-center gap-2.5', !tilt.enabled && 'opacity-60')}>
              <span className="w-12 text-right text-[10.5px] text-faint shrink-0">darker</span>
              <CenteredSlider
                value={tilt.intensity}
                min={caps.tiltRange.min}
                max={caps.tiltRange.max}
                ariaLabel="Tone tilt intensity"
                onCommit={(intensity) => void tt.command({ type: 'setTiltIntensity', intensity })}
              />
              <span className="w-12 text-[10.5px] text-faint shrink-0">brighter</span>
              <span className="font-mono text-[11px] text-dim w-8 text-right shrink-0" data-tilt-value>
                {tilt.intensity > 0 ? `+${tilt.intensity}` : tilt.intensity}
              </span>
            </div>
          </div>
        )}

        {caps.balance && balance != null && (
          <div className="flex items-center gap-3 border-t border-edge pt-3.5" data-balance>
            <span className="text-[13px] w-20 shrink-0">Balance</span>
            {/* stand-in for the tilt row's switch — keeps the tracks aligned */}
            <span className="w-9 shrink-0" aria-hidden />
            <div className="flex-1 flex items-center gap-2.5">
              <span className="w-12 text-right text-[10.5px] text-faint shrink-0">L</span>
              <CenteredSlider
                value={balance}
                min={caps.balanceRange.min}
                max={caps.balanceRange.max}
                ariaLabel="Balance"
                onCommit={(b) => void tt.command({ type: 'setBalance', balance: b })}
              />
              <span className="w-12 text-[10.5px] text-faint shrink-0">R</span>
              {/* centered = "0", matching the tilt readout (a lone middot
                  here read as a mystery speck — user catch) */}
              <span className="font-mono text-[11px] text-dim w-8 text-right shrink-0" data-balance-value>
                {balance === 0 ? '0' : balance < 0 ? `L${-balance}` : `R${balance}`}
              </span>
            </div>
          </div>
        )}

        <div className="text-[11.5px] text-faint">
          Applied inside the streamer&rsquo;s DSP. Changes made in the Cambridge Audio app show up
          here too. Presets are TastyTunes&rsquo;s own — the Cambridge app keeps its presets to
          itself.
        </div>
      </div>

      {savePos && (
        <SaveEqPresetPopover
          x={savePos.x}
          y={savePos.y}
          existing={eqPresets.map((p) => p.name)}
          onClose={() => setSavePos(null)}
          onSave={saveNewPreset}
        />
      )}
    </section>
  )
}

/** Name-and-save popover for the current gain curve (PresetSavePanel idiom). */
function SaveEqPresetPopover({
  x,
  y,
  existing,
  onClose,
  onSave
}: {
  x: number
  y: number
  existing: string[]
  onClose(): void
  onSave(name: string): Promise<void>
}): React.JSX.Element {
  usePopoverChrome(onClose)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pos = useClampedPosition(boxRef, x, y)
  const [name, setName] = useState('')
  const trimmed = name.trim()
  // built-in names stay reserved — a user "Flat" that isn't flat would lie
  const reserved = BUILTIN_EQ_PRESETS.some(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase()
  )
  const replaces = existing.some((n) => n.toLowerCase() === trimmed.toLowerCase())
  const canSave = trimmed.length > 0 && !reserved
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={boxRef}
        className="fixed z-50 w-[248px] rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-3 space-y-2.5"
        style={pos}
        data-eq-save-popover
      >
        <div className="text-[13px] font-medium">Save current EQ as a preset</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) void onSave(trimmed)
          }}
          placeholder="Preset name"
          className="w-full bg-bg rounded-lg ring-1 ring-edge focus:ring-edge2 outline-none px-3 py-1.5 text-[13px] placeholder:text-faint"
        />
        <button
          onClick={() => void onSave(trimmed)}
          disabled={!canSave}
          className="w-full px-3 py-2 rounded-lg bg-amber text-bg text-[13px] font-medium disabled:opacity-50 motion-safe:active:scale-95 transition-all"
          data-eq-save-commit
        >
          {replaces ? 'Replace preset' : 'Save preset'}
        </button>
        {reserved && (
          <div className="text-[10.5px] text-faint leading-snug">
            That name belongs to a built-in preset — pick another.
          </div>
        )}
      </div>
    </>,
    document.body
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
        {/* bare track + always-visible thumb — a mixing-desk fader, not a
            bar chart (a zero-anchored fill read as "gold bars", user pass) */}
        <div ref={trackRef} className="relative w-[3px] h-full rounded-full bg-veil2">
          {/* hairline 0 dB tick across the track */}
          <div
            className="absolute left-1/2 -translate-x-1/2 w-3 h-px bg-edge2"
            style={{ bottom: `${zeroRatio * 100}%` }}
          />
          <div
            className={cx(
              'absolute left-1/2 -translate-x-1/2 translate-y-1/2 h-3.5 w-3.5 rounded-full bg-gold',
              'transition-shadow',
              dragging
                ? 'shadow-[0_0_10px_rgb(var(--gold-rgb)_/_0.8)]'
                : 'group-hover:shadow-[0_0_8px_rgb(var(--gold-rgb)_/_0.7)]'
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
