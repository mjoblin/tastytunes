import { Notification } from "electron";
import type { AppSettings, UpdateState } from "@shared/model";

// ONE NOTICE PER VERSION, FOR SOMEONE WHO WON'T SEE THE WINDOW (0.16.0). The nav's Update button
// and the menu bar or tray menu's item say a version is available to anyone who looks; someone
// running TastyTunes from the menu bar or tray (opened at login, the window never shown) looks at
// neither. So when an offered version is found while no window is in view, the system announces it
// once, silently, and a click opens Settings › Updates. Never a second time for the same version,
// never while the window is up, never with automatic checks off; the system's own notification
// settings are the other off switch.

/** Whether this state is a version worth announcing now. */
export function shouldAnnounce(
  state: UpdateState,
  settings: Pick<AppSettings, "updateCheck" | "updateNotified">,
  windowInView: boolean,
): boolean {
  return (
    state.phase === "available" &&
    state.version != null &&
    settings.updateCheck &&
    settings.updateNotified !== state.version &&
    !windowInView
  );
}

/** Announce the version through the system, once; the caller records it as announced. */
export function announceUpdate(version: string, onClick: () => void): boolean {
  if (!Notification.isSupported()) return false;
  const notice = new Notification({
    title: `TastyTunes ${version} is available`,
    body: "Click to see what's new and update.",
    silent: true,
  });
  notice.on("click", onClick);
  notice.show();
  return true;
}
