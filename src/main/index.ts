import { app, BrowserWindow, globalShortcut, ipcMain, powerMonitor, screen, shell } from 'electron'
import { join } from 'node:path'
import {
  IPC,
  type AppSettings,
  type Favorite,
  type LyricsQuery,
  type MediaQueueAction,
  type MenuCommand,
  type SleepTimer,
  type StreamerCommand
} from '@shared/ipc'
import { DeviceManager } from './deviceManager'
import { demoHost, startDemoStreamer, stopDemoStreamer } from './demoStreamer'
import { McpBridge } from './mcpServer'
import { installAppMenu } from './menu'
import * as mediaIndex from './mediaIndex'
import {
  checkUpdatesNow,
  checkUpdatesOnDemand,
  currentUpdateState,
  downloadUpdate,
  installUpdate,
  startUpdater
} from './updater'
import { fetchLyrics } from './lyrics'
import { scrobbler } from './scrobbler'
import { fetchArtistInfo } from './artistInfo'
import { fetchAlbumInfo } from './albumInfo'
import { radioByTags, radioSearch, radioTop } from './radioBrowser'
import { clearLookupCaches, flushLookupCaches, lookupCacheStats } from './diskCache'
import { browse as mediaBrowse, presetSave, queueAdd, refreshServers } from './upnpBrowser'
import { startScheduler } from './scheduler'
import { loggedFetch } from './netlog'
import { getSettings, updateSettings } from './persist'
import { getRecents } from './recents'

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
// MCP tools can mutate settings (schedules) — the renderer must hear about it
mcpBridge.onSettingsMutated = (settings) =>
  mainWindow?.webContents.send(IPC.push, { kind: 'settings', settings })

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 800,
    minHeight: 520,
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
    // OS-global shortcut churn only when the toggle itself changed — every
    // settings write used to unregister/re-register all four media keys.
    if ('mediaKeys' in patch) syncMediaKeys()
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
  ipcMain.handle(IPC.favoriteAdd, (_e, fav: Favorite) => deviceManager.favoriteAdd(fav))
  ipcMain.handle(IPC.favoriteRemove, (_e, key: string) => deviceManager.favoriteRemove(key))
  ipcMain.handle(IPC.favoriteUpdate, (_e, key: string, patch: Partial<Favorite>) =>
    deviceManager.favoriteUpdate(key, patch)
  )
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
  ipcMain.handle(IPC.toggleMini, () => toggleMiniPlayer())
  ipcMain.handle(IPC.showMain, () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    else {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
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
    mcpBridge.sync(getSettings())
    void deviceManager.startup()
    startScheduler(deviceManager)
    mediaIndex.init((statuses) => deviceManager.setMediaIndex(statuses))
    startUpdater((state) => {
      mainWindow?.webContents.send(IPC.push, { kind: 'updateState', state })
    })

    powerMonitor.on('resume', () => {
      deviceManager.healthCheck()
      // Node timers stall during system sleep; fire any countdown that came due.
      deviceManager.checkSleepTimer()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
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
