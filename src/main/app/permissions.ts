import { session } from "electron";

/**
 * WHAT A PAGE MAY ASK FOR, DENIED BY DEFAULT (0.12.0-rc.2). Chromium grants a
 * page's permission requests unless the app says otherwise, so the app says: the copy buttons'
 * clipboard writes and display mode's fullscreen, nothing else (no camera, microphone, location,
 * notifications through the page, MIDI, devices). The windows load only the app's own pages, so
 * this is the backstop should anything else ever run in one. Set once, in whenReady.
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
]);

export function permitted(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

export function denyPermissionsByDefault(): void {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, permission, callback) => callback(permitted(permission)));
  s.setPermissionCheckHandler((_wc, permission) => permitted(permission));
}

/**
 * NO COOKIES, EITHER WAY (0.16.0, toward 1.0). The windows draw large pictures straight from the
 * hosts that serve them (an artist's photo, a station's logo), through the app's one persistent
 * session, and Chromium keeps a third-party cookie such a host sets and sends it back with every
 * later picture: a stable identifier for this install at a third party, beside "no analytics, no
 * telemetry". The app needs no cookie anywhere (its own services are called from main, which keeps
 * none), so none is kept: a response's Set-Cookie is dropped, a request carries no Cookie, and any
 * cookie left by an earlier version is cleared at start-up. The only webRequest handlers on the
 * session: a second registration would replace these (Electron keeps one per event).
 */
export function keepNoCookies(): void {
  const s = session.defaultSession;
  s.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders;
    if (!headers) return callback({});
    const kept = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name.toLowerCase() !== "set-cookie"),
    );
    callback({ responseHeaders: kept });
  });
  s.webRequest.onBeforeSendHeaders((details, callback) => {
    const kept = Object.fromEntries(
      Object.entries(details.requestHeaders).filter(([name]) => name.toLowerCase() !== "cookie"),
    );
    callback({ requestHeaders: kept });
  });
  void s.clearStorageData({ storages: ["cookies"] }).catch(() => {});
}
