import { useEffect, useState } from "react";
import { screenCode, type DisplayScreen, type DisplayScreens } from "@shared/displayControl";
import type { DisplayStatus } from "@shared/ipc";
import { tt } from "@/api";
import { useStore } from "@/store";
import { HeaderChip } from "@/components/chrome/Chrome";
import { useConfirmPopover } from "@/components/chrome/Confirm";
import { QrCode } from "@/components/settings/QrCode";
import { maskedAddress } from "@/lib/displayAddress";
import { fmtRelative } from "@/lib/format";
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
 * computer's browser opens (with its token), a new address when one has been shared too widely or
 * the saved one couldn't be read, and the port. The status is read fresh when the card shows (the
 * computer's address can have changed), then follows main's pushes as the server starts, stops or
 * fails, and as a streamer connects (the address on its network, where this computer has one).
 *
 * CONTROLS ON THE OTHER SCREENS: a switch of its own, off by default (turning on viewing never
 * grants control), under it the volume and the controls that start music (presets, Wake, picking
 * up where it left off), each with a switch of its own and off by default, and the screens that
 * asked, each allowed or not, with Remove (main/servers/displayScreens).
 */
const setDisplayStatus = (displayStatus: DisplayStatus): void =>
  useStore.setState({ displayStatus });
const setDisplayScreens = (displayScreens: DisplayScreens): void =>
  useStore.setState({ displayScreens });

