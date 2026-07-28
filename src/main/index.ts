import { app, BrowserWindow, globalShortcut, ipcMain, powerMonitor, screen, shell } from 'electron'
import { join } from 'node:path'
import { IPC, type MenuCommand, type StreamerCommand } from '@shared/ipc'
import { type AppSettings, type LyricsQuery, type MediaQueueAction, type SleepTimer } from '@shared/model'
import {
  type ContentRef,
  type Playlist,
  type PlaylistItem,
  type Favorite,
  type RecentTrack
} from '@shared/model'
import { DeviceManager } from './device/deviceManager'
import { demoHost, startDemoStreamer, stopDemoStreamer } from './servers/demoStreamer'
import { McpBridge } from './servers/mcpServer'
import { installAppMenu } from './app/menu'
import { hasTray, noteClosedToTray, refreshTrayMenu, syncTray, trayWantsRefresh } from './app/tray'
import * as mediaIndex from './media/mediaIndex'
import {
  checkUpdatesNow,
  checkUpdatesOnDemand,
  currentUpdateState,
  downloadUpdate,
  installUpdate,
  startUpdater
} from './app/updater'
import { fetchLyrics } from './lookups/lyrics'
import { scrobbler } from './lookups/scrobbler'
import { fetchArtistInfo } from './lookups/artistInfo'
import { fetchAlbumInfo } from './lookups/albumInfo'
import { radioByTags, radioSearch, radioTop } from './lookups/radioBrowser'
import { clearLookupCaches, flushLookupCaches, lookupCacheStats } from './lookups/diskCache'
import { browse as mediaBrowse, presetSave, queueAdd, refreshServers } from './media/upnpBrowser'
import {
  catchUpOnResume,
  dismissMissedSchedule,
  noteSuspend,
  runMissedSchedule,
  startScheduler
} from './app/scheduler'
import { loggedFetch } from './netlog'
import { getSettings, updateSettings } from './data/persist'
import { getRecents } from './data/recents'

// Pin the identity and settings location: when Electron is launched with a
// bare file path (dev harnesses), it doesn't read package.json and userData
// would silently default to ".../Electron". TASTYTUNES_USER_DATA lets test
// harnesses run isolated (own settings, own single-instance lock).
// Display casing: app.name feeds menu role labels ("Hide/Quit TastyTunes");
// the settings path stays lowercase via the explicit setPath below.
app.setName('TastyTunes')
app.setPath(
  'userData',
  process.env['TASTYTUNES_USER_DATA'] ?? join(app.getPath('appData'), 'tastytunes')
)

const deviceManager = new DeviceManager()
const mcpBridge = new McpBridge(deviceManager)
let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
/**
 * Every window hears a settings write — the mini player tracks the main window
 * live (display font, theme, ambient art), and an MCP-driven change (schedules)
 * reaches both. The sender re-applies the same object idempotently; the store's
 * 'settings' push just sets state.
 */
function broadcastSettings(settings: AppSettings): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.push, { kind: 'settings', settings })
  }
}

// MCP tools can mutate settings (schedules) — the renderer must hear about it
mcpBridge.onSettingsMutated = (settings) => broadcastSettings(settings)

const MIN_WIDTH = 800
const MIN_HEIGHT = 520

