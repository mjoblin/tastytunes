import { useState } from "react";
import {
  AlarmClock,
  ArrowUpCircle,
  Bot,
  CircleDot,
  Globe,
  Heart,
  History,
  LayoutGrid,
  Library,
  Monitor,
  Moon,
  Palette,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { version } from "../../../../package.json";
import {
  type AlignH,
  type AlignV,
  type AmbientArtMode,
  type AmbientCoverage,
  type MotionMode,
  type ThemePreference,
} from "@shared/model";
import { useStore } from "@/store";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { DISPLAY_FONTS } from "@/hooks/useDisplayFont";
import { cx } from "@/lib/format";
import { SignalDot } from "@/components/device/SignalLamp";
import { clearRecentsWithUndo } from "@/lib/recents";
import { HeaderChip, PrimaryButton, ScreenTitle } from "@/components/chrome/Chrome";
import { useOneShotAsk } from "@/hooks/useOneShotAsk";
import { McpSection } from "@/components/settings/McpSection";
import { SchedulesSection } from "@/components/settings/SchedulesSection";
import { LibrariesSection } from "@/components/settings/LibrariesSection";
import { HistorySection } from "@/components/settings/HistorySection";
import { ListenBrainzSection } from "@/components/settings/ListenBrainzSection";
import { UpdatesSection } from "@/components/settings/UpdatesSection";
import { SidebarSection } from "@/components/settings/SidebarSection";
import {
  SettingRow,
  Toggle,
  SliderSetting,
  Segmented,
  NumberField,
  LegendRow,
  CacheRow,
} from "@/components/settings/SettingsKit";

const TABS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "layout", label: "Layout", icon: LayoutGrid },
  { id: "behavior", label: "Behavior", icon: SlidersHorizontal },
  { id: "connections", label: "Connections", icon: Globe },
  { id: "libraries", label: "Libraries", icon: Library },
  { id: "history", label: "History", icon: History },
  { id: "updates", label: "Updates", icon: ArrowUpCircle },
  { id: "schedules", label: "Schedules", icon: AlarmClock },
  { id: "agents", label: "AI agents", icon: Bot },
  { id: "lamps", label: "Status lamps", icon: CircleDot },
] as const;
type SettingsTab = (typeof TABS)[number]["id"];

