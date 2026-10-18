import { session } from "electron";

/**
 * WHAT A PAGE MAY ASK FOR, DENIED BY DEFAULT (0.12.0-rc.2, the 0.11 re-score). Chromium grants a
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
