import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { PushMessage } from "@shared/ipc";
import { artHostTrust, fetchPicture } from "../lookups/artFetch";
import { getSettings } from "../data/persist";
import { connectedHost, deviceManager } from "./runtime";
import { showMainWindow } from "./windows";
import { NowPlayingBridge } from "./nowPlayingBridge";

/**
 * THE SYSTEM'S NOW PLAYING (0.17.0): with the helper (native/nowplaying in the Mac app's
 * Contents/Helpers, native/nowplaying-win beside the Windows exe), TastyTunes is the system's
 * playing app while the streamer plays one of its own
 * plays, so the media keys, Control Center's buttons and a headset's button control the streamer
 * with no Accessibility permission and no global shortcuts (app/mediaKeys uses this in their place
 * when it is available). The rules are app/nowPlayingRules, the process and feed
 * app/nowPlayingBridge; this file wires them to the app.
 *
 * The helper runs only while the Media keys setting is on. A development run uses it only when
 * TASTYTUNES_NP_HELPER names one (the suite's fake, or a built helper): two copies of the app
 * each claiming Now Playing would take the keys from each other.
 */

export const HELPER_NAME = "TastyTunes Now Playing";

function helperFile(): string | null {
  const named = process.env["TASTYTUNES_NP_HELPER"];
  if (named) return named;
  if (!app.isPackaged) return null;
  // macOS: Contents/Helpers; Windows: beside TastyTunes.exe (native/nowplaying-win)
  const file =
    process.platform === "darwin"
      ? join(process.resourcesPath, "..", "Helpers", HELPER_NAME)
      : process.platform === "win32"
        ? join(dirname(process.execPath), `${HELPER_NAME}.exe`)
        : null;
  return file && existsSync(file) ? file : null;
}

/** The app's icon, for a play with no sleeve, so the Mac's tile never shows a blank square
 *  (Windows shows the app's own icon there by itself). */
function iconFile(): string | null {
  if (process.platform === "win32") return null;
  const file = app.isPackaged
    ? join(process.resourcesPath, "icon.icns")
    : join(app.getAppPath(), "build", "icon.png");
  return existsSync(file) ? file : null;
}

const MAX_SLEEVE_BYTES = 8 * 1024 * 1024;
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** The sleeve as one file in the cache folder, the last one removed: the one picture fetch path
 *  (lookups/artFetch, checked and logged as every other). */
async function sleeveFile(url: string): Promise<string | null> {
  const picture = await fetchPicture(url, artHostTrust(connectedHost()), {
    maxBytes: MAX_SLEEVE_BYTES,
    timeoutMs: 8_000,
    logged: false,
  });
  if (!picture) return null;
  const dir = join(app.getPath("userData"), "cache", "nowplaying");
  try {
    mkdirSync(dir, { recursive: true });
    const name = `${createHash("sha1").update(url).digest("hex").slice(0, 16)}.${EXT[picture.type] ?? "img"}`;
    for (const old of readdirSync(dir)) if (old !== name) rmSync(join(dir, old), { force: true });
    const file = join(dir, name);
    writeFileSync(file, picture.bytes);
    return file;
  } catch {
    return null;
  }
}

let bridge: NowPlayingBridge | null = null;

/** Turns the Mac's Now Playing on or off with the Media keys setting; false where it isn't
 *  available (another system, or a development run with no helper named), so the caller binds
 *  the keys the old way. */
export function syncNowPlaying(on: boolean): boolean {
  const file = helperFile();
  if (!file) return false;
  bridge ??= new NowPlayingBridge({
    command: { file },
    view: () => {
      const s = deviceManager.streamerNow;
      return {
        connected: deviceManager.connectionNow.phase === "connected",
        powerOn: s.systemPower?.power === "ON",
        playState: s.playState,
        nowPlaying: s.nowPlaying,
        position: s.position?.position ?? s.playState?.position ?? null,
      };
    },
    claimExternal: () => getSettings().mediaKeysExternal,
    fire: (cmd) => deviceManager.fire(cmd),
    activate: () => showMainWindow(),
    artFile: sleeveFile,
    fallbackArt: iconFile(),
    log: (text) => deviceManager.log("info", "nowplaying", text),
    now: () => Date.now(),
  });
  if (on) bridge.start();
  else bridge.stop();
  return true;
}

/** Whether the helper is up and speaking. */
export function nowPlayingRunning(): boolean {
  return bridge?.running === true;
}

/** What the streamer reports reaches the helper; a recall from the app marks its play as ours. */
export function nowPlayingPush(msg: PushMessage): void {
  if (!bridge) return;
  if (msg.kind === "recalledPreset") {
    if (msg.id != null) bridge.recalled();
    return;
  }
  if (
    msg.kind === "connection" ||
    msg.kind === "systemPower" ||
    msg.kind === "playState" ||
    msg.kind === "nowPlaying" ||
    msg.kind === "position"
  )
    bridge.update();
}

/** A setting that changes what is claimed (mediaKeysExternal) takes effect at once. */
export function nowPlayingRefresh(): void {
  bridge?.update();
}
