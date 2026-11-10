// OPEN AT LOGIN (0.16.0, Settings › Behavior): the system's own login item, on macOS and Windows.
// The system is the record, not settings.json: Windows' Task Manager and macOS's Login Items can
// turn it off behind the app's back, so the switch reads it every time it is shown. Registered from
// an installed build only (a dev run's Electron binary must never become someone's login item).
// Linux has no Electron call for it (an autostart file, and an AppImage's path moves with each
// version), so the row is not offered there. A launch at login starts in the tray, with no window,
// when the menu bar icon is on: the state closing the window already leaves. With no icon to reach
// the app by, the window opens as it always has.
import { app } from "electron";
import type { LoginItemState } from "@shared/ipc";

/** Marks a launch by the Windows login item (its argument); macOS says so itself. */
export const LOGIN_ARG = "--opened-at-login";

/** The suite's stand-in for the system's login item: no test touches the real one. */
const TEST = process.env["TASTYTUNES_LOGIN_ITEM_TEST"] === "1";
let testOn = false;

const offered = (): boolean => process.platform === "darwin" || process.platform === "win32";

/** Whether the app opens at login, read from the system. */
export function loginItemState(): LoginItemState {
  if (TEST) return { available: "yes", on: testOn, needsApproval: false };
  if (!offered()) return { available: "no", on: false, needsApproval: false };
  if (!app.isPackaged) return { available: "installed-only", on: false, needsApproval: false };
  if (process.platform === "win32") {
    // openAtLogin matches the item's argument; executableWillLaunchAtLogin is false once
    // Task Manager has turned it off
    const s = app.getLoginItemSettings({ args: [LOGIN_ARG] });
    return {
      available: "yes",
      on: s.openAtLogin && s.executableWillLaunchAtLogin,
      needsApproval: false,
    };
  }
  // macOS 13 and later: an item the user has not allowed yet waits in System Settings
  const s = app.getLoginItemSettings();
  const needsApproval = s.status === "requires-approval";
  return {
    available: "yes",
    on: s.openAtLogin || s.status === "enabled" || needsApproval,
    needsApproval,
  };
}

/** Turns opening at login on or off, and says where it landed. */
export function setOpenAtLogin(on: boolean): LoginItemState {
  if (TEST) {
    testOn = on;
    return loginItemState();
  }
  if (!offered() || !app.isPackaged) return loginItemState();
  if (process.platform === "win32") {
    // enabled: true also turns it back on where Task Manager had turned it off
    app.setLoginItemSettings({ openAtLogin: on, args: [LOGIN_ARG], enabled: true });
  } else {
    app.setLoginItemSettings({ openAtLogin: on });
  }
  return loginItemState();
}

/** Whether this launch came from the login item. */
export function openedAtLogin(argv: readonly string[] = process.argv): boolean {
  if (argv.includes(LOGIN_ARG)) return true;
  return (
    process.platform === "darwin" && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin
  );
}

/** A launch at login opens no window when the menu bar icon is there to reach the app by. */
export function startsInTray(atLogin: boolean, tray: boolean): boolean {
  return atLogin && tray;
}
