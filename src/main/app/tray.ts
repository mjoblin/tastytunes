import { Menu, Notification, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { NativeImage } from 'electron'
import { readFileSync } from 'node:fs'
import type { MenuCommand, PushMessage, Snapshot } from '@shared/ipc'
import type { StreamerCommand } from '@shared/ipc'
import { getSettings, updateSettings } from '../data/persist'
import trayTemplateIcon from '../../../resources/trayTemplate.png?asset'
import trayTemplateIcon2x from '../../../resources/trayTemplate@2x.png?asset'
import trayTileIcon from '../../../resources/tray.png?asset'

/**
 * The system-tray / menu-bar companion. Phase 1: an icon and a native context
 * menu — no panel. The menu is the whole feature on Linux (where `getBounds()`
 * doesn't exist, so nothing can be anchored to the icon) and it is the tier
 * that stays even once the panel lands: rare, list-shaped things that need no
 * visuals live here, and the panel takes the frequent, visual ones.
 *
 * The icon is STATIC in every state by decision. `setTitle` (text beside the
 * icon) is macOS-only and a template image can only signal through shape, so
 * one icon covers all states and the app itself is where state lives.
 *
 * KEEP `tray` AT MODULE SCOPE. A Tray held only in a local is garbage-collected
 * and the icon silently vanishes minutes later — the single most common
 * Electron tray bug, and one no test notices because everything still works
 * until the collector runs. Guarded by verify-invariants.
 */
let tray: Tray | null = null
let deps: TrayDeps | null = null
/** What the menu currently says, so a push that changes nothing rebuilds nothing. */
let rendered: string | null = null

export interface TrayDeps {
  /** Streamer commands go straight to the DeviceManager (safe no-op offline). */
  command(cmd: StreamerCommand): void
  snapshot(): Snapshot
  /** Show and focus the main window, creating it if it's gone. */
  showMain(): void
  /** Deliver a MenuCommand to the main window, creating/focusing it first. */
  sendToMain(command: MenuCommand): void
}

/**
 * Push kinds that can change what the menu says. A native menu is a snapshot —
 * `setContextMenu` copies it — so it has to be rebuilt when the device moves,
 * and Linux can't rebuild lazily on click the way `popUpContextMenu` would.
 * Everything else (position ticks, frames, logs) would rebuild it for nothing.
 */
const MENU_KINDS: ReadonlySet<PushMessage['kind']> = new Set([
  'connection',
  'sources',
  'systemPower',
  'systemInfo',
  'nowPlaying'
] as const)

/** True when this push could change the menu — the cheap test before the real one. */
export function trayWantsRefresh(kind: PushMessage['kind']): boolean {
  return tray != null && MENU_KINDS.has(kind)
}

// --------------------------------------------------------------- menu contents

type TrayAction = 'open' | 'settings' | 'about' | 'quit'

/**
 * A plain description of the menu, built before any Electron object exists.
 * It is three things at once: the value the harness asserts against (the icon
 * click itself can't be driven — Playwright cannot reach the macOS menu bar),
 * the key that decides whether a rebuild is needed, and the source the real
 * menu is compiled from. One description, so those three can never disagree.
 */
export interface TrayNode {
  id?: string
  type?: 'separator'
  label?: string
  enabled?: boolean
  checked?: boolean
  command?: StreamerCommand
  action?: TrayAction
  submenu?: TrayNode[]
}

function statusLabel(snap: Snapshot): string {
  const { connection, systemInfo, systemPower } = snap
  const name = systemInfo?.name?.trim() || null
  switch (connection.phase) {
    case 'idle':
      return 'Not connected'
    case 'connecting':
      return `Connecting to ${connection.host}…`
    case 'disconnected':
      return connection.reconnecting ? 'Reconnecting…' : 'Disconnected'
    case 'connected': {
      const who = name ?? connection.host
      // Anything other than ON is a standby of some kind; the app only ever
      // sees the device at all in NETWORK standby (eco drops off the network).
      const standby = systemPower != null && systemPower.power !== 'ON'
      return standby ? `${who} · Standby` : who
    }
  }
}

function sourcesNode(snap: Snapshot): TrayNode {
  const selectable = (snap.sources?.sources ?? []).filter((s) => s.ui_selectable)
  const current = snap.nowPlaying?.source?.id ?? null
  return {
    id: 'tray-sources',
    label: 'Source',
    enabled: selectable.length > 0,
    submenu: selectable.map((s) => ({
      id: `tray-source-${s.id}`,
      label: s.name || s.default_name || s.id,
      checked: s.id === current,
      command: { type: 'setSource', sourceId: s.id } as StreamerCommand
    }))
  }
}

/**
 * The menu, as data. Deliberately short: this tier is for the rare and
 * list-shaped. Search and library browsing are not here on purpose (typing
 * into a menu is not a thing), and the visual, frequent surfaces — queue,
 * presets, playlists, recents — are the panel's job in a later phase.
 */
export function buildTrayMenu(snap: Snapshot): TrayNode[] {
  const connected = snap.connection.phase === 'connected'
  // Only NETWORK standby is reachable, and that's exactly the case where
  // power !== 'ON' while still connected — so the label can always name the
  // action rather than making someone guess what a toggle would do.
  const inStandby = connected && snap.systemPower != null && snap.systemPower.power !== 'ON'

  return [
    { id: 'tray-status', label: statusLabel(snap), enabled: false },
    { type: 'separator' },
    { id: 'tray-open', label: 'Open TastyTunes', action: 'open' },
    { type: 'separator' },
    sourcesNode(snap),
    {
      id: 'tray-power',
      label: inStandby ? 'Wake' : 'Put in Standby',
      enabled: connected,
      command: { type: 'power', power: inStandby ? 'ON' : 'NETWORK' }
    },
    { type: 'separator' },
    { id: 'tray-settings', label: 'Settings…', action: 'settings' },
    { id: 'tray-about', label: 'About TastyTunes', action: 'about' },
    { type: 'separator' },
    { id: 'tray-quit', label: 'Quit TastyTunes', action: 'quit' }
  ]
}

function toTemplate(nodes: TrayNode[], d: TrayDeps): MenuItemConstructorOptions[] {
  return nodes.map((n) => {
    if (n.type === 'separator') return { type: 'separator' }
    const item: MenuItemConstructorOptions = {
      ...(n.id ? { id: n.id } : {}),
      label: n.label,
      ...(n.enabled === false ? { enabled: false } : {}),
      ...(n.checked != null ? { type: 'checkbox', checked: n.checked } : {})
    }
    if (n.submenu) item.submenu = toTemplate(n.submenu, d)
    if (n.command) item.click = () => d.command(n.command as StreamerCommand)
    else if (n.action) item.click = () => runAction(n.action as TrayAction, d)
    return item
  })
}

function runAction(action: TrayAction, d: TrayDeps): void {
  switch (action) {
    case 'open':
      d.showMain()
      return
    case 'settings':
      d.sendToMain({ id: 'screen', screen: 'settings' })
      return
    case 'about':
      d.sendToMain({ id: 'about' })
      return
    case 'quit':
      app.quit()
  }
}

// ------------------------------------------------------------------ the icon

function trayIcon(): NativeImage {
  // Windows and Linux get the mark on its own dark tile — a bare glyph would
  // have to pick one colour that survives both a light and a dark taskbar.
  if (process.platform !== 'darwin') return nativeImage.createFromPath(trayTileIcon)
  // macOS wants a template image (black + alpha, inverted by the OS for dark
  // menu bars). The "…Template.png plus a @2x sibling" filename convention
  // can't be used — these load through electron-vite's ?asset, which emits
  // hashed names — so the two densities are combined by hand.
  const icon = nativeImage.createFromPath(trayTemplateIcon)
  icon.addRepresentation({
    scaleFactor: 2,
    dataURL: `data:image/png;base64,${readFileSync(trayTemplateIcon2x).toString('base64')}`
  })
  icon.setTemplateImage(true)
  return icon
}

// ------------------------------------------------------------------- lifecycle

/** True while a tray icon exists — the thing that decides whether closing the
 *  last window is a quit or a retreat to the tray. */
export function hasTray(): boolean {
  return tray != null
}

/** Rebuild the context menu if what it would say has changed. */
export function refreshTrayMenu(): void {
  if (!tray || !deps) return
  const nodes = buildTrayMenu(deps.snapshot())
  const signature = JSON.stringify(nodes)
  if (signature === rendered) return
  rendered = signature
  tray.setContextMenu(Menu.buildFromTemplate(toTemplate(nodes, deps)))
}

/**
 * Create or destroy the tray to match the setting. Live in both directions —
 * toggling it is not a restart.
 */
export function syncTray(enabled: boolean, next: TrayDeps): void {
  deps = next
  if (enabled === (tray != null)) {
    if (enabled) refreshTrayMenu()
    return
  }
  if (!enabled) {
    tray?.destroy()
    tray = null
    rendered = null
    return
  }
  tray = new Tray(trayIcon())
  tray.setToolTip('TastyTunes')
  // Phase 1 is menu-only, so the menu is set rather than popped up on click:
  // `popUpContextMenu` doesn't exist on Linux, and a left-click opens a set
  // menu on every platform. When the panel lands, left-click becomes its
  // toggle and this menu moves to right-click on macOS/Windows.
  refreshTrayMenu()
  installTestHooks()
}

/**
 * The one-shot "we're still here" notice, fired when the last window closes
 * while the tray keeps the app alive. Windows and Linux only: on macOS the app
 * has always outlived its windows, so saying so would be a notification about
 * something that didn't change.
 */
export function noteClosedToTray(): void {
  if (!tray || process.platform === 'darwin') return
  if (getSettings().trayCloseNoticeShown) return
  updateSettings({ trayCloseNoticeShown: true })
  if (!Notification.isSupported()) return
  new Notification({
    title: 'TastyTunes is still running',
    body: 'It lives in the system tray — open it or quit from there.',
    silent: true
  }).show()
}

// ------------------------------------------------------------------ test hooks

/**
 * The icon click is the one input no harness can drive: Playwright cannot
 * reach the macOS menu bar. So the menu's contents and every one of its
 * handlers are exposed under TASTYTUNES_TRAY_TEST=1, reachable from
 * `electronApp.evaluate`. Deliberately NOT an ipcMain channel — nothing in a
 * renderer should be able to quit the app or drive the device by menu id.
 */
declare global {
  // eslint-disable-next-line no-var
  var __ttTray:
    | {
        present(): boolean
        menu(): TrayNode[] | null
        click(id: string): boolean
        icon(): { empty: boolean; width: number; height: number; px1: number; px2: number; template: boolean }
      }
    | undefined
}

function findNode(nodes: TrayNode[], id: string): TrayNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    const hit = n.submenu ? findNode(n.submenu, id) : null
    if (hit) return hit
  }
  return null
}

