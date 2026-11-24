import { useEffect, useState } from "react";
import type { DisplayStatus } from "@shared/ipc";
import { tt } from "@/api";
import { useStore } from "@/store";
import { HeaderChip } from "@/components/chrome/Chrome";
import { QrCode } from "@/components/settings/QrCode";
import { maskedAddress } from "@/lib/displayAddress";
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
  // the QR code is the address as a picture, so it is shown only when asked for
  const [qrShown, setQrShown] = useState(false);
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
          hint="Show display mode in a web browser on a tablet, TV or another computer on your network. Each screen can pick its own scene."
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
              text={maskedAddress(status.url)}
              copied={copied === "display"}
              onCopy={() => copy("display", status.url!)}
              hint="Copy the address"
            />
            <div className="flex items-center justify-between gap-4">
              <div className="text-[11.5px] text-faint max-w-sm">
                Open this address once on each screen. Anyone who has it can see what's playing.
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <HeaderChip
                  data-display-qr-toggle
                  onClick={() => setQrShown((v) => !v)}
                  className="text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
                >
                  {qrShown ? "Hide QR code" : "Show QR code"}
                </HeaderChip>
                <HeaderChip
                  onClick={() => void tt.displayNewAddress().then(setDisplayStatus)}
                  className="text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
                >
                  New address
                </HeaderChip>
              </div>
            </div>
            {qrShown && (
              <div className="flex items-center gap-4 pt-1">
                <QrCode text={status.url} label="QR code for the display's address" />
                <div className="text-[11.5px] text-faint max-w-[16rem] space-y-2">
                  <p>Point the tablet's camera at the code to open the address.</p>
                  <p>Turn off auto-lock on the tablet to keep its screen on.</p>
                  <p>
                    If the address stops working after a restart, give this computer a fixed address
                    in your router.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
        {on && (
          <SettingRow label="Port" hint="Change this if another app is using the same port.">
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
