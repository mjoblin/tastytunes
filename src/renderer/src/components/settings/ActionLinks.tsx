import { useState } from "react";
import { URL_EXAMPLES, URL_SCHEME } from "@shared/urlActions";
import { CopyRow, useCopied } from "@/components/settings/SettingsKit";

// Settings › Behavior's list of tastytunes:// links (0.12.0, the URL scheme), one to copy for
// every verb, in shared/urlActions' order. A label for every example is required by the type,
// so a verb added there is a compile error here until it is described.

const LABELS: Record<(typeof URL_EXAMPLES)[number], string> = {
  "toggle-play": "Play or pause",
  play: "Play",
  pause: "Pause",
  stop: "Stop",
  next: "Next track",
  previous: "Previous track",
  "volume/up": "Volume up",
  "volume/down": "Volume down",
  "volume/up/5": "Up 5 steps",
  "volume/30": "Volume to 30%",
  "toggle-mute": "Mute or unmute",
  "mute/on": "Mute",
  "mute/off": "Unmute",
  "preset/1": "Preset 1",
  "source/CD": "Source by name",
  "toggle-power": "Wake or standby",
  "power/on": "Wake",
  "power/standby": "Standby",
  "screen/now-playing": "Go to a screen",
  "toggle-mini": "Mini player",
};

export function ActionLinks(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { copied, copy } = useCopied();
  return (
    <div data-action-links>
      <div className="text-[13.5px]">Action links</div>
      <div className="text-[11.5px] text-faint max-w-sm">
        Use these links on an Elgato Stream Deck or in a launcher like Raycast to control the
        streamer without switching to TastyTunes.
      </div>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mt-1 font-mono text-[10.5px] text-faint hover:text-dim transition-colors"
      >
        {open ? "▾ hide links" : `▸ ${URL_EXAMPLES.length} links`}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 max-w-xl">
          {URL_EXAMPLES.map((ex) => {
            const url = `${URL_SCHEME}://${ex}`;
            return (
              <CopyRow
                key={ex}
                label={LABELS[ex]}
                text={url}
                copied={copied === ex}
                onCopy={() => copy(ex, url)}
                labelWidth="w-32"
              />
            );
          })}
          <div className="text-[11.5px] text-faint max-w-sm pt-1">
            Change the number or name at the end of a link for a different preset, source, screen or
            volume. Screens use the names in the Go menu, such as queue or history.
          </div>
        </div>
      )}
    </div>
  );
}