function installTestHooks(): void {
  if (process.env['TASTYTUNES_TRAY_TEST'] !== '1' || globalThis.__ttTray) return
  globalThis.__ttTray = {
    present: () => tray != null,
    menu: () => (tray && deps ? buildTrayMenu(deps.snapshot()) : null),
    click(id: string): boolean {
      if (!tray || !deps) return false
      const node = findNode(buildTrayMenu(deps.snapshot()), id)
      if (!node || node.enabled === false) return false
      if (node.command) deps.command(node.command)
      else if (node.action) runAction(node.action, deps)
      else return false
      return true
    },
    // How the icon LOOKS is eyeball work, but whether it loaded at all is not:
    // ?asset compiles to a path, so a moved file or an unpackaged resources/
    // yields a silently empty image and a menu bar with a gap in it.
    icon() {
      const img = trayIcon()
      const { width, height } = img.getSize()
      // Bitmap byte counts, not getScaleFactors(): Cocoa SYNTHESISES a 2x rep
      // on createFromPath, so the scale-factor list says [1,2] even when only
      // the 16px art exists and reads [1,2,2] once the real one is added. The
      // pixel count is the honest test that the 32px file is in there.
      return {
        empty: img.isEmpty(),
        width,
        height,
        px1: img.toBitmap({ scaleFactor: 1 }).length,
        px2: img.toBitmap({ scaleFactor: 2 }).length,
        template: img.isTemplateImage()
      }
    }
  }
}