function createWindow(): void {
  // Reopen at the remembered size/position — but only place it if the saved
  // spot is still on a connected display (mirrors the mini-player logic), and
  // never larger than that display's work area: bounds saved on a big external
  // monitor must not reopen off the edges of a laptop screen.
  const { mainBounds } = getSettings()
  const home =
    mainBounds == null
      ? null
      : (screen.getAllDisplays().find(
          ({ workArea }) =>
            mainBounds.x >= workArea.x - 40 &&
            mainBounds.x <= workArea.x + workArea.width - 100 &&
            mainBounds.y >= workArea.y - 10 &&
            mainBounds.y <= workArea.y + workArea.height - 60
        ) ?? null)
  const { workArea } = home ?? screen.getPrimaryDisplay()
  const fit = (saved: number | undefined, fallback: number, min: number, max: number): number =>
    Math.max(min, Math.min(saved ?? fallback, max))
  mainWindow = new BrowserWindow({
    width: fit(mainBounds?.width, 1180, MIN_WIDTH, workArea.width),
    height: fit(mainBounds?.height, 780, MIN_HEIGHT, workArea.height),
    ...(home && mainBounds ? { x: mainBounds.x, y: mainBounds.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: '#0e0d0b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    // The app carries its own chrome — on Windows/Linux the menu bar stays
    // hidden until Alt reveals it (no-op on macOS).
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('focus', () => deviceManager.healthCheck())
  // Null the handle when the window closes (macOS keeps the app alive) —
  // late callers (updater announce, second-instance) otherwise poke a
  // destroyed BrowserWindow and throw.
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Remember size/position across restarts (debounced during drags; skip
  // fullscreen/maximized/minimized so we restore the last "normal" bounds).
  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  const persistBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isFullScreen() || mainWindow.isMaximized() || mainWindow.isMinimized()) return
    const { x, y, width, height } = mainWindow.getBounds()
    updateSettings({ mainBounds: { x, y, width, height } })
  }
  const scheduleSave = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(persistBounds, 400)
  }
  mainWindow.on('resize', scheduleSave)
  mainWindow.on('move', scheduleSave)
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    persistBounds()
  })

  // A window created (or reloaded) after a state change missed the push.
  mainWindow.webContents.on('did-finish-load', () => {
    const state = currentUpdateState()
    if (state.phase !== 'idle') {
      mainWindow?.webContents.send(IPC.push, { kind: 'updateState', state })
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function toggleMiniPlayer(): void {
  if (miniWindow) {
    miniWindow.close()
    return
  }
  // Only reuse the remembered position if it's still on a connected display.
  const { miniBounds } = getSettings()
  const onScreen =
    miniBounds != null &&
    screen.getAllDisplays().some(({ workArea }) => {
      return (
        miniBounds.x >= workArea.x - 40 &&
        miniBounds.x <= workArea.x + workArea.width - 100 &&
        miniBounds.y >= workArea.y - 10 &&
        miniBounds.y <= workArea.y + workArea.height - 60
      )
    })
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
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })
  try {
    miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } catch {
    // not supported everywhere; cosmetic
  }
  miniWindow.on('ready-to-show', () => miniWindow?.show())
  // 'ready-to-show' can be unreliable for transparent windows — show anyway.
  setTimeout(() => {
    if (miniWindow && !miniWindow.isDestroyed() && !miniWindow.isVisible()) miniWindow.show()
  }, 900)
  const savePosition = (): void => {
    if (!miniWindow) return
    const [x, y] = miniWindow.getPosition()
    updateSettings({ miniBounds: { x, y } })
  }
  miniWindow.on('moved', savePosition)
  miniWindow.on('close', savePosition)

  // CSS :hover doesn't fire over -webkit-app-region: drag, so track the cursor
  // from here and tell the mini renderer when it's being hovered.
  let hovered = false
  const hoverTimer = setInterval(() => {
    if (!miniWindow || miniWindow.isDestroyed()) return
    const p = screen.getCursorScreenPoint()
    const b = miniWindow.getBounds()
    const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
    if (inside !== hovered) {
      hovered = inside
      miniWindow.webContents.send(IPC.push, { kind: 'miniHover', hovered: inside })
    }
  }, 200)

  // A push sent while the renderer is still loading is lost — reset so the
  // next poll re-announces the current hover state after load.
  miniWindow.webContents.on('did-finish-load', () => {
    hovered = false
  })

  miniWindow.on('closed', () => {
    clearInterval(hoverTimer)
    miniWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void miniWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mini=1`)
  } else {
    void miniWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { mini: '1' } })
  }
}

/** Show and focus the main window, recreating it if it's been closed. */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

const trayDeps = {
  command: (cmd: StreamerCommand) => void deviceManager.command(cmd),
  snapshot: () => deviceManager.snapshot(),
  showMain: showMainWindow,
  sendToMain: (command: MenuCommand) => sendMenuCommand(command)
}

// Deliver a menu click to the main window's renderer. If the window is gone
// (closed on macOS while the app lives on), recreate it and send after load —
// the renderer subscribes to pushes at module scope, so did-finish-load is late
// enough. Menu commands never go to the mini player.
function sendMenuCommand(command: MenuCommand): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    mainWindow?.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send(IPC.push, { kind: 'menu', command })
    })
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send(IPC.push, { kind: 'menu', command })
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSnapshot, () => deviceManager.snapshot())
  ipcMain.handle(IPC.discover, () => deviceManager.discover())
  ipcMain.handle(IPC.connect, (_e, host: string) => {
    // Leaving the demo for a real device shuts the demo server down.
    if (demoHost() && host !== demoHost()) stopDemoStreamer()
    deviceManager.connect(host)
  })
  ipcMain.handle(IPC.disconnect, () => {
    deviceManager.disconnect()
    stopDemoStreamer()
  })
  ipcMain.handle(IPC.demoStart, async () => {
    const host = await startDemoStreamer()
    // remember:false — the ephemeral demo port must not be next launch's
    // reconnect target (a first run also stays "never connected").
    deviceManager.connect(host, { remember: false, demo: true })
  })
  ipcMain.handle(IPC.command, (_e, cmd: StreamerCommand) => deviceManager.command(cmd))
  ipcMain.handle(IPC.getSettings, () => getSettings())
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => {
    const next = updateSettings(patch)
    broadcastSettings(next)
    // OS-global shortcut churn only when the toggle itself changed — every
    // settings write used to unregister/re-register all four media keys.
    if ('mediaKeys' in patch) syncMediaKeys()
    // The tray comes and goes live — toggling it is not a restart.
    if ('tray' in patch) syncTray(next.tray, trayDeps)
    mcpBridge.sync(next)
    // Only when the limit itself changed — a volume set above the limit from
    // outside the app (device knob) mustn't be ambushed by unrelated saves.
    if ('volumeLimitPercent' in patch) deviceManager.enforceVolumeLimit()
    // Turning the update check on shouldn't wait up to 4 hours to matter.
    if (patch.updateCheck === true) checkUpdatesNow()
    return next
  })
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:/i.test(url)) return shell.openExternal(url)
    return Promise.resolve()
  })
  ipcMain.handle(IPC.setSleep, (_e, sleep: SleepTimer | null) => deviceManager.setSleep(sleep))
  ipcMain.handle(IPC.scheduleRunMissed, () => runMissedSchedule(deviceManager))
  ipcMain.handle(IPC.scheduleDismissMissed, () => dismissMissedSchedule(deviceManager))
  // Belt-and-braces gate: the renderer only asks while the setting is on, but
  // "off = no requests, ever" should hold even if a stale renderer asks.
  ipcMain.handle(IPC.fetchLyrics, (_e, q: LyricsQuery, force?: boolean) =>
    getSettings().lyrics ? fetchLyrics(q, !!force) : null
  )
  ipcMain.handle(IPC.lbValidate, () => scrobbler.validateToken())
  ipcMain.handle(IPC.updateDownload, () => downloadUpdate())
  ipcMain.handle(IPC.updateInstall, () => installUpdate())
  ipcMain.handle(IPC.updateCheckNow, () => checkUpdatesOnDemand())
  ipcMain.handle(IPC.fetchArtistInfo, (_e, artist: string, force?: boolean) =>
    getSettings().artistInfo ? fetchArtistInfo(artist, !!force) : null
  )
  ipcMain.handle(IPC.fetchAlbumInfo, (_e, artist: string, album: string, force?: boolean) =>
    getSettings().artistInfo ? fetchAlbumInfo(artist, album, !!force) : null
  )
  ipcMain.handle(IPC.getRecents, () => getRecents())
  ipcMain.handle(IPC.clearRecents, () => deviceManager.clearRecents())
  ipcMain.handle(IPC.recentsRestore, (_e, list: RecentTrack[]) => deviceManager.recentsRestore(list))
  ipcMain.handle(IPC.favoriteAdd, (_e, fav: Favorite) => deviceManager.favoriteAdd(fav))
  ipcMain.handle(IPC.favoriteRemove, (_e, key: string) => deviceManager.favoriteRemove(key))
  ipcMain.handle(IPC.favoriteUpdate, (_e, key: string, patch: Partial<Favorite>) =>
    deviceManager.favoriteUpdate(key, patch)
  )
  ipcMain.handle(IPC.playlistCreate, (_e, name: string, items: PlaylistItem[]) =>
    deviceManager.playlistCreate(name, items)
  )
  ipcMain.handle(IPC.playlistRename, (_e, id: string, name: string) =>
    deviceManager.playlistRename(id, name)
  )
  ipcMain.handle(IPC.playlistDelete, (_e, id: string) => deviceManager.playlistDelete(id))
  ipcMain.handle(IPC.playlistRestore, (_e, playlist: Playlist) =>
    deviceManager.playlistRestore(playlist)
  )
  ipcMain.handle(IPC.queueRestore, (_e, ref: ContentRef, position: number) =>
    deviceManager.queueRestore(ref, position)
  )
  ipcMain.handle(IPC.playlistSetItems, (_e, id: string, items: PlaylistItem[]) =>
    deviceManager.playlistSetItems(id, items)
  )
  ipcMain.handle(IPC.playlistAppend, (_e, id: string, items: PlaylistItem[]) =>
    deviceManager.playlistAppend(id, items)
  )
  ipcMain.handle(IPC.playlistActivate, (_e, id: string) => deviceManager.playlistActivate(id))
  ipcMain.handle(IPC.playlistActivateCancel, () => deviceManager.cancelPlaylistActivation())
  ipcMain.handle(IPC.lookupCacheStats, () => lookupCacheStats())
  ipcMain.handle(IPC.clearLookupCaches, () => clearLookupCaches())

  // Media browser — every call needs the connected streamer's host.
  const streamerHost = (): string => {
    const conn = deviceManager.snapshot().connection
    if (conn.phase !== 'connected') throw new Error('not connected to a streamer')
    return conn.host
  }
  ipcMain.handle(IPC.mediaServers, async () => {
    const servers = await refreshServers(streamerHost())
    // Fire-and-forget freshness: Tier A indexes build/rebuild in the
    // background whenever the Library lists servers; statuses push as they go.
    mediaIndex.ensureFresh(streamerHost(), servers)
    return servers
  })
  ipcMain.handle(IPC.mediaIndexRebuild, async (_e, serverUdn: string) => {
    const servers = await refreshServers(streamerHost())
    const server = servers.find((x) => x.udn === serverUdn)
    if (server) await mediaIndex.rebuild(streamerHost(), server)
  })
  ipcMain.handle(IPC.mediaBrowse, (_e, serverUdn: string, objectId: string | null, titlePath: string[]) =>
    mediaBrowse(streamerHost(), serverUdn, objectId, titlePath)
  )
  ipcMain.handle(IPC.mediaSearch, (_e, serverUdn: string, query: string) =>
    // Index-first: a fresh local index answers instantly; live search covers
    // the rest (building, Tier C, or no index yet).
    mediaIndex.searchServer(streamerHost(), serverUdn, query)
  )
  ipcMain.handle(IPC.mediaSearchAll, (_e, query: string) => mediaIndex.searchAllIndexes(query))
  ipcMain.handle(IPC.mediaIndexPools, () => mediaIndex.pools())
  ipcMain.handle(
    IPC.mediaQueueAdd,
    async (_e, serverUdn: string, objectId: string, action: MediaQueueAction, playFromId?: string) => {
      // Library plays are wake intents too — queue writes to a standby
      // streamer would otherwise land on deaf ears (probed 2026-07-23).
      await deviceManager.ensureAwake()
      return queueAdd(streamerHost(), serverUdn, objectId, action, playFromId)
    }
  )
  ipcMain.handle(IPC.radioSearch, (_e, query: string) => radioSearch(query))
  ipcMain.handle(IPC.radioTop, () => radioTop())
  ipcMain.handle(IPC.radioByTags, (_e, tags: string[]) => radioByTags(tags))
  ipcMain.handle(IPC.mediaPresetSave, (_e, serverUdn: string, objectId: string, slot: number) =>
    presetSave(streamerHost(), serverUdn, objectId, slot)
  )
  ipcMain.handle(IPC.contentResolve, (_e, ref: ContentRef) => deviceManager.contentResolve(ref))
  ipcMain.handle(IPC.toggleMini, () => toggleMiniPlayer())
  ipcMain.handle(IPC.showMain, () => showMainWindow())
  ipcMain.handle(IPC.fetchArt, async (_e, url: string) => {
    if (!/^https?:/i.test(url)) return null
    try {
      const res = await loggedFetch('art', url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 3_000_000) return null
      const mime = res.headers.get('content-type') ?? 'image/jpeg'
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    } catch {
      return null
    }
  })
}

function syncMediaKeys(): void {
  globalShortcut.unregisterAll()
  if (!getSettings().mediaKeys) return
  const bind = (accelerator: string, cmd: StreamerCommand): void => {
    try {
      globalShortcut.register(accelerator, () => void deviceManager.command(cmd))
    } catch {
      // Media keys can be unavailable on some platforms; not fatal.
    }
  }
  bind('MediaPlayPause', { type: 'togglePlayback' })
  bind('MediaNextTrack', { type: 'nextTrack' })
  bind('MediaPreviousTrack', { type: 'previousTrack' })
  bind('MediaStop', { type: 'stop' })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // A second launch means "show me the app" — recreate the window if the
    // first instance is running window-less (macOS after close).
    if (!mainWindow) return createWindow()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    registerIpc()
    installAppMenu({
      command: (cmd) => void deviceManager.command(cmd),
      toggleMini: toggleMiniPlayer,
      sendToMain: sendMenuCommand
    })
    createWindow()
    syncMediaKeys()
    syncTray(getSettings().tray, trayDeps)
    // The tray's menu is a native snapshot the OS holds — it can't read state
    // on open the way the renderer does, so device movement has to push it.
    deviceManager.onPush = (msg) => {
      if (trayWantsRefresh(msg.kind)) refreshTrayMenu()
    }
    mcpBridge.sync(getSettings())
    void deviceManager.startup()
    startScheduler(deviceManager)
    mediaIndex.init((statuses) => deviceManager.setMediaIndex(statuses))
    startUpdater((state) => {
      mainWindow?.webContents.send(IPC.push, { kind: 'updateState', state })
    })

    // Node timers stall during system sleep. The sleep timer fires what came
    // due; the SCHEDULER offers it instead (an alarm minutes late is a
    // question, not an instruction) — see scheduler.ts for the three rules.
    powerMonitor.on('suspend', () => noteSuspend())
    powerMonitor.on('resume', () => {
      deviceManager.healthCheck()
      deviceManager.checkSleepTimer()
      catchUpOnResume(deviceManager)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Set once the quit is genuinely under way, so the last window closing as
  // PART of a quit isn't mistaken for someone retreating to the tray.
  let isQuitting = false
  app.on('before-quit', () => {
    isQuitting = true
  })

  app.on('window-all-closed', () => {
    if (isQuitting) return
    // A tray icon is a promise that the app is still reachable, so closing the
    // last window stops being a quit while one exists. Without a tray the old
    // rule stands exactly as it was — an app that can't be quit by closing it
    // and shows nothing anywhere is the thing to never ship.
    if (hasTray()) {
      noteClosedToTray()
      return
    }
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    mcpBridge.stop()
    deviceManager.shutdown()
    stopDemoStreamer()
    flushLookupCaches()
  })
}
