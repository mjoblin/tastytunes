import { useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import type { AlignH, AlignV, AmbientArtMode, AmbientCoverage, AppSettings, Theme } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { SIGNAL_COLORS, cx } from '@/lib/format'
import { Slider } from '@/components/Slider'

export function SettingsScreen(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)
  const setInfoOpen = useStore((s) => s.setInfoOpen)

  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    const next = await tt.setSettings(patch)
    setSettings(next)
  }

  return (
    <div ref={useScrollMemory('settings')} className="h-full overflow-y-auto">
      <header className="flex items-center gap-4 px-8 pt-8 pb-4">
        <h1 className="font-display font-bold text-[26px] tracking-tight">Settings</h1>
      </header>

      <div className="px-8 pb-10 max-w-2xl space-y-8">
        {/* ------------------------------------------------------------ appearance */}
        <section className="space-y-3">
          <div className="microlabel">appearance</div>
          <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
            <SettingRow
              label="Theme"
              hint="The faceplate: warm near-black, or warm paper."
            >
              <Segmented<Theme>
                value={settings.theme}
                onChange={(theme) => void save({ theme })}
                options={[
                  { value: 'dark', label: 'Dark', icon: <Moon size={12} /> },
                  { value: 'light', label: 'Light', icon: <Sun size={12} /> }
                ]}
              />
            </SettingRow>

            <SettingRow
              label="Ambient album art"
              hint="Blur the playing album's art across the whole window."
            >
              <Segmented<AmbientArtMode>
                value={settings.ambientArt}
                onChange={(ambientArt) => void save({ ambientArt })}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'now-playing', label: 'Now Playing' },
                  { value: 'all', label: 'All screens' }
                ]}
              />
            </SettingRow>

            <div className={cx(settings.ambientArt === 'off' && 'opacity-40 pointer-events-none')}>
              <SettingRow
                label="Ambient coverage"
                hint="Wash just the content area, or the whole window including the nav and transport bar."
              >
                <Segmented<AmbientCoverage>
                  value={settings.ambientCoverage}
                  onChange={(ambientCoverage) => void save({ ambientCoverage })}
                  options={[
                    { value: 'main', label: 'Main area' },
                    { value: 'window', label: 'Entire window' }
                  ]}
                />
              </SettingRow>
            </div>

            <Toggle
              label="Vignette"
              hint="Darken the edges of the ambient backdrop for a bit of depth."
              checked={settings.vignette}
              disabled={settings.ambientArt === 'off'}
              onChange={(vignette) => void save({ vignette })}
            />

            <SettingRow
              label="Now Playing placement"
              hint="Where the art and track details sit on the Now Playing screen."
            >
              <div className="flex flex-col items-end gap-2">
                <Segmented<AlignH>
                  value={settings.nowPlayingAlignH}
                  onChange={(nowPlayingAlignH) => void save({ nowPlayingAlignH })}
                  options={[
                    { value: 'left', label: 'Left' },
                    { value: 'center', label: 'Center' },
                    { value: 'right', label: 'Right' }
                  ]}
                />
                <Segmented<AlignV>
                  value={settings.nowPlayingAlignV}
                  onChange={(nowPlayingAlignV) => void save({ nowPlayingAlignV })}
                  options={[
                    { value: 'top', label: 'Top' },
                    { value: 'center', label: 'Middle' },
                    { value: 'bottom', label: 'Bottom' }
                  ]}
                />
              </div>
            </SettingRow>

            <Toggle
              label="Accent follows album art"
              hint="Tint controls and glows with the playing album's dominant color. Brand and playing-state gold never change."
              checked={settings.accentFollowsArt}
              onChange={(accentFollowsArt) => void save({ accentFollowsArt })}
            />
          </div>
        </section>

        {/* ---------------------------------------------------------- presets grid */}
        <section className="space-y-3">
          <div className="microlabel">presets grid</div>
          <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
            <SliderSetting
              label="Card size"
              hint="Base width of each preset tile."
              min={120}
              max={280}
              unit="px"
              value={settings.presetCardSize}
              onCommit={(presetCardSize) => void save({ presetCardSize })}
            />

            <SliderSetting
              label="Card gap"
              hint="Space between tiles."
              min={8}
              max={40}
              unit="px"
              value={settings.presetGap}
              onCommit={(presetGap) => void save({ presetGap })}
            />

            <Toggle
              label="Fill rows"
              hint="Stretch cards so each row spans the full width — sizes flex with the window. Off keeps cards at the exact size above."
              checked={settings.presetFillRows}
              onChange={(presetFillRows) => void save({ presetFillRows })}
            />
          </div>
        </section>

        {/* -------------------------------------------------------------- behavior */}
        <section className="space-y-3">
          <div className="microlabel">behavior</div>
          <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
            <Toggle
              label="Keyboard media keys"
              hint="Play/pause, next, and previous keys control the streamer even when TastyTunes is in the background."
              checked={settings.mediaKeys}
              onChange={(mediaKeys) => void save({ mediaKeys })}
            />

            <Toggle
              label="Track-change notifications"
              hint="Show a system notification when the track changes while TastyTunes is in the background."
              checked={settings.notifications}
              onChange={(notifications) => void save({ notifications })}
            />

            <SettingRow
              label="Keyboard shortcuts"
              hint="Press ? anywhere in the app for the full list. Key hints also appear in menu items and control tooltips."
            >
              <button
                onClick={() => setShortcutsOpen(true)}
                className="shrink-0 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge text-dim hover:text-ink hover:ring-edge2 transition-all"
              >
                View shortcuts
              </button>
            </SettingRow>

            <SettingRow
              label="About TastyTunes"
              hint="Version, license, source, and support. Also opens by clicking the wordmark."
            >
              <button
                onClick={() => setInfoOpen(true)}
                className="shrink-0 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge text-dim hover:text-ink hover:ring-edge2 transition-all"
              >
                About
              </button>
            </SettingRow>

            <SettingRow
              label="Volume limit (%)"
              hint="Hard cap for pre-amp volume commands. Leave empty for no limit."
            >
              <input
                type="number"
                min={10}
                max={100}
                value={settings.volumeLimitPercent ?? ''}
                placeholder="—"
                onChange={(e) => {
                  const v =
                    e.target.value === '' ? null : Math.max(10, Math.min(100, Number(e.target.value)))
                  void save({ volumeLimitPercent: v })
                }}
                className="w-20 bg-bg rounded-lg ring-1 ring-edge focus:ring-edge2 outline-none px-3 py-1.5 text-[13px] font-mono"
              />
            </SettingRow>
          </div>
        </section>

        {/* ------------------------------------------------------------ status lamps */}
        <section className="space-y-3">
          <div className="microlabel">status lamps</div>
          <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
            <div>
              <div className="text-[13.5px] mb-0.5">Connection</div>
              <div className="text-[11.5px] text-faint mb-2.5">
                Shown beside each streamer in the device picker and on the Device screen.
              </div>
              <div className="space-y-2">
                <LegendRow swatch={<span className="led led-on" />} label="Connected" desc="Live link to the streamer." />
                <LegendRow swatch={<span className="led led-busy" />} label="Connecting" desc="Establishing or re-establishing the connection." />
                <LegendRow swatch={<span className="led led-off" />} label="Offline" desc="No connection to this streamer." />
              </div>
            </div>

            <div>
              <div className="text-[13.5px] mb-0.5">Signal quality</div>
              <div className="text-[11.5px] text-faint mb-2.5">
                Appears in the transport bar and beside the Now Playing badges while something is
                playing — click it for the full signal chain.
              </div>
              <div className="space-y-2">
                <LegendRow swatch={<Lamp color={SIGNAL_COLORS.hires} />} label="Hi-res lossless" desc="Lossless above CD quality (or MQA)." />
                <LegendRow swatch={<Lamp color={SIGNAL_COLORS.lossless} />} label="Lossless" desc="Bit-perfect CD quality." />
                <LegendRow swatch={<Lamp color={SIGNAL_COLORS.lossy} />} label="Lossy" desc="Compressed stream (internet radio, Bluetooth, AAC/MP3)." />
              </div>
            </div>
          </div>
        </section>

        <div className="microlabel">
          settings are saved automatically and persist between sessions
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- primitives

