import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { PushMessage } from "@shared/ipc";
import { artHostTrust, fetchPicture } from "../lookups/artFetch";
import { getSettings } from "../data/persist";
import { connectedHost, deviceManager } from "./runtime";
import { showMainWindow } from "./windows";
import { NowPlayingBridge } from "./nowPlayingBridge";
import { helperPath } from "./nowPlayingHelper";

/**
 * THE SYSTEM'S NOW PLAYING (0.17.0): with the helper (native/nowplaying in the Mac app's
 * Contents/Helpers, native/nowplaying-win beside the Windows exe), TastyTunes is the system's
 * playing app while the streamer plays one of its own
 * plays, so the media keys, Control Center's buttons and a headset's button control the streamer
 * with no Accessibility permission and no global shortcuts (app/mediaKeys uses this in their place
 * while the helper is up). The rules are app/nowPlayingRules, the process and feed
 * app/nowPlayingBridge; this file wires them to the app.
 *
 * The helper runs only while the Media keys setting is on; which helper is app/nowPlayingHelper's
 * rule (a packaged app only its own, a development run only one TASTYTUNES_NP_HELPER names).
 *
 * The built-in demo is never claimed (nowPlayingRules). TASTYTUNES_NOWPLAYING_DEMO=1 claims it
 * too, for the Windows install smoke (.github/windows-smoke.mjs), which proves the claim on a
 * runner with no streamer but the demo. An installed build reads it as well, since the smoke
 * drives one; it only lets the demo's silent track have the keys.
 */

const CLAIM_DEMO = process.env["TASTYTUNES_NOWPLAYING_DEMO"] === "1";

function helperFile(): string | null {
  return helperPath({
    packaged: app.isPackaged,
    platform: process.platform,
    env: process.env,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    exists: existsSync,
  });
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

/** The sleeve as one file in the cache folder, the older ones removed: the one picture fetch path
 *  (lookups/artFetch, checked and logged as every other). A picture that can't be had is none,
 *  never a rejection. The new file is written first and the old ones removed one by one, each
 *  failure ignored: Windows may still hold the last one open, and that mustn't cost this one. */
async function sleeveFile(url: string): Promise<string | null> {
  try {
    const picture = await fetchPicture(url, artHostTrust(connectedHost()), {
      maxBytes: MAX_SLEEVE_BYTES,
      timeoutMs: 8_000,
      logged: false,
    });
    if (!picture) return null;
    const dir = join(app.getPath("userData"), "cache", "nowplaying");
    mkdirSync(dir, { recursive: true });
    const name = `${createHash("sha1").update(url).digest("hex").slice(0, 16)}.${EXT[picture.type] ?? "img"}`;
    const file = join(dir, name);
    writeFileSync(file, picture.bytes);
    for (const old of readdirSync(dir)) {
      if (old === name) continue;
      try {
        rmSync(join(dir, old), { force: true });
      } catch {
        // still open elsewhere: the next track's turn removes it
      }
    }
    return file;
  } catch {
    return null;
  }
}

let bridge: NowPlayingBridge | null = null;

/** Turns the system's Now Playing on or off with the Media keys setting; false where it isn't
 *  available (another system, a development run with no helper named, or a helper given up on),
 *  so the caller binds the keys the old way. True, the helper carries the keys only while it is
 *  up (nowPlayingRunning), and `changed` is called at its hello, when it goes down after one, and
 *  when it is given up on, so the caller binds the keys or lets them go then. */
export function syncNowPlaying(on: boolean, changed: () => void): boolean {
  const file = helperFile();
  if (!file) return false;
  if (on && bridge?.gaveUp) return false;
  bridge ??= new NowPlayingBridge({
    command: { file },
    view: () => {
      const s = deviceManager.streamerNow;
      const c = deviceManager.connectionNow;
      return {
        connected: c.phase === "connected",
        powerOn: s.systemPower?.power === "ON",
        demo: c.phase !== "idle" && c.demo === true,
        playState: s.playState,
        nowPlaying: s.nowPlaying,
        position: s.position?.position ?? null,
      };
    },
    claimExternal: () => getSettings().mediaKeysExternal,
    claimDemo: CLAIM_DEMO,
    fire: (cmd) => deviceManager.fire(cmd),
    activate: () => showMainWindow(),
    artFile: sleeveFile,
    fallbackArt: iconFile(),
    log: (text, counted) => deviceManager.log("info", "nowplaying", text, { counted }),
    now: () => Date.now(),
    routeChanged: changed,
  });
  if (on) bridge.start();
  else bridge.stop();
  return true;
}

/** Whether the helper is up and speaking. */
export function nowPlayingRunning(): boolean {
  return bridge?.running === true;
}

/** What the streamer reports reaches the helper, and a new connection claims nothing until the
 *  streamer has spoken on it. */
export function nowPlayingPush(msg: PushMessage): void {
  if (!bridge) return;
  if (msg.kind === "connection" && msg.state.phase === "connected") bridge.connected();
  else if (msg.kind === "playState") bridge.heardFrom("playState");
  else if (msg.kind === "systemPower") bridge.heardFrom("power");
  // the device layer clears its last recall on connect() and disconnect() alone, never on the
  // socket's own reconnect: a switch of streamer forgets what was started on the last one
  else if (msg.kind === "recalledPreset" && msg.id == null) bridge.forgetRecall();
  else if (msg.kind === "connection" || msg.kind === "nowPlaying" || msg.kind === "position")
    bridge.update();
}

/** A preset recall went out from the app (DeviceManager.onRecallSent: every one, the same preset
 *  again included, where the recalledPreset push says only when the last recall changes): the
 *  play it starts is TastyTunes' own, and the play already there when the preset was lit;
 *  `station` when the preset is a station's. */
export function nowPlayingRecalled(lit: boolean, station: boolean): void {
  bridge?.recalled(lit, station);
}

/** A setting that changes what is claimed (mediaKeysExternal) takes effect at once. */
export function nowPlayingRefresh(): void {
  bridge?.update();
}
