import { useEffect } from "react";
import type { DisplayStatus } from "@shared/ipc";
import { tt } from "@/api";
import { useStore } from "@/store";
import { HeaderChip } from "@/components/chrome/Chrome";
import {
  CopyRow,
  NumberField,
  SettingRow,
  SettingsCard,
  Toggle,
  useCopied,
  type SectionProps,
} from "@/components/settings/SettingsKit";

/**
 * DISPLAY ON OTHER SCREENS (0.17.0, main/app/display): the switch, the address a tablet or another
 * computer's browser opens (with its token), a new address when one has been shared too widely,
 * and the port. The status is read fresh when the card shows (the computer's address can have
 * changed), then follows main's pushes as the server starts, stops or fails.
 */
const setDisplayStatus = (displayStatus: DisplayStatus): void =>
  useStore.setState({ displayStatus });

export function DisplayServerSection({ settings, save }: SectionProps): React.JSX.Element {
  const status = useStore((s) => s.displayStatus);
  const { copied, copy } = useCopied();
  const on = settings.displayServer.enabled;
  const port = settings.displayServer.port;
  useEffect(() => {
    void tt.getDisplayStatus().then(setDisplayStatus);
  }, []);
  return (
    <SettingsCard>
      <div data-display-server className="space-y-3">
        <Toggle
          label="Display on other screens"
          hint="Show Display mode on a tablet or another computer on your network. Each lyric is looked up as it plays, as on this screen."
          checked={on}
          onChange={(enabled) =>
            void save({ displayServer: { ...settings.displayServer, enabled } })
          }
        />
        {on && status?.error && <div className="text-[12px] text-dim">{status.error}</div>}
        {on && status?.url && (
          <div className="space-y-2">
            <CopyRow
              label="Address"
              text={status.url}
              copied={copied === "display"}
              onCopy={() => copy("display", status.url!)}
              hint="Copy the address"
            />
            <div className="flex items-center justify-between gap-4">
              <div className="text-[11.5px] text-faint max-w-sm">
                Open it once on each screen. Anyone with the address can see what's playing.
              </div>
              <HeaderChip
                onClick={() => void tt.displayNewAddress().then(setDisplayStatus)}
                className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
              >
                New address
              </HeaderChip>
            </div>
          </div>
        )}
        {on && (
          <SettingRow label="Port" hint="Change it if another app uses this one.">
            <NumberField
              value={port}
              min={1024}
              max={65535}
              widthClass="w-24"
              onCommit={(p) => {
                if (p != null) void save({ displayServer: { ...settings.displayServer, port: p } });
              }}
            />
          </SettingRow>
        )}
      </div>
    </SettingsCard>
  );
}
