import { join } from "node:path";
import type { DisplayStatus } from "@shared/ipc";
import type { AppSettings } from "@shared/model";
import { artHostTrust, fetchPicture } from "../lookups/artFetch";
import { fetchLyrics } from "../lookups/lyrics";
import { displayToken, getSettings, newDisplayToken } from "../data/persist";
import { DisplayServer } from "../servers/displayServer";
import { lanAddress } from "../servers/mcpServer";
import { connectedHost, deviceManager } from "./runtime";

/**
 * DISPLAY ON OTHER SCREENS, WIRED (0.17.0): the display server (servers/displayServer) follows its
 * switch in Settings › Integrations, answers from the app's own state, and serves the built page
 * (out/renderer/display.html). Settings shows the address it reports here.
 */

const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

export const displayServer = new DisplayServer({
  snapshot: () => deviceManager.snapshot(),
  lyrics: (q) => fetchLyrics(q, false),
  lyricsAllowed: () => getSettings().lyrics,
  picture: (url) =>
    fetchPicture(url, artHostTrust(connectedHost()), {
      maxBytes: MAX_PICTURE_BYTES,
      timeoutMs: 8_000,
      logged: false,
    }),
  token: () => displayToken(),
  pageDir: join(__dirname, "../renderer"),
  log: (text) => deviceManager.log("info", "display", text),
});

let status: DisplayStatus = { running: false, url: null, error: null };

async function address(port: number): Promise<string | null> {
  const ip = lanAddress();
  return ip ? `http://${ip}:${port}/?t=${encodeURIComponent(await displayToken())}` : null;
}

/** Starts, moves or stops the server to match the settings. */
export async function syncDisplay(s: AppSettings = getSettings()): Promise<DisplayStatus> {
  const want = s.displayServer;
  if (!want.enabled) {
    displayServer.stop();
    status = { running: false, url: null, error: null };
    return status;
  }
  if (displayServer.running && displayServer.port === want.port) {
    status = { running: true, url: await address(want.port), error: null };
    return status;
  }
  displayServer.stop();
  try {
    await displayServer.start(want.port);
    status = { running: true, url: await address(want.port), error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    status = {
      running: false,
      url: null,
      error:
        code === "EADDRINUSE"
          ? `Port ${want.port} is in use by another app. Choose another port.`
          : `Couldn't start: ${(e as Error).message}`,
    };
  }
  return status;
}

export function displayStatus(): DisplayStatus {
  return status;
}

/** A new address: screens on the old one need the new one. */
export async function newDisplayAddress(): Promise<DisplayStatus> {
  await newDisplayToken();
  return syncDisplay();
}
