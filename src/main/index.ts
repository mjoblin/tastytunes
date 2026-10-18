// app/boot runs first: the tt-art scheme, the log-pipe guard, the app's name and userData,
// and the navigation guard, before any other module of main is evaluated.
import "./app/boot";
import { app, globalShortcut, powerMonitor } from "electron";
import { IPC } from "@shared/ipc";
import { serveArtProtocol } from "./app/artProtocol";
import { denyPermissionsByDefault } from "./app/permissions";
import { broadcastSettings, wireListeningPushes } from "./app/broadcast";
import { syncMediaKeys } from "./app/mediaKeys";
import { installAppMenu } from "./app/menu";
import { deviceManager, mcpBridge } from "./app/runtime";
import { catchUpOnResume, noteSuspend, startScheduler } from "./app/scheduler";
import { hasTray, refreshTrayMenu, syncTray, trayWantsRefresh } from "./app/tray";
import { startUpdater } from "./app/updater";
import { serveUrlActions } from "./app/urlActions";
import { takeUrlFromArgv } from "./app/urlInbox";
import {
  createWindow,
  focusMain,
  getMainWindow,
  markQuitting,
  menuDeps,
  quitting,
  sendMenuCommand,
  showMainWindow,
  trayDeps,
} from "./app/windows";
import { getSettings } from "./data/persist";
import { listeningRecord } from "./data/listeningRecord";
import { registerIpc } from "./ipc";
import { flushArtThumbs } from "./lookups/artThumbs";
import { flushLookupCaches } from "./lookups/diskCache";
import * as mediaIndex from "./media/mediaIndex";
import { deviceLaneReset, refreshServers } from "./media/upnpBrowser";
import { stopDemoStreamer } from "./servers/demoStreamer";

// The main process's lifecycle: the single-instance lock, startup in whenReady, the device's
// pushes that main itself acts on, sleep and wake, and quitting. The windows live in
// app/windows, the handlers in ipc/, the services in app/runtime (the 0.11.0 sweep split
// this file, 975 lines, by those seams).

wireListeningPushes();

// MCP tools can mutate settings (schedules) — the renderer must hear about it
mcpBridge.onSettingsMutated = (settings) => broadcastSettings(settings);
mcpBridge.sendCommand = (command) => sendMenuCommand(command);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // A tastytunes:// URL on Windows and Linux arrives as a second launch: its verb decides
    // whether a window shows (app/urlActions), so a key press does not pull the app forward.
    if (takeUrlFromArgv(argv)) return;
    // A second launch means "show me the app" — recreate the window if the
    // first instance is running window-less (macOS after close).
    const mainWindow = getMainWindow();
    if (!mainWindow) return createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    focusMain();
  });

  app
    .whenReady()
    .then(() => {
      denyPermissionsByDefault();
      serveArtProtocol();
      registerIpc();
      installAppMenu(menuDeps);
      createWindow();
      syncMediaKeys();
      syncTray(getSettings().tray, trayDeps);
      // THE HEAL AHEAD (0.10.0): the USB index heals on its own a few seconds after the
      // streamer wakes, or after connecting to one already awake (see
      // mediaIndex.healAhead); a standby or a lost connection cancels what was scheduled.
      // The connection and the first power push arrive in either order, so each checks the other.
      let aheadHost: string | null = null;
      let lastPower: string | null = null;
      // The tray's menu is a native snapshot the OS holds — it can't read state
      // on open the way the renderer does, so device movement has to push it.
      deviceManager.onPush = (msg) => {
        if (msg.kind === "connection") {
          const was = aheadHost;
          aheadHost = msg.state.phase === "connected" ? msg.state.host : null;
          if (!aheadHost) {
            lastPower = null;
            mediaIndex.cancelHealAhead();
          } else if (!was && lastPower === "ON") mediaIndex.scheduleHealAhead(aheadHost);
        }
        if (msg.kind === "systemPower") {
          const was = lastPower;
          lastPower = msg.data.power ?? null;
          if (lastPower !== "ON") mediaIndex.cancelHealAhead();
          else if (was !== "ON" && aheadHost) mediaIndex.scheduleHealAhead(aheadHost);
        }
        if (trayWantsRefresh(msg.kind)) refreshTrayMenu();
        // INDEX AT CONNECT (2026-09-02, user call): the media indexes used to
        // build only when the Library screen first listed servers, so on a
        // fresh install the Queue's album links and Open in Library could "not
        // find" an album the app had simply never looked for. The same
        // fire-and-forget freshness pass now runs the moment a streamer
        // connects; ensureFresh is idempotent (fresh indexes are skipped, the
        // auto toggle is honoured) and the Library's own listing still re-runs
        // it. Completion off-screen is what the indexing toast reports.
        if (msg.kind === "connection" && msg.state.phase === "connected") {
          const host = msg.state.host;
          // the device announced itself: its media server's cool-off ends and the
          // listing memo drops, so this session's first listing is a fresh one
          deviceLaneReset();
          void refreshServers(host)
            .then((servers) => mediaIndex.ensureFresh(host, servers))
            .catch(() => {});
        }
      };
      mcpBridge.sync(getSettings());
      void deviceManager.startup();
      // tastytunes:// URLs, those that arrived before ready first (app/urlInbox)
      serveUrlActions();
      startScheduler(deviceManager);
      mediaIndex.init((statuses) => deviceManager.setMediaIndex(statuses));
      startUpdater((state) => {
        getMainWindow()?.webContents.send(IPC.push, { kind: "updateState", state });
      });

      // Node timers stall during system sleep. The sleep timer fires what came
      // due; the SCHEDULER offers it instead (an alarm minutes late is a
      // question, not an instruction) — see scheduler.ts for the three rules.
      powerMonitor.on("suspend", () => noteSuspend());
      powerMonitor.on("resume", () => {
        deviceManager.healthCheck();
        deviceManager.checkSleepTimer();
        catchUpOnResume(deviceManager);
      });

      // Dock-icon click. Asking for the MAIN window rather than "are there zero
      // windows" matters now that a hidden tray panel can be the only window
      // there is — counting windows would make the dock icon do nothing.
      app.on("activate", () => showMainWindow());
    })
    .catch((e: unknown) => {
      // a failure anywhere in startup used to vanish (floating promise)
      console.error("startup failed:", e);
    });

  app.on("before-quit", () => {
    markQuitting();
  });

  app.on("window-all-closed", () => {
    if (quitting()) return;
    // A tray icon is a promise that the app is still reachable, so closing the
    // last window stops being a quit while one exists. Without a tray the old
    // rule stands exactly as it was — an app that can't be quit by closing it
    // and shows nothing anywhere is the thing to never ship. (The notice that
    // goes with this lives on the main window's 'closed'; see the note there.)
    if (hasTray()) return;
    if (process.platform !== "darwin") app.quit();
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    mcpBridge.stop();
    deviceManager.shutdown();
    stopDemoStreamer();
    flushLookupCaches();
    flushArtThumbs();
    // Quitting mid-track: the open play's accumulated time reaches the
    // record (synchronous append; see listeningRecord).
    listeningRecord.flush();
  });
  // A TERMINATION SIGNAL IS A QUIT (2026-09-15): a dev restart or a kill ends the process
  // without will-quit, and whatever the caches had not yet written was lost — an AirPlay
  // cover captured seconds before the restart among it. Turn the signal into the ordinary
  // quit so the same flushes run; a second signal while quitting is left to the OS.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (quitting()) return;
      app.quit();
    });
  }
}
