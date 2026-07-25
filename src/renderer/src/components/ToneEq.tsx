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

// NO built-in preset curves — a deliberate user decision (2026-07-19), don't
// re-add. Mirroring the official app's preset NAMES with invented curves
// would mislead: its presets are client-side state inside the Cambridge app
// (invisible on the wire), so "TV" here could never sound like "TV" there.
// Presets in TastyTunes are exactly the user's own saved gain-sets
// (settings.eqPresets); the one built-in affordance is the Flat RESET button.

const gainsMatch = (bands: Array<{ gain: number }>, gains: number[]): boolean =>
  gains.length >= bands.length && bands.every((b, i) => Math.abs(b.gain - gains[i]) < 0.05)

/**
 * Throttled live writes while a slider drags (~one frame per interval,
 * trailing edge keeps the latest value) so tilt/balance are HEARD as they
 * move, not only on release. Value-deduped; the release commit still sends
 * the definitive value through the normal path.
 */
function useLiveWrite(send: (v: number) => void, ms = 150): (v: number) => void {
  const st = useRef<{
    lastAt: number
    lastSent: number | null
    queued: number | null
    timer: ReturnType<typeof setTimeout> | null
  }>({ lastAt: 0, lastSent: null, queued: null, timer: null })
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    const s = st.current
    return () => {
      if (s.timer) clearTimeout(s.timer)
    }
  }, [])
  return (v) => {
    const s = st.current
    if (v === s.lastSent || v === s.queued) return
    const now = Date.now()
    if (s.timer == null && now - s.lastAt >= ms) {
      s.lastAt = now
      s.lastSent = v
      sendRef.current(v)
      return
    }
    s.queued = v
    if (s.timer == null) {
      s.timer = setTimeout(
        () => {
          s.timer = null
          const q = s.queued
          s.queued = null
          if (q != null && q !== s.lastSent) {
            s.lastAt = Date.now()
            s.lastSent = q
            sendRef.current(q)
          }
        },
        Math.max(0, ms - (now - s.lastAt))
      )
    }
  }
}

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
  const showToast = useStore((s) => s.showToast)

  // Live-hold for tilt/balance: shows the drag value while scrubbing and
  // HOLDS the committed value until the streamer's echo lands (releasing
  // used to flash the stale value for the round-trip). Cleared when the
  // store confirms; a 3s fallback reverts honestly if a write ever fails.
  // (Hooks live above the early return — house rule.)
  const [tiltHold, setTiltHold] = useState<number | null>(null)
  const [balanceHold, setBalanceHold] = useState<number | null>(null)
  const tiltNow = zoneAudio?.tilt_eq?.intensity ?? null
  const balanceNow = zoneAudio?.balance ?? null
  useEffect(() => {
    if (tiltHold != null && tiltNow != null && Math.round(tiltHold) === tiltNow) setTiltHold(null)
  }, [tiltHold, tiltNow])
  useEffect(() => {
    if (balanceHold != null && balanceNow != null && Math.round(balanceHold) === balanceNow)
      setBalanceHold(null)
  }, [balanceHold, balanceNow])
  useEffect(() => {
    if (tiltHold == null) return
    const t = setTimeout(() => setTiltHold(null), 3000)
    return () => clearTimeout(t)
  }, [tiltHold])
  useEffect(() => {
    if (balanceHold == null) return
    const t = setTimeout(() => setBalanceHold(null), 3000)
    return () => clearTimeout(t)
  }, [balanceHold])

  // Live drag writes (throttled): the device follows the drag so the change
  // is heard as it happens. Pre-drag values are remembered for Escape —
  // intermediate values have already been sent, so cancel must RESTORE.
  const tiltLive = useLiveWrite((intensity) => void tt.command({ type: 'setTiltIntensity', intensity }))
  const balanceLive = useLiveWrite((balance) => void tt.command({ type: 'setBalance', balance }))
  const tiltStart = useRef<number | null>(null)
  const balanceStart = useRef<number | null>(null)

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
  /**
   * Instant, with an undo behind it — the two-tap "sure?" that used to guard
   * this is retired. An EQ preset is one small local item ({name, gains}), so
   * the rollback is exact, and the standing rule is that a confirm is for what
   * CAN'T be undone. The device presets keep their confirm precisely because
   * they can't (no objectId to re-save from, and their names are editable, so
   * a name isn't a content identity).
   */
  const deletePreset = async (name: string): Promise<void> => {
    const index = eqPresets.findIndex((p) => p.name === name)
    const removed = eqPresets[index]
    if (!removed) return
    await saveSettings({ eqPresets: eqPresets.filter((p) => p.name !== name) })
    showToast({
      kind: 'success',
      text: `Deleted “${name}”`,
      action: { label: 'Undo', undo: () => restorePreset(index, removed) }
    })
  }

  /** Back into the list AS IT IS NOW, at its old spot — a preset saved while
   *  the offer was up must survive the undo. */
  const restorePreset = (index: number, preset: { name: string; gains: number[] }): void => {
    const live = useStore.getState().settings.eqPresets
    if (live.some((p) => p.name === preset.name)) return
    const next = [...live]
    next.splice(Math.min(index, next.length), 0, preset)
    void saveSettings({ eqPresets: next })
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
              {/* a RESET utility, not a preset — one multi-band all-zeros frame */}
              <button
                onClick={() => void tt.command({ type: 'setEqBands', gains: BAND_LABELS.map(() => 0) })}
                disabled={eq.bands.every((b) => b.gain === 0)}
                data-eq-flat
                className="text-[12px] px-2.5 h-7 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-95 transition-all disabled:opacity-40 disabled:hover:text-dim disabled:hover:ring-edge disabled:hover:bg-panel/70"
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

            {/* The user's own saved gain-sets, always labeled as TastyTunes's:
                the Cambridge app's presets are unreadable client-side state
                in THAT app, and pretending otherwise here would mislead. The
                active chip is derived (gains match), so a preset un-lights
                itself honestly after a manual tweak. */}
            <div className="space-y-1.5 pt-1">
              <div className="microlabel">tastytunes presets</div>
              <div className="flex flex-wrap items-center gap-1.5" data-eq-presets>
              {eqPresets.map((p) => {
                const active = gainsMatch(eq.bands, p.gains)
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
                      onClick={() => void deletePreset(p.name)}
                      data-tip="Delete preset"
                      aria-label={`Delete preset ${p.name}`}
                      className="mr-1 rounded-full p-0.5 text-faint hover:text-alert opacity-0 group-hover/chip:opacity-100 transition-all"
                    >
                      <X size={11} />
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
                value={tiltHold ?? tilt.intensity}
                min={caps.tiltRange.min}
                max={caps.tiltRange.max}
                ariaLabel="Tone tilt intensity"
                onScrub={(v) => {
                  if (tiltHold == null) tiltStart.current = tilt.intensity
                  setTiltHold(v)
                  // audible only while the tilt is enabled — no silent writes
                  if (tilt.enabled) tiltLive(v)
                }}
                onCancel={() => {
                  if (tilt.enabled && tiltStart.current != null)
                    void tt.command({ type: 'setTiltIntensity', intensity: tiltStart.current })
                  setTiltHold(tiltStart.current)
                }}
                onCommit={(intensity) => {
                  setTiltHold(intensity)
                  void tt.command({ type: 'setTiltIntensity', intensity })
                }}
              />
              <span className="w-12 text-[10.5px] text-faint shrink-0">brighter</span>
              <span className="font-mono text-[11px] text-dim w-8 text-right shrink-0" data-tilt-value>
                {(() => {
                  const v = Math.round(tiltHold ?? tilt.intensity)
                  return v > 0 ? `+${v}` : v
                })()}
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
                value={balanceHold ?? balance}
                min={caps.balanceRange.min}
                max={caps.balanceRange.max}
                ariaLabel="Balance"
                onScrub={(v) => {
                  if (balanceHold == null) balanceStart.current = balance
                  setBalanceHold(v)
                  balanceLive(v)
                }}
                onCancel={() => {
                  if (balanceStart.current != null)
                    void tt.command({ type: 'setBalance', balance: balanceStart.current })
                  setBalanceHold(balanceStart.current)
                }}
                onCommit={(b) => {
                  setBalanceHold(b)
                  void tt.command({ type: 'setBalance', balance: b })
                }}
              />
              <span className="w-12 text-[10.5px] text-faint shrink-0">R</span>
              {/* centered = "0", matching the tilt readout (a lone middot
                  here read as a mystery speck — user catch) */}
              <span className="font-mono text-[11px] text-dim w-8 text-right shrink-0" data-balance-value>
                {(() => {
                  const v = Math.round(balanceHold ?? balance)
                  return v === 0 ? '0' : v < 0 ? `L${-v}` : `R${v}`
                })()}
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
  const replaces = existing.some((n) => n.toLowerCase() === trimmed.toLowerCase())
  const canSave = trimmed.length > 0
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
  // Committed-but-unconfirmed gain: shown until the streamer's echo lands
  // (releasing used to flash the stale store value for the round-trip);
  // cleared on confirmation, 3s fallback reverts honestly on a failed write.
  const [pending, setPending] = useState<number | null>(null)
  useEffect(() => {
    if (pending != null && Math.abs(gain - pending) < 0.05) setPending(null)
  }, [gain, pending])
  useEffect(() => {
    if (pending == null) return
    const t = setTimeout(() => setPending(null), 3000)
    return () => clearTimeout(t)
  }, [pending])

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

  const shown = dragGain ?? pending ?? Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, gain))
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
          if (g !== gain) {
            setPending(g)
            onCommit(g)
          }
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
  onScrub,
  onCancel,
  onCommit
}: {
  value: number
  min: number
  max: number
  ariaLabel: string
  /** Live value on every drag move — feeds the row's readout. */
  onScrub?(value: number): void
  /** Drag aborted (Escape) — nothing was committed. */
  onCancel?(): void
  onCommit(value: number): void
}): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragValue, setDragValue] = useState<number | null>(null)

  const dragging = dragValue !== null
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setDragValue(null)
        onCancel?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragging, onCancel])

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
        const v = valueFromEvent(e)
        setDragValue(v)
        onScrub?.(v)
      }}
      onPointerMove={(e) => {
        if (dragValue === null) return
        const v = valueFromEvent(e)
        setDragValue(v)
        onScrub?.(v)
      }}
      onPointerUp={() => {
        if (dragValue === null) return
        const v = dragValue
        setDragValue(null)
        // always commit: the value prop is the caller's HOLD during a drag,
        // so a same-value compare here would swallow every release
        onCommit(v)
      }}
      onPointerCancel={() => {
        setDragValue(null)
        onCancel?.()
      }}
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
