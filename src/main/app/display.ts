import { join } from "node:path";
import type { DisplayStatus } from "@shared/ipc";
import type { AppSettings } from "@shared/model";
import { artHostTrust, fetchPicture } from "../lookups/artFetch";
import { fetchLyrics } from "../lookups/lyrics";
import { audioAnalysisGet } from "../lookups/audioAnalysis";
import { lookupMediaInfo } from "../media/mediaInfo";
import { displayToken, getSettings, newDisplayToken } from "../data/persist";
import { DisplayServer } from "../servers/displayServer";
import { lanAddress } from "../servers/mcpServer";
import { alsoHearSettings, broadcastDisplayStatus } from "./broadcast";
import { connectedHost, deviceManager } from "./runtime";

/**
 * DISPLAY ON OTHER SCREENS, WIRED (0.17.0): the display server (servers/displayServer) follows its
 * switch in Settings › Integrations, answers from the app's own state, and serves the built page
 * (out/renderer/display.html). Settings shows the address it reports here: worked out each time
 * it is asked (the computer's address can change under a running server), and pushed to the
 * windows whenever the server starts, stops or fails.
 */

const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const PORT_RANGE = [1024, 65535] as const;

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
  // the window's own question, a show: a page never rebuilds an index
  trackInfo: (query) => lookupMediaInfo(connectedHost(), query, "show"),
  analysis: (key) => audioAnalysisGet(key),
  token: () => displayToken(),
  pageDir: join(__dirname, "../renderer"),
  log: (text) => deviceManager.log("info", "display", text),
  failed: () => {
    state = {
      port: null,
      error: "Display on other screens stopped. Turn it off and back on to restart it.",
    };
    void pushStatus();
  },
});

// a settings change reaches every open page as it reaches the windows (the theme, the accent,
// the display font, the Lyrics switch)
alsoHearSettings((settings) => displayServer.push({ kind: "settings", settings }));

/** The server's own state; the address is added when asked. */
let state: { port: number | null; error: string | null } = { port: null, error: null };

export async function displayStatus(): Promise<DisplayStatus> {
  if (state.port == null) return { running: false, url: null, error: state.error };
  const ip = lanAddress();
  const url = ip
    ? `http://${ip}:${state.port}/?t=${encodeURIComponent(await displayToken())}`
    : null;
  return {
    running: true,
    url,
    error: url ? null : "This computer isn't connected to a network.",
  };
}

async function pushStatus(): Promise<DisplayStatus> {
  const status = await displayStatus();
  broadcastDisplayStatus(status);
  return status;
}

const portOk = (p: number): boolean =>
  Number.isInteger(p) && p >= PORT_RANGE[0] && p <= PORT_RANGE[1];

/** Starts, moves or stops the server to match the settings. */
export async function syncDisplay(s: AppSettings = getSettings()): Promise<DisplayStatus> {
  const want = s.displayServer;
  if (!want.enabled) {
    displayServer.stop();
    state = { port: null, error: null };
    return pushStatus();
  }
  if (!portOk(want.port)) {
    displayServer.stop();
    state = {
      port: null,
      error: `Choose a port from ${PORT_RANGE[0]} to ${PORT_RANGE[1]}.`,
    };
    return pushStatus();
  }
  if (displayServer.running && displayServer.port === want.port) return pushStatus();
  displayServer.stop();
  try {
    await displayServer.start(want.port);
    state = { port: want.port, error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    state = {
      port: null,
      error:
        code === "EADDRINUSE"
          ? `Port ${want.port} is in use by another app. Choose another port.`
          : `Couldn't start: ${(e as Error).message}`,
    };
  }
  return pushStatus();
}

/** A new address: every screen on the old one is let go at once, and its reconnect meets the
 *  "open the address" page. */
export async function newDisplayAddress(): Promise<DisplayStatus> {
  await newDisplayToken();
  displayServer.closeScreens();
  return syncDisplay();
}