function Lamp({ color }: { color: string }): React.JSX.Element {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ background: color, boxShadow: `0 0 8px ${color}b0` }}
    />
  )
}

function LegendRow({
  swatch,
  label,
  desc
}: {
  swatch: React.ReactNode
  label: string
  desc: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span className="w-4 flex justify-center shrink-0">{swatch}</span>
      <span className="text-[12.5px] w-32 shrink-0">{label}</span>
      <span className="text-[11.5px] text-faint">{desc}</span>
    </div>
  )
}

function SettingRow({
  label,
  hint,
  children
}: {
  label: string
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6">
      <div>
        <div className="text-[13.5px]">{label}</div>
        <div className="text-[11.5px] text-faint max-w-sm">{hint}</div>
      </div>
      {children}
    </div>
  )
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  onChange(next: boolean): void
}): React.JSX.Element {
  return (
    <label
      className={cx(
        'flex items-center justify-between gap-6',
        disabled ? 'opacity-40 pointer-events-none' : 'cursor-pointer'
      )}
    >
      <div>
        <div className="text-[13.5px]">{label}</div>
        <div className="text-[11.5px] text-faint max-w-sm">{hint}</div>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={(e) => {
          e.preventDefault()
          onChange(!checked)
        }}
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
    </label>
  )
}

function SliderSetting({
  label,
  hint,
  min,
  max,
  unit,
  value,
  onCommit
}: {
  label: string
  hint: string
  min: number
  max: number
  unit: string
  value: number
  onCommit(next: number): void
}): React.JSX.Element {
  const [scrub, setScrub] = useState<number | null>(null)
  const shown = scrub ?? value
  const toValue = (ratio: number): number => Math.round(min + ratio * (max - min))

  return (
    <SettingRow label={label} hint={hint}>
      <div className="flex items-center gap-3 w-52 shrink-0">
        <div className="flex-1">
          <Slider
            value={(shown - min) / (max - min)}
            ariaLabel={label}
            thumb="always"
            onScrub={(r) => setScrub(toValue(r))}
            onCancel={() => setScrub(null)}
            onCommit={(r) => {
              setScrub(null)
              onCommit(toValue(r))
            }}
          />
        </div>
        <span className="font-mono text-[11px] text-dim w-12 text-right tabular-nums">
          {shown}
          {unit}
        </span>
      </div>
    </SettingRow>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>
  onChange(next: T): void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 rounded-lg ring-1 ring-edge bg-bg p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cx(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] transition-colors',
            value === opt.value ? 'bg-golddim text-gold' : 'text-dim hover:text-ink'
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  )
}
