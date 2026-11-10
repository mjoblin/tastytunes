// THE BEHAVIOR TAB (moved out of SettingsScreen.tsx as it was, 0.16.0's tidy: each tab its own
// section, as Libraries, History, Updates, Schedules and AI agents already were).
import { useEffect, useState } from "react";
import type { LoginItemState } from "@shared/ipc";
import { type MotionMode } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { HeaderChip } from "@/components/chrome/Chrome";
import { Segmented } from "@/components/controls/Segmented";
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
        {/* First in the section: the panel is the app's reach-without-a-window
                face, and this is its switch. */}
        <Toggle
          label="Menu bar icon"
          hint="Add a TastyTunes icon to the menu bar to control the streamer without opening the full TastyTunes app. (Found in the system tray on Windows and Linux)."
          checked={settings.tray}
          onChange={(tray) => void save({ tray })}
        />

        <OpenAtLogin tray={settings.tray} />

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

/**
 * OPEN AT LOGIN (main/app/loginItem): the system's own login item, so the switch reads the system
 * each time the row shows and when the window comes back to the front (it can be turned off in
 * Task Manager or System Settings meanwhile). Not offered on Linux; shown but off in a development
 * run, where only the installed app may register. With the menu bar icon on, a launch at login
 * starts there without a window.
 */
function OpenAtLogin({ tray }: { tray: boolean }): React.JSX.Element | null {
  const [state, setState] = useState<LoginItemState | null>(null);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void tt.getLoginItem().then((s) => {
        if (live) setState(s);
      });
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, []);
  if (!state || state.available === "no") return null;
  const hint =
    state.available === "installed-only"
      ? "Start TastyTunes when you sign in to your computer. Works in the installed app."
      : state.needsApproval
        ? "Allow TastyTunes in System Settings › General › Login Items to finish turning this on."
        : tray
          ? "Start TastyTunes when you sign in to your computer. With the menu bar icon on, it starts there without opening a window."
          : "Start TastyTunes when you sign in to your computer.";
  return (
    <Toggle
      label="Open at login"
      hint={hint}
      checked={state.on}
      disabled={state.available !== "yes"}
      onChange={(on) => void tt.setLoginItem(on).then(setState)}
    />
  );
}