export function SettingsScreen(): React.JSX.Element {
  const settings = useStore((s) => s.settings);
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen);
  const setInfoOpen = useStore((s) => s.setInfoOpen);
  const recentsCount = useStore((s) => s.recents.length);

  const save = useStore((s) => s.saveSettings);

  // Last-visited tab persists; switch locally first so the rail feels instant.
  const [tab, setTab] = useState<SettingsTab>(() =>
    TABS.some((t) => t.id === settings.settingsTab)
      ? (settings.settingsTab as SettingsTab)
      : "appearance",
  );
  const selectTab = (id: SettingsTab): void => {
    setTab(id);
    void save({ settingsTab: id });
  };
  const panelRef = useScrollMemory(`settings:${tab}`);

  const update = useStore((s) => s.update);
  // One-shot deep link (the nav update dot lands on Updates); consume + clear.
  const settingsJump = useStore((s) => s.settingsJump);
  const clearSettingsJump = useStore((s) => s.clearSettingsJump);
  useOneShotAsk(
    settingsJump,
    (tab) => {
      if (TABS.some((t) => t.id === tab)) selectTab(tab as SettingsTab);
    },
    { clear: clearSettingsJump },
  );

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
        <nav className="w-44 shrink-0 space-y-0.5" data-settings-rail>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => selectTab(id)}
              className={cx(
                "w-full flex items-center gap-3 rounded-lg h-9 px-3 text-[13.5px] transition-colors",
                tab === id ? "bg-amberdim text-amber" : "text-dim hover:text-ink hover:bg-veil",
              )}
            >
              <Icon size={15} strokeWidth={1.8} className="shrink-0" />
              <span className="flex-1 text-left">{label}</span>
              {id === "updates" && update && (
                <span
                  aria-label="Update available"
                  className="w-1.5 h-1.5 rounded-full bg-gold shrink-0"
                />
              )}
            </button>
          ))}

          {/* The version, where it's visible from every tab rather than only
              from Updates (and the About box). The rail is pinned while the
              panel scrolls, so this never moves; it opens Updates, which is
              where the version row and the check-now button already live. */}
          <button
            onClick={() => selectTab("updates")}
            title="Open Updates"
            className="w-full px-3 pt-6 text-left font-mono text-[11px] text-faint hover:text-dim"
          >
            v{version}
          </button>
        </nav>

        {/* keyed by tab so each tab keeps its own scroll position */}
        {/* p-px: the cards' 1px ring must not sit flush against the scrollport,
            or it clips when the panel narrows to exactly max-w-2xl */}
        <div key={tab} ref={panelRef} className="flex-1 min-w-0 overflow-y-auto p-px">
          <div className="max-w-2xl space-y-8">
            {tab === "appearance" && (
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
                        { value: "dark", label: "Dark", icon: <Moon size={12} /> },
                        { value: "light", label: "Light", icon: <Sun size={12} /> },
                        { value: "system", label: "System", icon: <Monitor size={12} /> },
                      ]}
                    />
                  </SettingRow>

                  <SettingRow
                    label="Display font"
                    hint="The font for titles and big text. Click a font name to see how it looks."
                  >
                    <div className="flex flex-wrap justify-end gap-1.5 max-w-[340px]">
                      {DISPLAY_FONTS.map((f) => (
                        <button
                          key={f.id}
                          onClick={() => void save({ displayFont: f.id })}
                          style={{ fontFamily: f.stack }}
                          className={cx(
                            "px-3 py-1.5 rounded-lg ring-1 text-[13px] transition-colors",
                            settings.displayFont === f.id
                              ? "ring-gold/50 bg-golddim text-gold"
                              : "ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2",
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
                        { value: "off", label: "Off" },
                        { value: "now-playing", label: "Now Playing" },
                        { value: "all", label: "All screens" },
                      ]}
                    />
                  </SettingRow>

                  <div
                    className={cx(
                      settings.ambientArt === "off" && "opacity-40 pointer-events-none",
                    )}
                  >
                    <SettingRow
                      label="Ambient coverage"
                      hint="Wash just the content area, or the whole window including the nav and transport bar."
                    >
                      <Segmented<AmbientCoverage>
                        value={settings.ambientCoverage}
                        onChange={(ambientCoverage) => void save({ ambientCoverage })}
                        options={[
                          { value: "main", label: "Main area" },
                          { value: "window", label: "Entire window" },
                        ]}
                      />
                    </SettingRow>
                  </div>

                  <Toggle
                    label="Vignette"
                    hint="Darken the edges of the ambient backdrop for a bit of depth."
                    checked={settings.vignette}
                    disabled={settings.ambientArt === "off"}
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
                          { value: "left", label: "Left" },
                          { value: "center", label: "Center" },
                          { value: "right", label: "Right" },
                        ]}
                      />
                      <Segmented<AlignV>
                        value={settings.nowPlayingAlignV}
                        onChange={(nowPlayingAlignV) => void save({ nowPlayingAlignV })}
                        options={[
                          { value: "top", label: "Top" },
                          { value: "center", label: "Middle" },
                          { value: "bottom", label: "Bottom" },
                        ]}
                      />
                    </div>
                  </SettingRow>

                  <Toggle
                    label="Accent follows album art"
                    hint="Tint controls and glows with the playing album's dominant color. The tastytunes gold (the logo and the playing markers) never changes."
                    checked={settings.accentFollowsArt}
                    onChange={(accentFollowsArt) => void save({ accentFollowsArt })}
                  />

                  <Toggle
                    label="Waveforms"
                    // The second sentence exists only until the first waveform
                    // proves the feature real here (settings.waveformSeen) —
                    // an honest answer for the household whose toggles would
                    // otherwise never visibly do anything.
                    hint={
                      settings.waveformSeen
                        ? "Generate waveforms from audio files on your local media server."
                        : "Generate waveforms from audio files on your local media server. None yet. They appear once a track from a local media server has played."
                    }
                    checked={settings.waveforms}
                    onChange={(waveforms) => void save({ waveforms })}
                  />

                  <Toggle
                    label="Waveform as the seek bar"
                    hint="Displays the playing track's waveform as the seek bar. The plain bar returns for radio and tracks without a waveform."
                    disabled={!settings.waveforms}
                    checked={settings.waveformSeekBar}
                    onChange={(waveformSeekBar) => void save({ waveformSeekBar })}
                  />

                  <Toggle
                    label="Waveform on the Now Playing screen"
                    hint="Displays the playing track's waveform under the album art, with its peak and loudness details."
                    disabled={!settings.waveforms}
                    checked={settings.waveformNowPlaying}
                    onChange={(waveformNowPlaying) => void save({ waveformNowPlaying })}
                  />
                </div>

                <Toggle
                  label="Album art from audio files"
                  hint="When a media server sends small artwork, the full picture is read from the audio file itself, for the Now Playing screen, Display mode and album headers. Reads from your media server over your local network."
                  checked={settings.artFromFiles}
                  onChange={(artFromFiles) => void save({ artFromFiles })}
                />
              </section>
            )}

            {tab === "layout" && (
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
                      hint="Stretch cards so each row spans the full width, sizes flexing with the window. Off keeps cards at the exact size above."
                      checked={settings.presetFillRows}
                      onChange={(presetFillRows) => void save({ presetFillRows })}
                    />
                  </div>
                </section>

                <SidebarSection />
              </>
            )}

            {tab === "behavior" && (
              <section className="space-y-3">
                <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
                  {/* First in the section (user call, 2026-08-03): the panel is the
                app's reach-without-a-window face, and this is its switch. */}
                  <Toggle
                    label="Menu bar icon"
                    hint="Add a TastyTunes icon to the menu bar to control the streamer without opening the full TastyTunes app. (Found in the system tray on Windows and Linux)."
                    checked={settings.tray}
                    onChange={(tray) => void save({ tray })}
                  />

                  <SettingRow
                    label="Animations"
                    hint="Motion effects: hover growth, the small equalizer bars that indicate what's playing, smooth scrolling. System follows your OS Reduce Motion setting."
                  >
                    <Segmented<MotionMode>
                      value={settings.motion}
                      onChange={(motion) => void save({ motion })}
                      options={[
                        { value: "on", label: "On" },
                        { value: "off", label: "Off" },
                        { value: "system", label: "System" },
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
                    hint="A local log of tracks and stations you've played, shown under Recent on the History screen (R). Kept only on this computer."
                  >
                    <button
                      onClick={() => void clearRecentsWithUndo()}
                      disabled={recentsCount === 0}
                      className="shrink-0 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all disabled:opacity-40 disabled:hover:text-dim disabled:hover:ring-edge disabled:hover:bg-panel/70"
                    >
                      {recentsCount > 0 ? `Clear history (${recentsCount})` : "History empty"}
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
                    hint="Caps the volume TastyTunes will set. The streamer's own remote and other apps aren't affected; leave empty for no limit."
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

            {tab === "connections" && (
              <section className="space-y-3">
                {/* everything here talks to a service outside the LAN — each row says
              exactly what leaves the machine, and off always means zero requests */}
                <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
                  <Toggle
                    label="Lyrics on Now Playing"
                    hint="Adds a lyrics panel to the Now Playing screen, fetched (when open) from lrclib.net. Sends the current track's title and artist to LRCLIB; off means no requests will be sent."
                    checked={settings.lyrics}
                    onChange={(lyrics) => void save({ lyrics })}
                  />

                  <Toggle
                    label="Current lyric line"
                    hint="Shows the live synced lyric under the track details on Now Playing (hidden while the full panel is open). Looks up each track as it plays, the same LRCLIB request as above."
                    disabled={!settings.lyrics}
                    checked={settings.lyricsLine}
                    onChange={(lyricsLine) => void save({ lyricsLine })}
                  />

                  <Toggle
                    label="Artist, album & track context"
                    hint="Adds Artist, Album and Track tabs to the context panel on Now Playing: Wikipedia summaries, release details and track credits matched via MusicBrainz, fetched when you open them. Sends the current artist, album and track names; off means no requests will be sent. The panel's Stream tab stays either way."
                    checked={settings.artistInfo}
                    onChange={(artistInfo) => void save({ artistInfo })}
                  />

                  <Toggle
                    label="Missing album art"
                    hint="Fills in art the media server doesn't have: MusicBrainz identifies the album, the Cover Art Archive supplies the image. Server art always wins."
                    checked={settings.albumArtLookup}
                    onChange={(albumArtLookup) => void save({ albumArtLookup })}
                  />

                  <Toggle
                    label="Internet radio directory"
                    hint="Finds stations through radio-browser.info: the Radio screen's search and top lists, and the radio results in unified search. Sends what you type; off means no requests will be sent. Favorited stations still play either way: a favorite keeps its own stream URL."
                    checked={settings.radioDirectory}
                    onChange={(radioDirectory) => void save({ radioDirectory })}
                  />

                  <ListenBrainzSection settings={settings} save={save} />

                  <CacheRow />
                </div>
              </section>
            )}

            {tab === "libraries" && <LibrariesSection settings={settings} save={save} />}

            {tab === "history" && <HistorySection settings={settings} save={save} />}

            {tab === "updates" && <UpdatesSection settings={settings} save={save} />}

            {tab === "schedules" && <SchedulesSection settings={settings} save={save} />}

            {tab === "agents" && <McpSection settings={settings} save={save} />}

            {tab === "lamps" && (
              <section className="space-y-3">
                <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
                  <div>
                    <div className="text-[13.5px] mb-0.5">Connection</div>
                    <div className="text-[11.5px] text-faint mb-2.5">
                      Shown beside each streamer in the device picker and on the Device screen.
                    </div>
                    <div className="space-y-2">
                      <LegendRow
                        swatch={<span className="led led-on" />}
                        label="Connected"
                        desc="Live link to the streamer."
                      />
                      <LegendRow
                        swatch={<span className="led led-busy" />}
                        label="Connecting"
                        desc="Establishing or re-establishing the connection."
                      />
                      <LegendRow
                        swatch={<span className="led led-off" />}
                        label="Offline"
                        desc="No connection to a streamer."
                      />
                    </div>
                  </div>

                  <div>
                    <div className="text-[13.5px] mb-0.5">Signal quality</div>
                    <div className="text-[11.5px] text-faint mb-2.5">
                      Appears in the transport bar and beside the Now Playing badges while something
                      is playing. Click it for the full signal chain.
                    </div>
                    <div className="space-y-2">
                      <LegendRow
                        swatch={<SignalDot quality="hires" />}
                        label="Hi-res lossless"
                        desc="Lossless above CD quality (or MQA)."
                      />
                      <LegendRow
                        swatch={<SignalDot quality="lossless" />}
                        label="Lossless"
                        desc="Bit-perfect CD quality."
                      />
                      <LegendRow
                        swatch={<SignalDot quality="lossy" />}
                        label="Lossy"
                        desc="Compressed stream (internet radio, Bluetooth, AAC/MP3)."
                      />
                    </div>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- ai agents (mcp)
