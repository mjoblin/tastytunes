// THE APPEARANCE TAB (moved out of SettingsScreen.tsx as it was, 0.16.0's tidy before the design pass:
// each tab its own section, as Libraries, History, Updates, Schedules and AI agents already were).
import { Monitor, Moon, Sun } from "lucide-react";
import {
  type AccentChoice,
  type AlignH,
  type AlignV,
  type AmbientArtMode,
  type AmbientCoverage,
  type ThemePreference,
} from "@shared/model";
import { DISPLAY_FONTS } from "@/hooks/useDisplayFont";
import { cx } from "@/lib/format";
import { Segmented } from "@/components/controls/Segmented";
import {
  SettingRow,
  SettingsCard,
  Toggle,
  type SectionProps,
} from "@/components/settings/SettingsKit";

export function AppearanceSection({ settings, save }: SectionProps): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SettingsCard>
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
                    ? "ring-accent/50 bg-accentdim text-accent"
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

        <div className={cx(settings.ambientArt === "off" && "opacity-40 pointer-events-none")}>
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

        <SettingRow
          label="Accent color"
          hint="The color of what you click and choose. Album art takes the playing album's color. The tastytunes gold (the logo, the playback controls and the playing markers) never changes."
        >
          <AccentSwatches value={settings.accent} onChange={(accent) => void save({ accent })} />
        </SettingRow>

        <Toggle
          // "Waveforms" undersold it (the terminology pass, 2026-09-17): this is the
          // switch for every measurement made from the audio file — Analyze audio,
          // the dynamic range and loudness readouts, the tempo, the scenes' pulse
          label="Audio analysis"
          // The second sentence exists only until the first measurement
          // proves the feature real here (settings.waveformSeen) —
          // an honest answer for the household whose toggles would
          // otherwise never visibly do anything.
          hint={
            settings.waveformSeen
              ? "Reads audio files from your local media server to measure each track: its waveform, dynamic range, loudness and tempo, and the pulse the scenes draw to. Off reads nothing."
              : "Reads audio files from your local media server to measure each track: its waveform, dynamic range, loudness and tempo, and the pulse the scenes draw to. Off reads nothing. Nothing measured yet. A track from a local media server is measured the first time it plays."
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
      </SettingsCard>

      <Toggle
        label="Album art from audio files"
        hint="When a media server sends small artwork, the full picture is read from the audio file itself, for the Now Playing screen, Full-screen display mode and album headers. Reads from your media server over your local network."
        checked={settings.artFromFiles}
        onChange={(artFromFiles) => void save({ artFromFiles })}
      />
    </section>
  );
}

/** The accent's choices, a swatch each, the chosen one ringed and named beside them: a color is
 *  chosen by looking, and four names would not fit a row (macOS's own accent picker is the model).
 *  Album art's swatch is a blend of soft colors, the album's being any of them. */
const ACCENTS: { id: AccentChoice; label: string }[] = [
  { id: "sand", label: "Sand" },
  { id: "sage", label: "Sage" },
  { id: "teal", label: "Dusty teal" },
  { id: "art", label: "Album art" },
];
const ART_SWATCH =
  "conic-gradient(from 200deg, rgb(var(--accent-sand-rgb)), rgb(196 150 150), rgb(160 146 186), rgb(var(--accent-teal-rgb)), rgb(var(--accent-sage-rgb)), rgb(var(--accent-sand-rgb)))";

function AccentSwatches({
  value,
  onChange,
}: {
  value: AccentChoice;
  onChange(accent: AccentChoice): void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 shrink-0">
      <span className="text-[13px] text-dim whitespace-nowrap">
        {ACCENTS.find((a) => a.id === value)?.label}
      </span>
      <div role="group" aria-label="Accent color" className="flex items-center gap-2.5">
        {ACCENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-label={a.label}
            aria-pressed={value === a.id}
            data-tip={a.label}
            onClick={() => onChange(a.id)}
            className={cx(
              "tip-top h-6 w-6 shrink-0 rounded-full transition-[box-shadow,transform] motion-safe:hover:scale-110",
              value === a.id
                ? "ring-2 ring-ink/70 ring-offset-2 ring-offset-panel"
                : "ring-1 ring-edge2",
            )}
            style={{
              background: a.id === "art" ? ART_SWATCH : `rgb(var(--accent-${a.id}-rgb))`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
