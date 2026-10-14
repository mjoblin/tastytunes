import { app } from "electron";

/**
 * WHERE tastytunes:// URLS ARRIVE (0.12.0, the URL scheme). app/boot imports this module, so its
 * listeners exist before ready: macOS hands a cold start's URL to open-url before the app is
 * ready, and the running app's in open-url too; Windows and Linux hand it in argv, a cold
 * start's in process.argv and a running app's to second-instance (main/index). URLs wait here
 * until main/app/urlActions takes them in whenReady.
 *
 * THE FOCUS (probed 2026-10-13 on macOS 26 with a throwaway app registered for its own scheme):
 * whether an app handling a URL comes forward is the OPENER's choice. NSWorkspace's default and
 * `open` bring it forward, warm or cold; `open -g` and activates=false leave it where it was. A
 * Stream Deck key or a launcher should not pull the app over what the user is doing, so when a
 * URL is what brought the app forward (did-become-active lands 12 to 40 ms before open-url),
 * the verb hands the focus back: hide, then show again, which returns the focus to the app
 * the user was in and puts the windows back behind it as they were (a showInactive leaves them
 * in front). A cold start is left alone: the app was launched, so it shows.
 */

const PREFIX = "tastytunes:";
/** How long after the app became active an arriving URL counts as the reason it did. */
const STEAL_WINDOW_MS = 300;

type Handler = (url: string, stoleFocus: boolean) => void;
let handler: Handler | null = null;
const pending: Array<[string, boolean]> = [];
let active = false;
let activeSince = 0;
/** Whether the app was hidden (⌘H) while the user was elsewhere: a URL that brings it forward
 *  unhides it, and handing the focus back must leave it hidden again. */
let hiddenWhileAway = false;

app.on("did-become-active", () => {
  active = true;
  activeSince = Date.now();
});
app.on("did-resign-active", () => {
  active = false;
  // ⌘H resigns first and hides a beat later
  setTimeout(() => {
    if (!active) hiddenWhileAway = app.isHidden();
  }, 500);
});
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliver(url, active && Date.now() - activeSince < STEAL_WINDOW_MS);
});

function deliver(url: string, stoleFocus: boolean): void {
  if (handler) handler(url, stoleFocus);
  else pending.push([url, stoleFocus]);
}

/** The first tastytunes:// URL among a launch's arguments (Windows and Linux). */
export function urlFromArgv(argv: readonly string[]): string | null {
  return argv.find((a) => a.toLowerCase().startsWith(PREFIX)) ?? null;
}

/** A second launch that carries a URL delivers it and says so; its verb, not the launch,
 *  decides whether a window shows. */
export function takeUrlFromArgv(argv: readonly string[]): boolean {
  const url = urlFromArgv(argv);
  if (url) deliver(url, false);
  return url != null;
}

/** Takes the URLs: those that came before ready, a cold start's from argv, and every later one. */
export function onUrl(take: Handler): void {
  handler = take;
  for (const [url, stole] of pending.splice(0)) take(url, stole);
  const cold = urlFromArgv(process.argv);
  if (cold) take(cold, false);
}

/** Puts the focus back where it was before a URL brought the app forward (macOS; elsewhere a
 *  URL never brings the running app forward). */
export function giveFocusBack(): void {
  if (process.platform !== "darwin") return;
  const wasHidden = hiddenWhileAway;
  app.hide();
  if (!wasHidden) setTimeout(() => app.show(), 50);
}
