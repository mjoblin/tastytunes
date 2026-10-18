import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { IPC, type MenuCommand, type StreamerCommand } from "@shared/ipc";
import { getSettings, updateSettings } from "../data/persist";
import { installAppMenu } from "./menu";
import { noteClosedToTray } from "./tray";
import { currentUpdateState } from "./updater";
import { homeWorkArea, isOnScreen } from "./windowPlacement";
import { deviceManager } from "./runtime";
import { reloadOnCrash } from "./crashReload";

// The main window and the mini player, and the callbacks the app menu and the tray use to
// reach them (split out of index.ts in the 0.11.0 sweep).

let mainWindow: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
/**
 * Set once a quit is genuinely under way, so windows closing as PART of the
 * quit aren't mistaken for someone retreating to the tray. Module scope
 * because both the main window's `closed` handler and `window-all-closed`
 * need it.
 */
let isQuitting = false;

/** The main window while it exists (null once closed: macOS keeps the app alive). */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** A quit is under way (before-quit). */
export function markQuitting(): void {
  isQuitting = true;
}

export function quitting(): boolean {
  return isQuitting;
}

// The Edit menu's Undo item names the undo stack's top; the renderer keeps
// this in sync and a change rebuilds the menu (labels are baked at build).
let undoMenuLabel: string | null = null;
export const menuDeps = {
  command: (cmd: StreamerCommand) => deviceManager.fire(cmd),
  toggleMini: () => toggleMiniPlayer(),
  sendToMain: (c: MenuCommand) => sendMenuCommand(c),
  undoLabel: () => undoMenuLabel,
};

/** The renderer's undo stack changed its top: rebuild the menu when the label moved. */
export function setUndoMenuLabel(label: string | null): void {
  if (label !== undoMenuLabel) {
    undoMenuLabel = label;
    installAppMenu(menuDeps);
  }
}

const MIN_WIDTH = 800;
const MIN_HEIGHT = 520;

