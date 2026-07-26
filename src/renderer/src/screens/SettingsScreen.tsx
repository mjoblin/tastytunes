import { useEffect, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  AlarmClock,
  ArrowUpCircle,
  Bot,
  Check,
  CircleDot,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Heart,
  LayoutGrid,
  Library,
  Loader2,
  Lock,
  Monitor,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sun,
  Trash2
} from 'lucide-react'
import { version } from '../../../../package.json'
import { type AlignH, type AlignV, type AmbientArtMode, type AmbientCoverage, type AppSettings, type McpBind, type McpSettings, type MotionMode, type Schedule, type ThemePreference, type UpdateCheckResult } from '@shared/model'
import { MCP_CLUSTERS, mcpClusterEnabled, type McpClusterInfo } from '@shared/mcpCatalog'
import { tt } from '@/api'
import { useStore, type Screen } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { DISPLAY_FONTS } from '@/hooks/useDisplayFont'
import { SIGNAL_COLORS, cx, signalGlow } from '@/lib/format'
import { clearRecentsWithUndo } from '@/lib/recents'
import {
  MOD,
  NAV_SCREENS,
  orderedNavScreens,
  NAV_TOOLS,
  NAV_UNHIDEABLE,
  SETTINGS_SCREEN,
  sanitizeNavHidden,
  sanitizeNavHiddenTools,
  type NavTool,
  type NavToolDef,
  type ScreenDef
} from '@/lib/screens'
import { Slider } from '@/components/Slider'
import { OrderHandle } from '@/components/OrderHandle'
import { lockVertical } from '@/lib/dnd'
import { HeaderChip, PrimaryButton, ScreenTitle } from '@/components/Chrome'
import { useOneShotAsk } from '@/hooks/useOneShotAsk'

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'layout', label: 'Layout', icon: LayoutGrid },
  { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal },
  { id: 'connections', label: 'Connections', icon: Globe },
  { id: 'libraries', label: 'Libraries', icon: Library },
  { id: 'updates', label: 'Updates', icon: ArrowUpCircle },
  { id: 'schedules', label: 'Schedules', icon: AlarmClock },
  { id: 'agents', label: 'AI agents', icon: Bot },
  { id: 'lamps', label: 'Status lamps', icon: CircleDot }
] as const
type SettingsTab = (typeof TABS)[number]['id']

