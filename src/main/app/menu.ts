import { app, Menu, shell, type MenuItemConstructorOptions } from "electron";
import type { MenuCommand, StreamerCommand } from "@shared/ipc";
import { REPO_URL } from "@shared/ipc";

export interface MenuDeps {
  /** Streamer commands go straight to the DeviceManager (safe no-op offline). */
  command(cmd: StreamerCommand): void;
  toggleMini(): void;
  /** Deliver a MenuCommand to the main window, creating/focusing it first. */
  sendToMain(command: MenuCommand): void;
}

// Item ids exist for the test harness (Menu.getMenuItemById().click()).
// No accelerators on transport/typing-adjacent items: keys like Space, F and
// the arrows belong to the renderer, which can tell inputs from shortcuts —
// a menu accelerator would steal them app-wide. The renderer's shortcut set
// is documented in the shortcuts overlay; the menu is the discoverable mirror.
export function installAppMenu(deps: MenuDeps): void {
  const isMac = process.platform === "darwin";

  const settingsItem: MenuItemConstructorOptions = {
    id: "menu-settings",
    label: isMac ? "Settings…" : "Settings",
    accelerator: "CmdOrCtrl+,",
    click: () => deps.sendToMain({ id: "screen", screen: "settings" }),
  };

  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      {
        id: "menu-about",
        label: "About TastyTunes",
        click: () => deps.sendToMain({ id: "about" }),
      },
      { type: "separator" },
      settingsItem,
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [settingsItem, { type: "separator" }, { role: "quit" }],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const playbackMenu: MenuItemConstructorOptions = {
    label: "Playback",
    submenu: [
      {
        id: "menu-play-pause",
        label: "Play / Pause",
        click: () => deps.command({ type: "togglePlayback" }),
      },
      { id: "menu-next", label: "Next Track", click: () => deps.command({ type: "nextTrack" }) },
      {
        id: "menu-prev",
        label: "Previous Track",
        click: () => deps.command({ type: "previousTrack" }),
      },
      { type: "separator" },
      {
        id: "menu-vol-up",
        label: "Volume Up",
        click: () => deps.command({ type: "volumeStepChange", delta: 1 }),
      },
      {
        id: "menu-vol-down",
        label: "Volume Down",
        click: () => deps.command({ type: "volumeStepChange", delta: -1 }),
      },
      { type: "separator" },
      {
        id: "menu-power",
        label: "Power On / Standby",
        click: () => deps.command({ type: "power", power: "toggle" }),
      },
    ],
  };

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { id: "menu-mini", label: "Mini Player", click: () => deps.toggleMini() },
    {
      id: "menu-display",
      // "Full-Screen Now Playing", not the in-app "display mode" name: this
      // sits two rows above the native "Toggle Full Screen" role, and two
      // items that both say full screen/fullscreen-ish need labels that say
      // WHICH full screen (user, 2026-08-06). The app keeps calling the
      // feature display mode; menus describe.
      label: "Full-Screen Now Playing",
      // NO ACCELERATOR, ON ANY PLATFORM. The renderer owns F. This item once
      // carried `accelerator: 'F', registerAccelerator: false` on macOS to
      // DISPLAY the key (2026-08-06) — but registerAccelerator is Linux/Windows
      // only (Electron docs; on macOS the Cocoa menu controller sets the key
      // equivalent unconditionally), so a bare F fired this command AND the
      // renderer's handler: display mode toggled on and straight back off,
      // and the window flashed into full screen and out (user report,
      // 2026-08-15). A menu key equivalent on macOS is always live — there is
      // no display-only mode — so the hint is not shown here.
      click: () => deps.sendToMain({ id: "displayMode" }),
    },
    {
      id: "menu-toggle-nav",
      label: "Toggle Sidebar",
      click: () => deps.sendToMain({ id: "toggleNav" }),
    },
    { type: "separator" },
    // Back / Forward walk the app's ONE navigation history (store: NavEntry).
    // macOS: ⌘[ / ⌘] are LIVE here — the menu owns them and the renderer owns
    // ⌘←/→, two routes that never overlap. Windows/Linux: the native back/
    // forward keys are Alt+←/→, which the renderer already owns, so the items
    // only DISPLAY them — registerAccelerator: false is honoured on those
    // platforms (not on macOS, see the display-mode note above).
    {
      id: "menu-back",
      label: "Back",
      accelerator: isMac ? "Cmd+[" : "Alt+Left",
      ...(isMac ? {} : { registerAccelerator: false }),
      click: () => deps.sendToMain({ id: "navBack" }),
    },
    {
      id: "menu-forward",
      label: "Forward",
      accelerator: isMac ? "Cmd+]" : "Alt+Right",
      ...(isMac ? {} : { registerAccelerator: false }),
      click: () => deps.sendToMain({ id: "navForward" }),
    },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  if (!app.isPackaged) {
    viewSubmenu.push(
      { type: "separator" },
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
    );
  }
  const viewMenu: MenuItemConstructorOptions = { label: "View", submenu: viewSubmenu };

  const screens: Array<[string, string]> = [
    ["now-playing", "Now Playing"],
    ["queue", "Queue"],
    ["search", "Search"],
    ["presets", "Presets"],
    ["library", "Library"],
    ["recently-played", "Recently Played"],
    ["device", "Device"],
  ];
  const goMenu: MenuItemConstructorOptions = {
    label: "Go",
    submenu: [
      {
        id: "menu-palette",
        label: "Command Palette…",
        accelerator: "CmdOrCtrl+K",
        click: () => deps.sendToMain({ id: "palette" }),
      },
      { type: "separator" },
      ...screens.map(([screen, label]): MenuItemConstructorOptions => ({
        id: `menu-screen-${screen}`,
        label,
        click: () => deps.sendToMain({ id: "screen", screen }),
      })),
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: "help",
    submenu: [
      {
        id: "menu-shortcuts",
        label: "Keyboard Shortcuts",
        click: () => deps.sendToMain({ id: "shortcuts" }),
      },
      { type: "separator" },
      {
        id: "menu-github",
        label: "TastyTunes on GitHub",
        click: () => void shell.openExternal(REPO_URL),
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu] : [fileMenu]),
    editMenu,
    playbackMenu,
    viewMenu,
    goMenu,
    ...(isMac ? [{ role: "windowMenu" } as MenuItemConstructorOptions] : []),
    helpMenu,
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