const TEST_INACTIVE = process.env.TASTYTUNES_TEST_INACTIVE === "1";
/** Show the main window; inactive (no focus steal) under the suite's flag. */
function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (TEST_INACTIVE) mainWindow.showInactive();
  else mainWindow.show();
}
/** Focus the main window, unless the suite asked us never to take focus. */
export function focusMain(): void {
  if (TEST_INACTIVE || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.focus();
}

export function createWindow(): void {
  // Reopen at the remembered size/position — but only place it if the saved
  // spot is still on a connected display (mirrors the mini-player logic), and
  // never larger than that display's work area: bounds saved on a big external
  // monitor must not reopen off the edges of a laptop screen.
  const { mainBounds } = getSettings();
  const home =
    mainBounds == null
      ? null
      : homeWorkArea(
          mainBounds,
          screen.getAllDisplays().map((d) => d.workArea),
        );
  const workArea = home ?? screen.getPrimaryDisplay().workArea;
  const fit = (saved: number | undefined, fallback: number, min: number, max: number): number =>
    Math.max(min, Math.min(saved ?? fallback, max));
  mainWindow = new BrowserWindow({
    width: fit(mainBounds?.width, 1180, MIN_WIDTH, workArea.width),
    height: fit(mainBounds?.height, 780, MIN_HEIGHT, workArea.height),
    ...(home && mainBounds ? { x: mainBounds.x, y: mainBounds.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: "#0e0d0b",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 18 },
    // The app carries its own chrome — on Windows/Linux the menu bar stays
    // hidden until Alt reveals it (no-op on macOS).
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
    },
  });

  // TASTYTUNES_TEST_INACTIVE (2026-09-03): the verification suite drives the
  // app through CDP, which needs no OS focus. Showing the window inactive keeps
  // the user's keyboard where it was (their keystrokes used to land in the app
  // under test and corrupt the run). Blocks that need real key-window status
  // opt out and launch normally.
  mainWindow.on("ready-to-show", () => showMain());
  mainWindow.on("focus", () => deviceManager.healthCheck());
  // Null the handle when the window closes (macOS keeps the app alive) —
  // late callers (updater announce, second-instance) otherwise poke a
  // destroyed BrowserWindow and throw.
  mainWindow.on("closed", () => {
    mainWindow = null;
    // The close-to-tray notice lives HERE, not on 'window-all-closed', because
    // the tray panel is itself a BrowserWindow: once it has been opened even
    // once, a hidden panel means 'window-all-closed' never fires again and the
    // notice would silently stop existing. What it actually announces is "you
    // closed the window and the app is still running", so the honest test is
    // that nothing VISIBLE is left.
    if (isQuitting) return;
    const visible = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible());
    if (!visible) noteClosedToTray();
  });

  // Remember size/position across restarts (debounced during drags; skip
  // fullscreen/maximized/minimized so we restore the last "normal" bounds).
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isFullScreen() || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
    const { x, y, width, height } = mainWindow.getBounds();
    updateSettings({ mainBounds: { x, y, width, height } });
  };
  const scheduleSave = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(persistBounds, 400);
  };
  mainWindow.on("resize", scheduleSave);
  mainWindow.on("move", scheduleSave);
  mainWindow.on("close", () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    persistBounds();
  });

  reloadOnCrash(mainWindow, "main", (text) => deviceManager.log("warn", "app", text));

  // A window created (or reloaded) after a state change missed the push.
  mainWindow.webContents.on("did-finish-load", () => {
    const state = currentUpdateState();
    if (state.phase !== "idle") {
      mainWindow?.webContents.send(IPC.push, { kind: "updateState", state });
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

export function toggleMiniPlayer(): void {
  if (miniWindow) {
    miniWindow.close();
    return;
  }
  // Only reuse the remembered position if it's still on a connected display.
  const { miniBounds } = getSettings();
  const onScreen =
    miniBounds != null &&
    isOnScreen(
      miniBounds,
      screen.getAllDisplays().map((d) => d.workArea),
    );
  miniWindow = new BrowserWindow({
    width: 360,
    height: 132,
    ...(onScreen ? miniBounds : {}),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    // THE SAME WINDOW KIND AS THE TRAY PANEL, for the same reasons (see
    // main/app/tray.ts ensurePanel): on macOS a non-activating NSPanel that
    // is never full-screenable. It floats over full-screen apps on its own —
    // no `visibleOnFullScreen` process transform, so opening the mini no
    // longer turns the whole app into an accessory (the vanished dock icon
    // and menu bar of 2026-08-06, and the flip-back dance this function used
    // to carry); clicking its transport doesn't yank focus away from what
    // you were working in; and it can never be promoted to a full-screen
    // tile of its own. Being always VISIBLE, it is immune to the hidden-
    // window Space re-homing that made the tray panel a show-once surface.
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
    },
  });
  try {
    miniWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  } catch {
    // not supported everywhere; cosmetic
  }
  miniWindow.on("ready-to-show", () => miniWindow?.show());
  // 'ready-to-show' can be unreliable for transparent windows — show anyway.
  setTimeout(() => {
    if (miniWindow && !miniWindow.isDestroyed() && !miniWindow.isVisible()) miniWindow.show();
  }, 900);
  const savePosition = (): void => {
    if (!miniWindow) return;
    const [x, y] = miniWindow.getPosition();
    updateSettings({ miniBounds: { x, y } });
  };
  miniWindow.on("moved", savePosition);
  miniWindow.on("close", savePosition);

  // CSS :hover doesn't fire over -webkit-app-region: drag, so track the cursor
  // from here and tell the mini renderer when it's being hovered.
  let hovered = false;
  const hoverTimer = setInterval(() => {
    if (!miniWindow || miniWindow.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = miniWindow.getBounds();
    const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    if (inside !== hovered) {
      hovered = inside;
      miniWindow.webContents.send(IPC.push, { kind: "miniHover", hovered: inside });
    }
  }, 200);

  // A push sent while the renderer is still loading is lost — reset so the
  // next poll re-announces the current hover state after load.
  reloadOnCrash(miniWindow, "mini player", (text) => deviceManager.log("warn", "app", text));
  miniWindow.webContents.on("did-finish-load", () => {
    hovered = false;
  });

  miniWindow.on("closed", () => {
    clearInterval(hoverTimer);
    miniWindow = null;
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void miniWindow.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}?mini=1`);
  } else {
    void miniWindow.loadFile(join(__dirname, "../renderer/index.html"), { query: { mini: "1" } });
  }
}

/** Show and focus the main window, recreating it if it's been closed. */
export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  showMain();
  focusMain();
}

export const trayDeps = {
  command: (cmd: StreamerCommand) => deviceManager.fire(cmd),
  snapshot: () => deviceManager.snapshot(),
  showMain: showMainWindow,
  sendToMain: (command: MenuCommand) => sendMenuCommand(command),
};

// Deliver a menu click to the main window's renderer. If the window is gone
// (closed on macOS while the app lives on), recreate it and send after load —
// the renderer subscribes to pushes at module scope, so did-finish-load is late
// enough. Menu commands never go to the mini player.
export function sendMenuCommand(command: MenuCommand): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    const target = mainWindow;
    target?.webContents.once("did-finish-load", () => {
      if (!target || target.isDestroyed()) return;
      target.webContents.send(IPC.push, { kind: "menu", command });
      // AND ONCE MORE, a beat later. `did-finish-load` says the PAGE loaded,
      // not that the renderer is listening — the app wires its push handler
      // during module execution, and on a slow machine anything that delays
      // that (an emulated CPU, a cold disk) drops the only delivery on the
      // floor and the window opens on the wrong screen. Menu commands are
      // idempotent — 'go to Device' twice is 'go to Device' — so the cheap
      // repeat is strictly better than the race. Reported from a Windows VM
      // where the panel's "Connect a streamer" opened the app but not the
      // Device screen; unreproducible on faster hardware, which is itself
      // the tell.
      setTimeout(() => {
        if (target && !target.isDestroyed()) {
          target.webContents.send(IPC.push, { kind: "menu", command });
        }
      }, 400);
    });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  showMain();
  focusMain();
  mainWindow.webContents.send(IPC.push, { kind: "menu", command });
}
