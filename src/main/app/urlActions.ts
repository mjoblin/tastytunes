import { app, Notification } from "electron";
import type { StreamerCommand } from "@shared/ipc";
import { parseUrlAction, staysInBackground, URL_SCHEME, type UrlAction } from "@shared/urlActions";
import { errorMessage } from "@shared/guards";
import { MENU_SCREENS } from "./menu";
import { deviceManager } from "./runtime";
import { giveFocusBack, onUrl } from "./urlInbox";
import { sendMenuCommand, showMainWindow, toggleMiniPlayer } from "./windows";

/**
 * WHAT A tastytunes:// URL DOES (0.12.0, the URL scheme). The verbs are shared/urlActions; the
 * URLs arrive through app/urlInbox. Every verb goes out through deviceManager.command, the path
 * the app's own buttons and the agents' tools take (a play verb wakes a standby streamer there,
 * a volume is held to the app's limit there), never a second implementation. A cold start's verb
 * waits for the streamer's connection. Only a failure speaks, as a system notification (the
 * window may be out of sight), and every URL leaves a line in the diagnostics log.
 *
 * REGISTRATION is for packaged builds only: a dev run registering Electron.app would take the
 * scheme from his installed app. macOS reads CFBundleURLTypes (electron-builder's protocols)
 * when the app is copied or first opened; Windows has no installer step for a scheme, so a
 * packaged launch registers it (HKCU, pointing at the installed exe; the uninstaller removes it,
 * build/installer.nsh); Linux reaches it only through an integrated AppImage's .desktop file.
 */

/** How long a verb waits for the streamer when it arrives with the app just launched. */
const CONNECT_WAIT_MS = 15_000;

/** The names a URL may give a screen: its key, and its name as the Go menu shows it
 *  ("history" for the History screen, whose key is recently-played), and Settings. */
const SCREEN_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  MENU_SCREENS.flatMap(([screen, label]): Array<[string, string]> => [
    [screen, screen],
    [label.toLowerCase().replace(/\s+/g, "-"), screen],
  ]).concat([["settings", "settings"]]),
);

/** Takes the URLs; called once, in whenReady. */
export function serveUrlActions(): void {
  if (app.isPackaged && !process.mas && process.platform !== "linux") {
    try {
      app.setAsDefaultProtocolClient(URL_SCHEME);
    } catch {
      // registration is a convenience; a failure leaves the scheme to the bundle's own claim
    }
  }
  onUrl((url, stoleFocus) => void run(url, stoleFocus));
}

function report(level: "info" | "warn", text: string): void {
  deviceManager.log(level, "url", text);
}

/** A refused or failed verb says so where the user is, and in the log (with the detail, when
 *  there is one the user need not read). */
function refuse(url: string, reason: string, detail?: string): void {
  report("warn", `${url}: ${reason}${detail ? ` (${detail})` : ""}`);
  // the suite's runs never reach for the user's attention (app/windows' TEST_INACTIVE)
  if (!Notification.isSupported() || process.env.TASTYTUNES_TEST_INACTIVE === "1") return;
  new Notification({ title: "TastyTunes", body: reason, silent: true }).show();
}

function connected(): boolean {
  return deviceManager.snapshot().connection.phase === "connected";
}

async function waitForStreamer(): Promise<boolean> {
  const until = Date.now() + CONNECT_WAIT_MS;
  while (!connected()) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

const same = (a: string, b: string): boolean =>
  a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

/** The command an action stands for, resolved against the streamer's own lists; a string is
 *  the reason it cannot be done. */
function commandFor(
  action: Exclude<UrlAction, { kind: "screen" | "mini" }>,
): StreamerCommand | string {
  const s = deviceManager.snapshot();
  switch (action.kind) {
    case "command":
      return action.command;
    case "muteToggle":
      return { type: "setMute", mute: !(s.zoneState?.mute ?? false) };
    case "preset": {
      const list = s.presets?.presets;
      if (list && !list.some((p) => p.id === action.slot)) return `Preset ${action.slot} is empty.`;
      return { type: "recallPreset", presetId: action.slot };
    }
    case "source": {
      const all = s.sources?.sources ?? [];
      const hit =
        all.find((x) => same(x.id, action.name)) ??
        all.find((x) => same(x.name, action.name)) ??
        all.find((x) => same(x.default_name, action.name));
      return hit
        ? { type: "setSource", sourceId: hit.id }
        : `This streamer has no source called “${action.name}”.`;
    }
  }
}

async function run(url: string, stoleFocus: boolean): Promise<void> {
  const parsed = parseUrlAction(url, SCREEN_NAMES);
  // the focus first, before any wait: a key press should not leave the app in front
  if (stoleFocus && (!parsed.ok || staysInBackground(parsed.action))) giveFocusBack();
  if (!parsed.ok) return refuse(url, parsed.reason);
  const { action, verb } = parsed;
  if (action.kind === "screen") {
    sendMenuCommand({ id: "screen", screen: action.screen });
    showMainWindow();
    return report("info", `${verb}: shown`);
  }
  if (action.kind === "mini") {
    toggleMiniPlayer();
    return report("info", `${verb}: the mini player switched`);
  }
  if (!(await waitForStreamer())) return refuse(url, "TastyTunes isn't connected to a streamer.");
  const cmd = commandFor(action);
  if (typeof cmd === "string") return refuse(url, cmd);
  try {
    await deviceManager.command(cmd);
    report("info", `${verb}: ${cmd.type} sent`);
  } catch (e) {
    refuse(
      url,
      "The streamer didn't respond. Check that it's on and on the network.",
      errorMessage(e),
    );
  }
}