export function SettingsScreen(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)
  const setInfoOpen = useStore((s) => s.setInfoOpen)
  const recentsCount = useStore((s) => s.recents.length)

  const save = useStore((s) => s.saveSettings)

  // Last-visited tab persists; switch locally first so the rail feels instant.
  const [tab, setTab] = useState<SettingsTab>(() =>
    TABS.some((t) => t.id === settings.settingsTab) ? (settings.settingsTab as SettingsTab) : 'appearance'
  )
  const selectTab = (id: SettingsTab): void => {
    setTab(id)
    void save({ settingsTab: id })
  }
  const panelRef = useScrollMemory(`settings:${tab}`)

  const update = useStore((s) => s.update)
  // One-shot deep link (the nav update dot lands on Updates); consume + clear.
  const settingsJump = useStore((s) => s.settingsJump)
  const clearSettingsJump = useStore((s) => s.clearSettingsJump)
  useOneShotAsk(
    settingsJump,
    (tab) => {
      if (TABS.some((t) => t.id === tab)) selectTab(tab as SettingsTab)
    },
    { clear: clearSettingsJump }
  )

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <ScreenTitle>Settings</ScreenTitle>
        <span className="font-mono text-[11px] text-faint">saved automatically</span>
        <div className="flex-1" />
        <PrimaryButton
          onClick={() => setInfoOpen(true)}
          className="no-drag flex items-center gap-2 px-3.5 py-2 text-[12.5px] motion-safe:hover:scale-[1.03]"
        >
          <Heart size={15} strokeWidth={2} />
          Info &amp; Support
        </PrimaryButton>
      </header>

      {/* pinned header + tab rail; only the per-tab panel scrolls */}
      <div className="flex-1 min-h-0 flex gap-5 px-8 pb-8 pt-1">
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
              {id === 'updates' && update && (
                <span aria-label="Update available" className="w-1.5 h-1.5 rounded-full bg-gold shrink-0" />
              )}
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
              label="Display font"
              hint="The face for titles and big text. Every option previews itself."
            >
              <div className="flex flex-wrap justify-end gap-1.5 max-w-[340px]">
                {DISPLAY_FONTS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => void save({ displayFont: f.id })}
                    style={{ fontFamily: f.stack }}
                    className={cx(
                      'px-3 py-1.5 rounded-lg ring-1 text-[13px] transition-colors',
                      settings.displayFont === f.id
                        ? 'ring-gold/50 bg-golddim text-gold'
                        : 'ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2'
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
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
              hint="Tint controls and glows with the playing album's dominant color. The tastytunes gold — the logo and the playing markers — never changes."
              checked={settings.accentFollowsArt}
              onChange={(accentFollowsArt) => void save({ accentFollowsArt })}
            />
          </div>
        </section>
        )}

        {tab === 'layout' && (
        <>
        <section className="space-y-3">
          <div className="microlabel">card grids</div>
          <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
            <SliderSetting
              label="Card size"
              hint="Base width of each card."
              min={120}
              max={280}
              unit="px"
              value={settings.presetCardSize}
              onCommit={(presetCardSize) => void save({ presetCardSize })}
            />

            <SliderSetting
              label="Card gap"
              hint="Space between cards."
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

        <SidebarSection />
        </>
        )}

        {tab === 'behavior' && (
        <section className="space-y-3">
          <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
            <SettingRow
              label="Animations"
              hint="Motion effects — hover growth, the small equalizer bars that indicate what's playing, smooth scrolling. System follows your OS Reduce Motion setting."
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
              label="Media keys"
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
              label="Recently played"
              hint="A local log of tracks and stations you've played, shown on the Recently Played screen (R). Kept only on this computer."
            >
              <button
                onClick={() => void clearRecentsWithUndo()}
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
              <HeaderChip
                onClick={() => setShortcutsOpen(true)}
                className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
              >
                View shortcuts
              </HeaderChip>
            </SettingRow>

            <SettingRow
              label="Volume limit (%)"
              hint="Caps the volume TastyTunes will set — the streamer's own remote and other apps aren't affected. Leave empty for no limit."
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

        {tab === 'connections' && (
        <section className="space-y-3">
          {/* everything here talks to a service outside the LAN — each row says
              exactly what leaves the machine, and off always means zero requests */}
          <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
            <Toggle
              label="Lyrics on Now Playing"
              hint="Adds a lyrics panel to the Now Playing screen, fetched (when open) from lrclib.net. Sends the current track's title and artist to LRCLIB; off means no requests, ever."
              checked={settings.lyrics}
              onChange={(lyrics) => void save({ lyrics })}
            />

            <Toggle
              label="Current lyric line"
              hint="Shows the live synced lyric under the track details on Now Playing (hidden while the full panel is open). Looks up each track as it plays — the same LRCLIB request as above."
              disabled={!settings.lyrics}
              checked={settings.lyricsLine}
              onChange={(lyricsLine) => void save({ lyricsLine })}
            />

            <Toggle
              label="Artist & album context"
              hint="Adds a context panel to the Now Playing screen: Wikipedia summaries and release details matched via MusicBrainz, fetched when you open it. Sends the current artist and album names; off means no requests, ever."
              checked={settings.artistInfo}
              onChange={(artistInfo) => void save({ artistInfo })}
            />

            <Toggle
              label="Internet radio directory"
              hint="Finds stations through radio-browser.info — the Radio screen's search and top lists, and the radio results in unified search. Sends what you type; off means no requests, ever. Favorited stations still play either way: a favorite carries its own stream URL."
              checked={settings.radioDirectory}
              onChange={(radioDirectory) => void save({ radioDirectory })}
            />

            <ListenBrainzSection settings={settings} save={save} />

            <CacheRow />

          </div>
        </section>
        )}

        {tab === 'libraries' && <LibrariesSection settings={settings} save={save} />}

        {tab === 'updates' && <UpdatesSection settings={settings} save={save} />}

        {tab === 'schedules' && <SchedulesSection settings={settings} save={save} />}

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
  const clusterOn = (c: McpClusterInfo): boolean => mcpClusterEnabled(c, mcp)
  const toggleCluster = (c: McpClusterInfo, on: boolean): void => {
    if (c.optIn) {
      // Opt-in clusters live in an explicit allow-list — absence means off.
      saveMcp({
        enabledClusters: on
          ? [...(mcp.enabledClusters ?? []), c.id]
          : (mcp.enabledClusters ?? []).filter((x) => x !== c.id)
      })
    } else {
      saveMcp({
        disabledClusters: on
          ? mcp.disabledClusters.filter((x) => x !== c.id)
          : [...mcp.disabledClusters, c.id]
      })
    }
  }
  const toolOff = (name: string): boolean => mcp.disabledTools.includes(name)
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({})
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
    (n, c) => (clusterOn(c) ? n + c.tools.filter((t) => !toolOff(t.name)).length : n),
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
            {/* full-strength rule: Tools opens its own region, a step above
                the groups' softer edge/60 separators */}
            <div className="pt-4 border-t border-edge">
              {/* the top of the three-level ladder: Tools (16 bold) > group
                  headings (14.5 medium) > cluster toggles (13.5) */}
              <div className="font-display font-bold text-[16px] tracking-tight">Tools</div>
              <div className="text-[11.5px] text-faint max-w-sm">
                What connected agents are allowed to do. Switch off whole clusters, or click
                individual tools to toggle them. Changes apply to the next agent request.
              </div>
            </div>
            {MCP_GROUPS.map((g) => {
              const clusters = MCP_CLUSTERS.filter((c) => c.group === g.id)
              if (clusters.length === 0) return null
              return (
                <div key={g.id} className="space-y-3.5">
                  {/* the group header must out-rank its cluster rows (13.5px
                      toggles) — a size step up plus the indented rail below */}
                  <div className="pt-1 border-t border-edge/60 first:border-t-0 first:pt-0">
                    <div className="pt-2 text-[14.5px] font-medium">{g.label}</div>
                    <div className="text-[11.5px] text-faint">{g.note}</div>
                  </div>
                  <div className="pl-4 ml-1 border-l-2 border-edge/50 space-y-3.5">
                  {clusters.map((cluster) => {
                    const on = clusterOn(cluster)
                    const open = openTools[cluster.id] === true
                    const activeCount = cluster.tools.filter((t) => !toolOff(t.name)).length
                    return (
                      <div key={cluster.id}>
                        <Toggle
                          label={cluster.title}
                          hint={cluster.description}
                          checked={on}
                          onChange={(v) => toggleCluster(cluster, v)}
                        />
                        {/* tools stay tucked away — one small line per cluster
                            instead of a wall of chips */}
                        <button
                          onClick={() => setOpenTools((o) => ({ ...o, [cluster.id]: !open }))}
                          aria-expanded={open}
                          className="mt-1 font-mono text-[10.5px] text-faint hover:text-dim transition-colors"
                        >
                          {open
                            ? '▾ hide tools'
                            : `▸ ${activeCount === cluster.tools.length ? cluster.tools.length : `${activeCount} of ${cluster.tools.length}`} tools`}
                        </button>
                        {open && (
                          <div className={cx('mt-2 flex flex-wrap gap-1.5', !on && 'opacity-40 pointer-events-none')}>
                            {cluster.tools.map((t) => {
                              const toolOn = !toolOff(t.name)
                              return (
                                <button
                                  key={t.name}
                                  onClick={() => toggleTool(t.name)}
                                  aria-pressed={toolOn}
                                  data-tip={t.description}
                                  className={cx(
                                    'tip-top tip-wide px-2.5 py-1 rounded-full font-mono text-[10.5px] ring-1 transition-colors',
                                    // quiet grays: filled = enabled, hollow + struck = off
                                    toolOn
                                      ? 'ring-edge2 bg-veil2 text-ink/80 hover:text-ink'
                                      : 'ring-edge text-faint/70 line-through hover:text-dim'
                                  )}
                                >
                                  {t.name}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
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

/** The Settings-side grouping of MCP clusters by what they can affect. */
const MCP_GROUPS: Array<{ id: McpClusterInfo['group']; label: string; note: string }> = [
  { id: 'read', label: 'Read-only', note: 'Seeing and looking things up — nothing changes.' },
  {
    id: 'control',
    label: 'Control',
    note: 'Playing, tuning, and adjusting — transient, like pressing the buttons yourself.'
  },
  {
    id: 'write',
    label: 'Edits & saves',
    note: 'Changes saved things (queue order, preset slots) — off until you switch them on. Overwriting an occupied preset slot additionally requires the agent to say so explicitly per call.'
  }
]

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

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Plain-English one-liner of exactly what a schedule will (or won't) do. */
function describeSchedule(s: Schedule): string {
  if (!s.enabled) return 'Off — flip the switch to arm it.'
  if (s.days.length === 0) return 'Never fires — no days selected.'
  const days =
    s.days.length === 7
      ? 'every day'
      : s.days.join(',') === '1,2,3,4,5'
        ? 'on weekdays'
        : s.days.join(',') === '0,6'
          ? 'on weekends'
          : `on ${s.days.map((d) => DAY_NAMES[d]).join(', ')}`
  if (s.action === 'standby') return `Puts the streamer in standby at ${s.time} ${days}.`
  const extras = [
    s.presetId != null ? `recalls preset ${s.presetId}` : null,
    s.volumePercent != null ? `sets volume to ${s.volumePercent}%` : null
  ].filter(Boolean)
  return `Wakes the streamer${extras.length ? `, ${extras.join(', ')},` : ''} at ${s.time} ${days}.`
}

/**
 * Scheduled actions: BluOS-style alarms. Each schedule is a card — time,
 * day-of-week chips, wake/standby, and (for wake) optional preset + volume.
 * Executed by the main process; honest caveat up top about app-must-be-running.
 */
function SchedulesSection({
  settings,
  save
}: {
  settings: AppSettings
  save(patch: Partial<AppSettings>): Promise<void>
}): React.JSX.Element {
  const presets = useStore((s) => s.presets?.presets ?? null)
  const showToast = useStore((s) => s.showToast)
  const schedules = settings.schedules

  const update = (id: string, patch: Partial<Schedule>): void => {
    void save({ schedules: schedules.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  }
  /**
   * Deleting a schedule was instant with nothing behind it — one click and a
   * standing instruction to your hi-fi was gone, with no way to see what it
   * had been. Still instant (it's one small item, and a confirm on every
   * delete is the trade we've decided against), now with the offer behind it.
   */
  const remove = (id: string): void => {
    const index = schedules.findIndex((s) => s.id === id)
    const removed = schedules[index]
    if (!removed) return
    void save({ schedules: schedules.filter((s) => s.id !== id) })
    showToast({
      kind: 'success',
      text: `Deleted the ${removed.time} ${removed.action === 'on' ? 'wake' : 'standby'} schedule`,
      action: { label: 'Undo', undo: () => restore(index, removed) }
    })
  }

  /** Splice it back where it was, into the list AS IT IS NOW — undoing must not
   *  discard a schedule added or edited while the offer was up. */
  const restore = (index: number, sched: Schedule): void => {
    const live = useStore.getState().settings.schedules
    if (live.some((s) => s.id === sched.id)) return
    const next = [...live]
    next.splice(Math.min(index, next.length), 0, sched)
    void save({ schedules: next })
  }
  const add = (): void => {
    const sched: Schedule = {
      id: Math.random().toString(36).slice(2, 10),
      // Off until armed — adding a card must never schedule anything by itself.
      enabled: false,
      time: '07:30',
      days: [1, 2, 3, 4, 5],
      action: 'on',
      presetId: null,
      volumePercent: null
    }
    void save({ schedules: [...schedules, sched] })
  }

  return (
    <section className="space-y-3">
      <p className="text-[11.5px] text-faint px-1">
        Wake the streamer (optionally recalling a preset and setting a volume) or send it to
        standby at set times. Schedules fire only while TastyTunes is running and connected.
      </p>

      {schedules.map((s) => (
        <div key={s.id} className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-4">
          <div className="flex items-center gap-3">
            <input
              type="time"
              value={s.time}
              onChange={(e) => e.target.value && update(s.id, { time: e.target.value })}
              className="bg-bg rounded-lg ring-1 ring-edge px-2.5 py-1.5 text-[13px] font-mono outline-none focus:ring-edge2"
            />
            <Segmented<Schedule['action']>
              value={s.action}
              onChange={(action) => update(s.id, { action })}
              options={[
                { value: 'on', label: 'Wake' },
                { value: 'standby', label: 'Standby' }
              ]}
            />
            <div className="flex-1" />
            <MiniSwitch checked={s.enabled} onChange={(enabled) => update(s.id, { enabled })} />
            <button
              onClick={() => remove(s.id)}
              aria-label="Delete schedule"
              className="p-1.5 rounded-md text-faint hover:text-alert transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {DAY_LABELS.map((label, day) => (
              <button
                key={day}
                onClick={() =>
                  update(s.id, {
                    days: s.days.includes(day)
                      ? s.days.filter((d) => d !== day)
                      : [...s.days, day].sort()
                  })
                }
                aria-label={`Day ${day}`}
                className={cx(
                  'w-7 h-7 rounded-full text-[11px] font-mono transition-colors',
                  s.days.includes(day)
                    ? 'bg-amberdim text-amber ring-1 ring-amber/40'
                    : 'text-faint hover:text-dim ring-1 ring-edge'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className={cx('text-[11.5px]', s.enabled && s.days.length > 0 ? 'text-dim' : 'text-faint')}>
            {describeSchedule(s)}
          </div>

          {s.action === 'on' && (
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2.5 text-[12.5px] text-dim">
                Preset
                <select
                  value={s.presetId ?? ''}
                  onChange={(e) =>
                    update(s.id, { presetId: e.target.value === '' ? null : Number(e.target.value) })
                  }
                  className="bg-bg rounded-lg ring-1 ring-edge px-2 py-1.5 text-[12.5px] outline-none focus:ring-edge2 max-w-56"
                >
                  <option value="">—</option>
                  {(presets ?? [])
                    .filter((p) => p.id != null)
                    .map((p) => (
                      <option key={p.id} value={p.id!}>
                        {p.id} · {p.name ?? 'Preset'}
                      </option>
                    ))}
                  {/* a saved preset that isn't in the current list stays selectable */}
                  {s.presetId != null && !(presets ?? []).some((p) => p.id === s.presetId) && (
                    <option value={s.presetId}>{s.presetId}</option>
                  )}
                </select>
              </label>
              <label
                className="flex items-center gap-2.5 text-[12.5px] text-dim"
                title="Overrides the preset's own saved volume, if it has one."
              >
                Volume
                <NumberField
                  value={s.volumePercent}
                  min={0}
                  max={100}
                  allowEmpty
                  placeholder="—"
                  widthClass="w-16"
                  onCommit={(volumePercent) => update(s.id, { volumePercent })}
                />
              </label>
            </div>
          )}
        </div>
      ))}

      <HeaderChip
        onClick={add}
        className="flex items-center gap-2 text-[12.5px] px-3 py-2 motion-safe:active:scale-95"
      >
        <Plus size={14} />
        Add schedule
      </HeaderChip>
    </section>
  )
}

/** The Toggle's switch without the label row, for inline card use. */
function MiniSwitch({
  checked,
  onChange
}: {
  checked: boolean
  onChange(next: boolean): void
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
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
 * ListenBrainz scrobbling: token field + enable toggle + live token status.
 * The token is validated against listenbrainz.org whenever it changes (and on
 * mount if present) so the row always says whether scrobbling actually works.
 */
const fmtBytes = (b: number): string =>
  b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`

/**
 * The Libraries tab: every media server the streamer has listed, each with
 * its index state — the rebuildable metadata cache behind instant library
 * search. Searchable servers build and refresh themselves (unless automatic
 * building is off); Browse-only servers get a Build button (a walk can be
 * slow, so it stays the user's call).
 */
function LibrariesSection({
  settings,
  save
}: {
  settings: AppSettings
  save(patch: Partial<AppSettings>): Promise<void>
}): React.JSX.Element {
  const statuses = useStore((s) => s.mediaIndex)

  const age = (at: number | null): string => {
    if (at == null) return ''
    const mins = Math.round((Date.now() - at) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins} min ago`
    const hours = Math.round(mins / 60)
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
  }

  return (
    <section className="space-y-3">
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
        <Toggle
          label="Build indexes automatically"
          hint="Index each searchable media server when the Library lists it, and rebuild when the server reports changes. Off means indexes only build from the buttons below."
          checked={settings.mediaIndexAuto}
          onChange={(mediaIndexAuto) => void save({ mediaIndexAuto })}
        />

        <div>
          <div className="text-[13.5px]">Library index</div>
          <div className="text-[11.5px] text-faint max-w-sm">
            A local copy of each media server&apos;s track list so library search answers
            instantly. Rebuilds itself when the server reports changes; nothing here
            can&apos;t be regenerated.
          </div>
        </div>

        {statuses.length === 0 && (
          <div className="rounded-lg bg-bg ring-1 ring-edge px-3 py-2.5 text-[12px] text-dim">
            No media servers seen yet — they appear here once the streamer lists them.
            Open the Library (I), or attach USB storage to the streamer.
          </div>
        )}
        {statuses.map((st) => (
        <div key={st.udn} className="flex items-center gap-3">
          <span className="flex-1 min-w-0 text-[12.5px] truncate">
            {st.serverName}
            <span className="block font-mono text-[10.5px] text-faint">
              {st.state === 'building'
                ? 'building…'
                : st.state === 'none'
                  ? 'not indexed — search asks the server live'
                  : `${st.tracks.toLocaleString()} tracks · ${st.albums.toLocaleString()} albums · updated ${age(st.builtAt)}`}
            </span>
          </span>
          <HeaderChip
            onClick={() => void tt.mediaIndexRebuild(st.udn)}
            disabled={st.state === 'building'}
            className="shrink-0 flex items-center gap-1.5 text-[12px] px-3 py-1.5 motion-safe:active:scale-90 disabled:opacity-40 disabled:pointer-events-none"
          >
            {st.state === 'building' ? (
              <Loader2 size={13} className="motion-safe:animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            {st.state === 'ready' ? 'Rebuild' : 'Build'}
          </HeaderChip>
        </div>
      ))}
      </div>
    </section>
  )
}

function CacheRow(): React.JSX.Element {
  const [stats, setStats] = useState<{ entries: number; bytes: number } | null>(null)
  useEffect(() => {
    void tt.lookupCacheStats().then(setStats)
  }, [])
  const empty = stats != null && stats.entries === 0
  return (
    <SettingRow
      label="Cached lookups"
      hint="Lyrics, artist, and album lookups are kept on disk (a fixed size — the entries you haven't used longest drop first) so repeat plays don't re-ask the services above. The panels' refresh buttons overwrite the stored copy."
    >
      <button
        onClick={() => void tt.clearLookupCaches().then(setStats)}
        disabled={empty}
        className="shrink-0 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all disabled:opacity-40 disabled:hover:text-dim disabled:hover:ring-edge disabled:hover:bg-panel/70"
      >
        {stats == null
          ? '…'
          : empty
            ? 'Cache empty'
            : `Clear (${stats.entries} · ${fmtBytes(stats.bytes)})`}
      </button>
    </SettingRow>
  )
}

function ListenBrainzSection({
  settings,
  save
}: {
  settings: AppSettings
  save(patch: Partial<AppSettings>): Promise<void>
}): React.JSX.Element {
  const hasToken = settings.lbToken.trim().length > 0
  const [tokenStatus, setTokenStatus] = useState<
    { valid: boolean; userName: string | null } | null | 'checking' | 'idle'
  >('idle')

  const validate = async (): Promise<void> => {
    setTokenStatus('checking')
    setTokenStatus(await tt.lbValidate())
  }
  useEffect(() => {
    if (hasToken) void validate()
    else setTokenStatus('idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-check per token
  }, [settings.lbToken])

  const status = !hasToken
    ? 'Paste your user token from listenbrainz.org/settings.'
    : tokenStatus === 'checking' || tokenStatus === 'idle'
      ? 'Checking token…'
      : tokenStatus === null
        ? "Can't reach listenbrainz.org — will retry when scrobbling."
        : tokenStatus.valid
          ? `Token valid — scrobbling as ${tokenStatus.userName ?? 'you'}.`
          : 'Token rejected by ListenBrainz.'

  return (
    <div className="space-y-4 pt-1 border-t border-edge">
      <SettingRow label="ListenBrainz token" hint={status}>
        <div className="flex items-center gap-2">
          <TokenField value={settings.lbToken} onCommit={(lbToken) => void save({ lbToken })} />
          <HeaderChip
            onClick={() => void tt.openExternal('https://listenbrainz.org/settings/')}
            className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
          >
            Get token
          </HeaderChip>
        </div>
      </SettingRow>
      <Toggle
        label="Scrobble to ListenBrainz"
        hint={
          hasToken
            ? 'Log what you listen to at listenbrainz.org: artist, title, and album are sent as tracks play. Queue and streamed tracks with real metadata only — radio is never scrobbled.'
            : 'Add your user token above first — the switch unlocks once a token is saved.'
        }
        disabled={!hasToken}
        checked={settings.lbEnabled}
        onChange={(lbEnabled) => void save({ lbEnabled })}
      />
    </div>
  )
}

/** Masked text input, committed on blur/Enter (Escape reverts). */
function TokenField({
  value,
  onCommit
}: {
  value: string
  onCommit(next: string): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (): void => {
    if (draft !== null && draft.trim() !== value) onCommit(draft.trim())
    setDraft(null)
  }

  return (
    <input
      type="password"
      autoComplete="off"
      spellCheck={false}
      value={draft ?? value}
      placeholder="user token"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setDraft(null)
      }}
      className="w-48 bg-bg rounded-lg ring-1 ring-edge px-3 py-1.5 text-[12.5px] font-mono outline-none focus:ring-edge2 placeholder:text-faint"
    />
  )
}

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

/**
 * Sidebar card (Layout tab): a row per screen in registry order with an eye
 * toggle to hide/show it in the left nav — the way to un-hide, mirroring the
 * right-click "Hide from left nav" verb on the nav itself. now-playing is locked
 * (never hideable). Below a divider, the pinned bottom-cluster tools (Commands,
 * Mini player) get the same toggle; Settings is shown locked, last, for
 * completeness. Hidden items stay reachable by their keyboard shortcut / route.
 */
function UpdatesSection({
  settings,
  save
}: {
  settings: AppSettings
  save(patch: Partial<AppSettings>): Promise<void>
}): React.JSX.Element {
  const update = useStore((s) => s.update)
  // Manual-check feedback: 'checking' while in flight, then the outcomes the
  // consent panel won't announce itself ('none' / 'error'; 'update' clears
  // this — the panel and the dots take over).
  const [manual, setManual] = useState<'checking' | UpdateCheckResult | null>(null)
  const checkNow = async (): Promise<void> => {
    setManual('checking')
    const res = await tt.updateCheckNow()
    setManual(res.status === 'update' ? null : res)
  }

  return (
    <section className="space-y-3">
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
        <SettingRow label="Version" hint="The build you're running.">
          <span className="font-mono text-[12px] text-dim">v{version}</span>
        </SettingRow>

        <Toggle
          label="Automatically check for updates"
          hint="Check for version updates at launch and every few hours. When a new version is available, a dot appears on the tastytunes name in the left nav and on this tab — nothing downloads or installs itself."
          checked={settings.updateCheck}
          onChange={(updateCheck) => void save({ updateCheck })}
        />
      </div>

      {update ? (
        <UpdatePanel />
      ) : (
        <div className="rounded-xl ring-1 ring-edge bg-panel/70 px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-dim min-w-0">
            {manual === 'checking' ? (
              'Checking…'
            ) : manual?.status === 'none' ? (
              `Nothing newer — v${version} is the latest release.`
            ) : manual?.status === 'error' ? (
              <span className="text-alert break-all">Couldn&apos;t check: {manual.error}</span>
            ) : settings.updateCheck ? (
              `You're on v${version} — no newer version is known.`
            ) : (
              'Automatic update checks are off.'
            )}
          </span>
          <HeaderChip
            onClick={() => void checkNow()}
            disabled={manual === 'checking'}
            className="shrink-0 flex items-center gap-1.5 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90 disabled:opacity-50 disabled:pointer-events-none"
          >
            {manual === 'checking' ? (
              <Loader2 size={13} className="motion-safe:animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            Check now
          </HeaderChip>
        </div>
      )}
    </section>
  )
}

/** The self-update consent panel (moved here from the Info modal — Updates
 *  is its home now; the nav dot deep-links to this tab). */
function UpdatePanel(): React.JSX.Element | null {
  const update = useStore((s) => s.update)
  if (!update) return null

  return (
    <div className="w-full rounded-xl ring-1 ring-gold/40 bg-golddim px-4 py-3">
      {update.phase === 'available' && (
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[13.5px] text-gold">v{update.version} is available</span>
            <span className="block font-mono text-[10.5px] text-faint mt-0.5">
              {update.canDownload
                ? 'nothing downloads until you say so'
                : 'open the release page to download'}
            </span>
          </span>
          {update.canDownload ? (
            <PrimaryButton
              onClick={() => void tt.updateDownload()}
              className="shrink-0 text-[12.5px] px-3.5 py-1.5"
            >
              Download
            </PrimaryButton>
          ) : (
            <HeaderChip
              onClick={() => void tt.openExternal(update.url)}
              className="shrink-0 flex items-center gap-1.5 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
            >
              Release page <ExternalLink size={12} />
            </HeaderChip>
          )}
        </div>
      )}

      {update.phase === 'downloading' && (
        <div>
          <div className="flex items-center justify-between text-[13.5px] text-gold">
            <span>Downloading v{update.version}…</span>
            <span className="font-mono text-[11px]">{update.percent ?? 0}%</span>
          </div>
          <div className="h-1 rounded-full bg-veil2 mt-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-gold transition-[width] duration-300"
              style={{ width: `${update.percent ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {update.phase === 'downloaded' && (
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[13.5px] text-gold">v{update.version} is ready</span>
            <span className="block font-mono text-[10.5px] text-faint mt-0.5">
              installs when you quit — or restart now
            </span>
          </span>
          <PrimaryButton
            onClick={() => void tt.updateInstall()}
            className="shrink-0 text-[12.5px] px-3.5 py-1.5"
          >
            Restart now
          </PrimaryButton>
        </div>
      )}

      {update.phase === 'error' && (
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[13.5px] text-alert">Update failed</span>
            <span className="block font-mono text-[10.5px] text-faint mt-0.5 break-all">
              {update.error}
            </span>
          </span>
          <HeaderChip
            onClick={() => void tt.updateDownload()}
            className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
          >
            Try again
          </HeaderChip>
        </div>
      )}
    </div>
  )
}

function SidebarSection(): React.JSX.Element {
  const navHidden = useStore((s) => s.settings.navHidden)
  const navHiddenTools = useStore((s) => s.settings.navHiddenTools)
  const navOrder = useStore((s) => s.settings.navOrder)
  const save = useStore((s) => s.saveSettings)
  const hidden = sanitizeNavHidden(navHidden)
  const hiddenSet = new Set(hidden)
  const hiddenTools = sanitizeNavHiddenTools(navHiddenTools)
  const hiddenToolSet = new Set(hiddenTools)
  // The one ordered list; hidden rows keep their slot in it, which is what
  // makes unhiding restore position rather than append.
  const ordered = orderedNavScreens(navOrder)
  const ids = ordered.map((sc) => sc.id)
  // Reset is only worth offering once the order actually differs from the
  // default — an inert button is noise.
  const customized = ids.some((id, i) => id !== NAV_SCREENS[i].id)

  // Pointer AND keyboard: a list you can only reorder by dragging can't be
  // reordered at all without a mouse (the a11y round's rule, applied here from
  // the start rather than retrofitted).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const setHidden = (id: Screen, hide: boolean): void => {
    const next = hide ? [...hidden, id] : hidden.filter((s) => s !== id)
    void save({ navHidden: next })
  }
  const setToolHidden = (id: NavTool, hide: boolean): void => {
    const next = hide ? [...hiddenTools, id] : hiddenTools.filter((t) => t !== id)
    void save({ navHiddenTools: next })
  }
  const onDragEnd = (e: DragEndEvent): void => {
    if (!e.over || e.active.id === e.over.id) return
    const from = ids.indexOf(String(e.active.id) as Screen)
    const to = ids.indexOf(String(e.over.id) as Screen)
    if (from < 0 || to < 0) return
    // Store the WHOLE resolved order, not a diff — sanitizeNavOrder is then
    // only ever repairing a stale file, never reconstructing intent.
    void save({ navOrder: arrayMove(ids, from, to) })
  }

  return (
    <section className="space-y-3">
      <div className="microlabel">left nav</div>
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 pt-3">
        <div className="flex items-start gap-3 pb-2">
          <p className="text-[11.5px] text-faint max-w-md">
            Drag to reorder the left nav, and hide what you don&apos;t use. Hidden screens stay
            reachable by their keyboard shortcut and the command palette; Commands stays on{' '}
            {MOD}K; the mini player stays in the palette and the View menu.{' '}
            <span className="text-dim">Shortcut keys never move with position.</span>
          </p>
          {customized && (
            <HeaderChip
              onClick={() => void save({ navOrder: [] })}
              data-tip="Back to the default order"
              className="tip-top tip-end shrink-0 text-[12px] px-2.5 py-1 motion-safe:active:scale-90"
            >
              Reset order
            </HeaderChip>
          )}
        </div>
        <div className="space-y-0.5">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {ordered.map((sc) => (
                <SidebarRow
                  key={sc.id}
                  sc={sc}
                  sortableId={sc.id}
                  locked={NAV_UNHIDEABLE.includes(sc.id)}
                  hidden={hiddenSet.has(sc.id)}
                  onToggle={(hide) => setHidden(sc.id, hide)}
                />
              ))}
            </SortableContext>
          </DndContext>
          {/* Below the line: the pinned bottom cluster. Hideable, but NOT
              reorderable — its slots are fixed, so there is nothing to drag. */}
          <div className="my-1 border-t border-edge/60" />
          {NAV_TOOLS.map((t) => (
            <SidebarRow
              key={t.id}
              sc={t}
              locked={false}
              hidden={hiddenToolSet.has(t.id)}
              onToggle={(hide) => setToolHidden(t.id, hide)}
            />
          ))}
          <SidebarRow sc={SETTINGS_SCREEN} locked hidden={false} />
        </div>
      </div>
    </section>
  )
}

function SidebarRow({
  sc,
  sortableId,
  locked,
  hidden,
  onToggle
}: {
  sc: ScreenDef | NavToolDef
  /** Present for the reorderable screen rows; absent for the pinned cluster. */
  sortableId?: Screen
  locked: boolean
  hidden: boolean
  onToggle?: (hide: boolean) => void
}): React.JSX.Element {
  const body = (
    <SidebarRowBody
      Icon={sc.icon}
      label={sc.label}
      keyBadge={'key' in sc ? sc.key : null}
      locked={locked}
      hidden={hidden}
      onToggle={onToggle}
    />
  )
  if (sortableId) {
    return (
      <SortableSidebarRow id={sortableId} label={sc.label} hidden={hidden}>
        {body}
      </SortableSidebarRow>
    )
  }
  return (
    <div className="group flex items-center gap-3 h-9 px-1.5 rounded-lg">
      {/* the grip column the sortable rows use, held empty so the pinned
          cluster's icons and labels stay on the same vertical lines */}
      <span className="w-[26px] shrink-0" />
      {body}
    </div>
  )
}

/** The draggable shell: OrderHandle in the leading cell, lockVertical on the
 *  transform (a one-axis list — see lib/dnd). */
function SortableSidebarRow({
  id,
  label,
  hidden,
  children
}: {
  id: Screen
  label: string
  hidden: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(lockVertical(transform)), transition }}
      data-nav-order-row={id}
      className={cx(
        'group flex items-center gap-3 h-9 px-1.5 rounded-lg',
        isDragging && 'z-10 bg-raised shadow-xl'
      )}
    >
      {/* The grip stays at full strength on a hidden row: you must be able to
          move a row you have hidden, and dimming the one control that says
          "this is draggable" would hide the affordance with the content. */}
      <div className={cx('w-[26px] shrink-0', hidden && 'opacity-100')}>
        <OrderHandle label={`Reorder ${label}`} attributes={attributes} listeners={listeners}>
          {/* A nav row shows NOTHING at rest — order is the point, not the slot
              index, and numbering a list of ten screens 1–10 invites reading
              them as ranks. But the child still has to CARRY HEIGHT:
              OrderHandle sizes its box from whatever sits here and lays the
              grip over it with `absolute inset-0`, so an empty child collapses
              the box to zero — which drops the icon half its own height below
              the row AND leaves the button with no hit area (the drag then
              only works because the overflowing icon is itself clickable).
              15px matches the row's leading icon, so the grip lands on the
              same centre line as everything else in the row. */}
          <span className="block h-[15px]" />
        </OrderHandle>
      </div>
      {children}
    </div>
  )
}

function SidebarRowBody({
  Icon,
  label,
  keyBadge,
  locked,
  hidden,
  onToggle
}: {
  Icon: ScreenDef['icon']
  label: string
  /** The screen's shortcut. Shown BECAUSE the row moves: watching the key sit
   *  still while its row travels is the fastest way to learn that keys don't
   *  follow position. */
  keyBadge: string | null
  locked: boolean
  hidden: boolean
  onToggle?: (hide: boolean) => void
}): React.JSX.Element {
  return (
    <>
      <Icon size={15} strokeWidth={1.8} className={cx('shrink-0 text-dim', hidden && 'opacity-45')} />
      <span className={cx('flex-1 text-[13px]', hidden && 'opacity-45')}>{label}</span>
      {keyBadge && (
        <span className={cx('font-mono text-[9px] text-faint/60 shrink-0', hidden && 'opacity-45')}>
          {keyBadge}
        </span>
      )}
      {locked ? (
        <span
          data-tip="Always shown"
          className="tip-top tip-end flex items-center justify-center h-7 w-7 text-faint"
        >
          <Lock size={13} strokeWidth={1.8} />
        </span>
      ) : (
        <button
          onClick={() => onToggle?.(!hidden)}
          data-tip={hidden ? 'Show in left nav' : 'Hide from left nav'}
          aria-label={hidden ? `Show ${label} in left nav` : `Hide ${label} from left nav`}
          className="tip-top tip-end flex items-center justify-center h-7 w-7 rounded-md text-dim hover:text-ink hover:bg-veil motion-safe:active:scale-90 transition-all"
        >
          {hidden ? <EyeOff size={15} strokeWidth={1.8} /> : <Eye size={15} strokeWidth={1.8} />}
        </button>
      )}
    </>
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
