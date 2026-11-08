// THE BEHAVIOR TAB (moved out of SettingsScreen.tsx as it was, 0.16.0's tidy before the design pass:
// each tab its own section, as Libraries, History, Updates, Schedules and AI agents already were).
import { type MotionMode } from "@shared/model";
import { useStore } from "@/store";
import { HeaderChip } from "@/components/chrome/Chrome";
import { Segmented } from "@/components/controls/Segmented";
import { ActionLinks } from "@/components/settings/ActionLinks";
import {
  NumberField,
  SettingRow,
  SettingsCard,
  Toggle,
  type SectionProps,
} from "@/components/settings/SettingsKit";

export function BehaviorSection({ settings, save }: SectionProps): React.JSX.Element {
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen);
  return (
    <section className="space-y-3">
      <SettingsCard>
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

        <ActionLinks />

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
          <HeaderChip
            onClick={() => setShortcutsOpen(true)}
            className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
          >
            View shortcuts
          </HeaderChip>
        </SettingRow>

        <SettingRow
          label="Volume limit (%)"
          hint="Caps the volume TastyTunes will set. The streamer's remote and other apps aren't affected. Leave empty for no limit."
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
      </SettingsCard>
    </section>
  );
}