export function DisplayServerSection({ settings, save }: SectionProps): React.JSX.Element {
  const status = useStore((s) => s.displayStatus);
  const { copied, copy } = useCopied();
  // the QR code is the address as a picture, so it is shown only when asked for
  const [qrShown, setQrShown] = useState(false);
  // what the last New address said in the card: refused (the saved secrets couldn't be set aside
  // or written), or made once the saved keys, which couldn't be read, were set aside
  const [newSaid, setNewSaid] = useState<NewSaid>(null);
  const on = settings.displayServer.enabled;
  const port = settings.displayServer.port;
  useEffect(() => {
    void tt.getDisplayStatus().then(setDisplayStatus);
  }, []);
  return (
    <SettingsCard>
      <div data-display-server className="space-y-3">
        <Toggle
          label="Second screen"
          hint="Show full-screen display mode in a web browser on a tablet or another computer on your network. Each screen can have its own scene and settings. Lyrics are looked up for each track, as on this computer."
          checked={on}
          onChange={(enabled) =>
            void save({ displayServer: { ...settings.displayServer, enabled } })
          }
        />
        {on && status?.error && (
          <div data-display-error className="flex items-center justify-between gap-4">
            <div className="text-[12px] text-dim">{status.error}</div>
            {status.addressUnreadable && (
              <NewAddress controls={settings.displayControl} onSaid={setNewSaid} />
            )}
          </div>
        )}
        {on && newSaid === "failed" && (
          <div data-display-new-address-error className="text-[12px] text-dim">
            Couldn't make a new address. Try again.
          </div>
        )}
        {on && newSaid === "set-aside" && (
          <div data-display-new-address-set-aside className="text-[12px] text-dim">
            Made a new address. The saved keys couldn't be read, so any keys need to be entered
            again.
          </div>
        )}
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
                <NewAddress controls={settings.displayControl} onSaid={setNewSaid} />
              </div>
            </div>
            {qrShown && (
              <div className="flex items-center gap-4 pt-1">
                <QrCode text={status.url} label="QR code for the display's address" />
                <div className="text-[11.5px] text-faint max-w-[16rem] space-y-2">
                  <p>Point the tablet's camera at the QR code to open the address.</p>
                  <p>Turn off auto-lock on the tablet to keep its screen on.</p>
                  <p>
                    For a full-screen app with no browser bars, add it to the Home Screen from the
                    browser's Share menu.
                  </p>
                  <p>
                    If the address stops working after a restart, give this computer a fixed address
                    in your router.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
        {on && <ControlRows settings={settings} save={save} />}
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

/** What a New address says in the card (NewAddress). */
type NewSaid = "failed" | "set-aside" | null;

/** New address, confirmed first: it can't be undone, and every screen on the old address is let
 *  go, every approval with it, and a Home Screen app made from it (decisions/0011). One that
 *  couldn't be made says so, and so does one made once the saved keys, which couldn't be read,
 *  were set aside (`onSaid`); the next try clears it. */
function NewAddress({
  controls,
  onSaid,
}: {
  controls: boolean;
  onSaid: (said: NewSaid) => void;
}): React.JSX.Element {
  const confirm = useConfirmPopover();
  return (
    <>
      <HeaderChip
        data-display-new-address
        onClick={(e) =>
          confirm.ask(e, {
            question: controls
              ? "Make a new address? Screens using the current one stop working until they open the new one and are allowed again."
              : "Make a new address? Screens using the current one stop working until they open the new one.",
            verb: "New address",
            onConfirm: () => {
              onSaid(null);
              void tt
                .displayNewAddress()
                .then(({ status, keysSetAside }) => {
                  setDisplayStatus(status);
                  if (keysSetAside) onSaid("set-aside");
                })
                .catch(() => onSaid("failed"));
            },
          })
        }
        className="text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
      >
        New address
      </HeaderChip>
      {confirm.popover}
    </>
  );
}

/** The controls' switch, the volume's under it, and the screens that asked. */
function ControlRows({ settings, save }: SectionProps): React.JSX.Element {
  const screens = useStore((s) => s.displayScreens?.screens ?? []);
  useEffect(() => {
    void tt.getDisplayScreens().then(setDisplayScreens);
  }, []);
  const control = settings.displayControl;
  return (
    <div data-display-control className="space-y-3 border-t border-edge/60 pt-3">
      <Toggle
        label="Playback controls"
        hint="Show play, pause and skip buttons on each second screen. You will be asked here in TastyTunes to confirm each screen's request to enable these buttons."
        checked={control}
        onChange={(displayControl) => void save({ displayControl })}
      />
      {control && (
        <div className="pl-4 ml-1 border-l-2 border-edge/50 space-y-2">
          <Toggle
            label="Volume buttons"
            hint="Change the volume one step for each tap, up to the volume limit (when the streamer reports its level)."
            checked={settings.displayControlVolume}
            onChange={(displayControlVolume) => void save({ displayControlVolume })}
          />
          {settings.displayControlVolume && settings.volumeLimitPercent == null && (
            <div data-display-volume-limit className="text-[11.5px] text-faint max-w-sm">
              No volume limit is set. You can set one in Settings › Behavior.
            </div>
          )}
          <Toggle
            label="Presets, playlists and power"
            hint="Play presets and playlists from these screens, set the sleep timer, and put the streamer in standby or wake it."
            checked={settings.displayControlPresets}
            onChange={(displayControlPresets) => void save({ displayControlPresets })}
          />
        </div>
      )}
      {control && screens.length > 0 && (
        <div data-display-screens className="space-y-1">
          <div className="text-[12px] text-dim">Screens</div>
          <div className="flex flex-col gap-2">
            {screens.map((s) => (
              <ScreenRow key={s.id} screen={s} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ScreenRow({ screen }: { screen: DisplayScreen }): React.JSX.Element {
  return (
    <div
      data-display-screen={screen.id}
      className="flex items-center gap-3 rounded-lg bg-veil px-3 py-2 ring-1 ring-edge"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-ink">{screen.name}</div>
        {/* the code its page showed while it asked, as the app's prompt showed it */}
        <div className="text-[11.5px] text-faint">
          {screen.allowed ? "Allowed" : "Not allowed"} · Code {screenCode(screen.id)} · First asked{" "}
          {fmtRelative(screen.firstSeen)}
        </div>
      </div>
      {!screen.allowed && (
        <HeaderChip
          data-display-screen-allow
          onClick={() => void tt.displayScreenAllow(screen.id, true).then(setDisplayScreens)}
          className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
        >
          Allow
        </HeaderChip>
      )}
      <HeaderChip
        data-display-screen-remove
        onClick={() => void tt.displayScreenRemove(screen.id).then(setDisplayScreens)}
        className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
      >
        Remove
      </HeaderChip>
    </div>
  );
}
