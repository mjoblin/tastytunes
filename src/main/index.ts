import { app, BrowserWindow, globalShortcut, ipcMain, powerMonitor, screen, shell } from 'electron'
import { join } from 'node:path'
import { IPC, type AppSettings, type SleepTimer, type StreamerCommand } from '@shared/ipc'
import { DeviceManager } from './deviceManager'
import { getSettings, updateSettings } from './persist'

// Pin the identity and settings location: when Electron is launched with a
// bare file path (dev harnesses), it doesn't read package.json and userData
// would silently default to ".../Electron". TASTYTUNES_USER_DATA lets test
// harnesses run isolated (own settings, own single-instance lock).
app.setName('tastytunes')
app.setPath(
  'userData',
  process.env['TASTYTUNES_USER_DATA'] ?? join(app.getPath('appData'), 'tastytunes')
)

const deviceManager = new DeviceManager()
let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null

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
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('focus', () => deviceManager.healthCheck())

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

function registerIpc(): void {
  ipcMain.handle(IPC.getSnapshot, () => deviceManager.snapshot())
  ipcMain.handle(IPC.discover, () => deviceManager.discover())
  ipcMain.handle(IPC.connect, (_e, host: string) => deviceManager.connect(host))
  ipcMain.handle(IPC.disconnect, () => deviceManager.disconnect())
  ipcMain.handle(IPC.command, (_e, cmd: StreamerCommand) => deviceManager.command(cmd))
  ipcMain.handle(IPC.getSettings, () => getSettings())
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => {
    const next = updateSettings(patch)
    syncMediaKeys()
    return next
  })
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:/i.test(url)) return shell.openExternal(url)
    return Promise.resolve()
  })
  ipcMain.handle(IPC.setSleep, (_e, sleep: SleepTimer | null) => deviceManager.setSleep(sleep))
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
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerIpc()
    createWindow()
    syncMediaKeys()
    void deviceManager.startup()

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
    deviceManager.shutdown()
  })
}
