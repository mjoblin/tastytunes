import { useState } from 'react'
import {
  Bot,
  Check,
  CircleDot,
  Copy,
  Heart,
  LayoutGrid,
  Monitor,
  Moon,
  Palette,
  SlidersHorizontal,
  Sun
} from 'lucide-react'
import {
  MCP_CLUSTERS,
  type AlignH,
  type AlignV,
  type AmbientArtMode,
  type AmbientCoverage,
  type AppSettings,
  type McpBind,
  type McpSettings,
  type MotionMode,
  type ThemePreference
} from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { SIGNAL_COLORS, cx, signalGlow } from '@/lib/format'
import { Slider } from '@/components/Slider'

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'layout', label: 'Layout', icon: LayoutGrid },
  { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal },
  { id: 'agents', label: 'AI agents', icon: Bot },
  { id: 'lamps', label: 'Status lamps', icon: CircleDot }
] as const
type SettingsTab = (typeof TABS)[number]['id']

export function SettingsScreen(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)
  const setInfoOpen = useStore((s) => s.setInfoOpen)
  const recentsCount = useStore((s) => s.recents.length)

  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    const next = await tt.setSettings(patch)
    setSettings(next)
  }

  // Last-visited tab persists; switch locally first so the rail feels instant.
  const [tab, setTab] = useState<SettingsTab>(() =>
    TABS.some((t) => t.id === settings.settingsTab) ? (settings.settingsTab as SettingsTab) : 'appearance'
  )
  const selectTab = (id: SettingsTab): void => {
    setTab(id)
    void save({ settingsTab: id })
  }
  const panelRef = useScrollMemory(`settings:${tab}`)

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <h1 className="font-display font-bold text-[26px] tracking-tight">Settings</h1>
        <span className="font-mono text-[11px] text-faint">saved automatically</span>
        <div className="flex-1" />
        <button
          onClick={() => setInfoOpen(true)}
          className="no-drag flex items-center gap-2 px-3.5 py-2 rounded-lg bg-gold text-bg text-[12.5px] font-medium
                     shadow-[0_0_14px_rgb(var(--gold-rgb)_/_0.3)] hover:brightness-110 motion-safe:hover:scale-[1.03] transition-all"
        >
          <Heart size={15} strokeWidth={2} />
          Info &amp; Support
        </button>
      </header>

      {/* pinned header + tab rail; only the per-tab panel scrolls */}
      <div className="flex-1 min-h-0 flex gap-8 px-8 pb-8 pt-1">
        <nav className="w-44 shrink-0 space-y-0.5">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => selectTab(id)}
              className={cx(
                'w-full flex items-center gap-3 rounded-lg h-9 px-3 text-[13.5px] transition-colors',
                tab === id ? 'bg-amberdim text-amber' : 'text-dim hover:text-ink hover:bg-veil'
              )}
            >
              <Icon size={15} strokeWidth={1.8} className="shrink-0" />
              <span className="flex-1 text-left">{label}</span>
            </button>
          ))}
        </nav>

        {/* keyed by tab so each tab keeps its own scroll position */}
        {/* p-px: the cards' 1px ring must not sit flush against the scrollport,
            or it clips when the panel narrows to exactly max-w-2xl */}
        <div key={tab} ref={panelRef} className="flex-1 min-w-0 overflow-y-auto p-px">
          <div className="max-w-2xl space-y-8">
        {tab === 'appearance' && (
        <section className="space-y-3">
          <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
            <SettingRow
              label="Theme"
              hint="The faceplate: warm near-black, or warm paper. System follows your OS appearance."
            >
              <Segmented<ThemePreference>
                value={settings.theme}
                onChange={(theme) => void save({ theme })}
                options={[
                  { value: 'dark', label: 'Dark', icon: <Moon size={12} /> },
                  { value: 'light', label: 'Light', icon: <Sun size={12} /> },
                  { value: 'system', label: 'System', icon: <Monitor size={12} /> }
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
        )}

        {tab === 'layout' && (
        <section className="space-y-3">
          <div className="microlabel">card grids</div>
          <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
            <SliderSetting
              label="Card size"
              hint="Base width of each card — presets, and the queue when viewed as cards."
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
        )}

        {tab === 'behavior' && (
        <section className="space-y-3">
          <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
            <SettingRow
              label="Animations"
              hint="Motion effects — hover growth, the equalizer bars, smooth scrolling. System follows your OS Reduce Motion setting."
            >
              <Segmented<MotionMode>
                value={settings.motion}
                onChange={(motion) => void save({ motion })}
                options={[
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                  { value: 'system', label: 'System' }
                ]}
              />
            </SettingRow>

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

            <Toggle
              label="Check for updates"
              hint="Look for a newer release on GitHub at launch and every few hours. A dot on the wordmark and a line in About — nothing downloads or installs itself."
              checked={settings.updateCheck}
              onChange={(updateCheck) => void save({ updateCheck })}
            />

            <SettingRow
              label="Recently played"
              hint="A local log of tracks and stations you've played, shown on the Recently Played screen (R). Kept only on this computer."
            >
              <button
                onClick={() => void tt.clearRecents()}
                disabled={recentsCount === 0}
                className="shrink-0 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all disabled:opacity-40 disabled:hover:text-dim disabled:hover:ring-edge disabled:hover:bg-panel/70"
              >
                {recentsCount > 0 ? `Clear history (${recentsCount})` : 'History empty'}
              </button>
            </SettingRow>

            <SettingRow
              label="Keyboard shortcuts"
              hint="Press ? anywhere in the app for the full list. Key hints also appear in menu items and control tooltips."
            >
              <button
                onClick={() => setShortcutsOpen(true)}
                className="shrink-0 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
              >
                View shortcuts
              </button>
            </SettingRow>

            <SettingRow
              label="Volume limit (%)"
              hint="Hard cap for pre-amp volume commands. Leave empty for no limit."
            >
              <NumberField
                value={settings.volumeLimitPercent}
                min={10}
                max={100}
                allowEmpty
                placeholder="—"
                widthClass="w-20"
                onCommit={(volumeLimitPercent) => void save({ volumeLimitPercent })}
              />
            </SettingRow>
          </div>
        </section>
        )}

        {tab === 'agents' && <McpSection settings={settings} save={save} />}

        {tab === 'lamps' && (
        <section className="space-y-3">
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
        )}

          </div>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------- ai agents (mcp)

function McpSection({
  settings,
  save
}: {
  settings: AppSettings
  save(patch: Partial<AppSettings>): Promise<void>
}): React.JSX.Element {
  const mcp = settings.mcp
  const status = useStore((s) => s.mcpStatus)
  const [copied, setCopied] = useState<string | null>(null)

  const saveMcp = (patch: Partial<McpSettings>): void => {
    void save({ mcp: { ...mcp, ...patch } })
  }
  const clusterOff = (id: string): boolean => mcp.disabledClusters.includes(id)
  const toggleCluster = (id: string, on: boolean): void =>
    saveMcp({
      disabledClusters: on
        ? mcp.disabledClusters.filter((c) => c !== id)
        : [...mcp.disabledClusters, id]
    })
  const toolOff = (name: string): boolean => mcp.disabledTools.includes(name)
  const toggleTool = (name: string): void =>
    saveMcp({
      disabledTools: toolOff(name)
        ? mcp.disabledTools.filter((t) => t !== name)
        : [...mcp.disabledTools, name]
    })

  const copy = (key: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1600)
    })
  }

  const enabledTools = MCP_CLUSTERS.reduce(
    (n, c) => (clusterOff(c.id) ? n : n + c.tools.filter((t) => !toolOff(t.name)).length),
    0
  )

  return (
    <section className="space-y-3">
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
        <Toggle
          label="MCP server"
          hint="Let AI agents and other MCP clients see and control the streamer over the Model Context Protocol."
          checked={mcp.enabled}
          onChange={(enabled) => saveMcp({ enabled })}
        />

        {/* live status + ways to connect a client */}
        {mcp.enabled && (
          <div className="rounded-lg bg-bg ring-1 ring-edge px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-2.5">
              <span className={cx('led', status.running ? 'led-on' : status.error ? 'led-off' : 'led-busy')} />
              <span className="text-[12px] text-dim">
                {status.running ? <>Serving {enabledTools} tools</> : (status.error ?? 'Starting…')}
              </span>
            </div>
            {status.running && status.url && (
              <div className="space-y-1.5 pt-0.5">
                <CopyRow
                  label="Endpoint"
                  text={status.url}
                  copied={copied === 'endpoint'}
                  onCopy={() => copy('endpoint', status.url!)}
                />
                <CopyRow
                  label="Claude Code"
                  text={`claude mcp add --transport http tastytunes ${status.url}`}
                  copied={copied === 'claude'}
                  onCopy={() => copy('claude', `claude mcp add --transport http tastytunes ${status.url}`)}
                />
                <CopyRow
                  label="JSON config"
                  text={`"tastytunes": { "type": "http", "url": "${status.url}" }`}
                  copied={copied === 'json'}
                  onCopy={() => copy('json', mcpJsonSnippet(status.url!))}
                  hint='For clients configured via an "mcpServers" JSON block — copies the full block.'
                />
              </div>
            )}
          </div>
        )}

        <div className={cx('space-y-5', !mcp.enabled && 'opacity-40 pointer-events-none')}>
          <SettingRow
            label="Reachable from"
            hint="Your streamer already accepts commands from anything on your local network — allowing that here is no wider. This computer is the cautious default."
          >
            <Segmented<McpBind>
              value={mcp.bind}
              onChange={(bind) => saveMcp({ bind })}
              options={[
                { value: 'localhost', label: 'This computer' },
                { value: 'lan', label: 'Local network' }
              ]}
            />
          </SettingRow>

          <SettingRow label="Port" hint="The HTTP port the MCP endpoint listens on.">
            <NumberField
              value={mcp.port}
              min={1024}
              max={65535}
              widthClass="w-24"
              onCommit={(port) => saveMcp({ port: port ?? 8555 })}
            />
          </SettingRow>

          <div className="space-y-4">
            <div>
              <div className="text-[13.5px]">Tools</div>
              <div className="text-[11.5px] text-faint max-w-sm">
                What connected agents are allowed to do. Switch off whole clusters, or click
                individual tools to toggle them. Changes apply to the next agent request.
              </div>
            </div>
            {MCP_CLUSTERS.map((cluster) => {
              const off = clusterOff(cluster.id)
              return (
                <div key={cluster.id}>
                  <Toggle
                    label={cluster.title}
                    hint={cluster.description}
                    checked={!off}
                    onChange={(on) => toggleCluster(cluster.id, on)}
                  />
                  <div className={cx('mt-2 flex flex-wrap gap-1.5', off && 'opacity-40 pointer-events-none')}>
                    {cluster.tools.map((t) => {
                      const on = !toolOff(t.name)
                      return (
                        <button
                          key={t.name}
                          onClick={() => toggleTool(t.name)}
                          aria-pressed={on}
                          className={cx(
                            'px-2.5 py-1 rounded-full font-mono text-[10.5px] ring-1 transition-colors',
                            // quiet grays: filled = enabled, hollow + struck = off
                            on
                              ? 'ring-edge2 bg-veil2 text-ink/80 hover:text-ink'
                              : 'ring-edge text-faint/70 line-through hover:text-dim'
                          )}
                        >
                          {t.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

/** The near-universal "mcpServers" JSON block (Claude Desktop, Cursor, VS Code, …). */
function mcpJsonSnippet(url: string): string {
  return JSON.stringify({ mcpServers: { tastytunes: { type: 'http', url } } }, null, 2)
}

function CopyRow({
  label,
  text,
  copied,
  onCopy,
  hint
}: {
  label: string
  text: string
  copied: boolean
  onCopy(): void
  hint?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="microlabel w-24 shrink-0">{label}</span>
      <code className="flex-1 min-w-0 truncate font-mono text-[11px] text-faint">{text}</code>
      <button
        onClick={onCopy}
        data-tip={copied ? 'Copied' : (hint ?? 'Copy')}
        aria-label={`Copy ${label}`}
        className="tip-top shrink-0 p-1.5 rounded text-dim hover:text-ink transition-colors"
      >
        {copied ? <Check size={13} className="text-led" /> : <Copy size={13} />}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- primitives

/**
 * Numeric input that lets you actually type: edits live in a draft and are
 * clamped + committed on blur/Enter (Escape reverts). Clamping per keystroke
 * made intermediate values impossible — typing "45" became 10, then 100.
 */
function NumberField({
  value,
  min,
  max,
  allowEmpty,
  placeholder,
  widthClass,
  onCommit
}: {
  value: number | null
  min: number
  max: number
  allowEmpty?: boolean
  placeholder?: string
  widthClass: string
  onCommit(next: number | null): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (): void => {
    if (draft === null) return
    const trimmed = draft.trim()
    if (trimmed === '') {
      if (allowEmpty) onCommit(null)
    } else {
      const n = Number(trimmed)
      if (!Number.isNaN(n)) onCommit(Math.max(min, Math.min(max, Math.round(n))))
    }
    setDraft(null)
  }

  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft ?? (value ?? '')}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') setDraft(null)
      }}
      className={cx(
        widthClass,
        'bg-bg rounded-lg ring-1 ring-edge focus:ring-edge2 outline-none px-3 py-1.5 text-[13px] font-mono'
      )}
    />
  )
}

function Lamp({ color }: { color: string }): React.JSX.Element {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ background: color, boxShadow: signalGlow(color) }}
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
