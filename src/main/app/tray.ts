import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  nativeImage,
  screen,
  type MenuItemConstructorOptions
} from 'electron'
import type { NativeImage } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, type MenuCommand, type PushMessage, type Snapshot } from '@shared/ipc'
import type { StreamerCommand } from '@shared/ipc'
import { getSettings, updateSettings } from '../data/persist'
import { anchorToTray, workAreaFor, type Rect } from './windowPlacement'
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
/** Held rather than attached where a left-click belongs to the panel instead. */
let contextMenu: Menu | null = null

/**
 * Whether this platform can have a panel at all.
 *
 * `tray.getBounds()` and `right-click` are macOS + Windows only. Without
 * bounds there is nothing to anchor a panel to, and without a right-click
 * event there is nowhere to move the menu to — so Linux keeps the phase-1
 * arrangement (menu attached to the icon, opens on activation) and never
 * builds a panel. A half-placed panel floating in the middle of a Linux
 * desktop is worse than no panel; a complete context menu is not a
 * consolation prize.
 */
const HAS_PANEL = process.platform === 'darwin' || process.platform === 'win32'

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

// -------------------------------------------------------------------- the panel

/**
 * The anchored now-playing panel. Transient by nature: it opens under the
 * icon, it dismisses on blur, you never place it. That is the whole difference
 * from the mini player, which is persistent and placed — position it once and
 * leave it. Keeping them different in KIND is what makes both defensible, so
 * a tray click must never just toggle the mini.
 *
 * LINUX HAS NO PANEL. `tray.getBounds()` is macOS + Windows only, so there is
 * nothing to anchor against; Linux gets the context menu on click and that is
 * its complete, honest story.
 */
let panel: BrowserWindow | null = null
/**
 * Panel size in DIPs: header ~126 · tab strip ~48 · body ~342 · footer 36.
 *
 * The design's 560, arrived at from the other direction. Its header estimate
 * (~180) came in at ~126, but its ROW estimate was optimistic in the opposite
 * direction: the app's floating row is 40px of art plus padding, ~56px, not
 * the ~33px that "7 rows vs 9" implies. Shrinking the row was never an option
 * — that anatomy is law, and the panel is swept for it. So the number the
 * design picked to stop Queue feeling cramped is the number that does it.
 */
const PANEL_SIZE = { width: 380, height: 560 }

/**
 * Set while the panel is hiding, and for a beat afterwards.
 *
 * THE BUG THIS EXISTS FOR: clicking the tray icon while the panel is open
 * fires BOTH a blur (panel loses focus) and a tray click — and in the opposite
 * ORDER on macOS vs Windows. Naively, blur hides it and the click then re-opens
 * it, so clicking to dismiss appears to do nothing. The window swallows the
 * click that immediately follows a hide.
 */
let hidingUntil = 0
const CLICK_SWALLOW_MS = 250

/**
 * When the panel was last shown. A blur that lands within a breath of the show
 * is not a dismissal — the app may not have been frontmost when the icon was
 * clicked, in which case macOS declines the focus and delivers a blur
 * immediately, and the panel would flash open and shut. Below deliberate-click
 * latency, so a real click-away still dismisses. (On macOS the panel is now a
 * non-activating NSPanel and no longer asks for app focus at all, so the case
 * that bred this guard is mostly Windows'; it stays, because it is cheap and
 * the show/blur race is not something either OS promises to keep still.)
 */
let shownAt = 0
const SETTLE_MS = 200

/**
 * Whether the panel is currently WANTED on screen, as opposed to merely having
 * been asked for at some point.
 *
 * Every deferred show has to consult this. The retry below fires 900ms after a
 * show, by which time a blur may well have dismissed the panel — and a retry
 * that only checks `!isVisible()` reads that dismissal as "the show didn't
 * take" and puts the panel straight back up. Reported from real use: open the
 * panel, click away to dismiss it, and it returns a moment later on its own.
 */
let wantVisible = false
let showRetry: ReturnType<typeof setTimeout> | null = null

/**
 * Windows composites a transparent window before its renderer has painted, so
 * the panel flashed on, vanished (an unpainted transparent window is
 * invisible) and faded back in. It is shown at opacity 0 and revealed a beat
 * later there. macOS shows in step with its first frame and is left alone.
 */
const FADE_IN = process.platform === 'win32'
let revealTimer: ReturnType<typeof setTimeout> | null = null

function clearReveal(): void {
  if (revealTimer) clearTimeout(revealTimer)
  revealTimer = null
}

function clearShowRetry(): void {
  if (showRetry) clearTimeout(showRetry)
  showRetry = null
}

export function panelVisible(): boolean {
  return panel != null && !panel.isDestroyed() && panel.isVisible()
}

function announcePanel(visible: boolean): void {
  if (panel && !panel.isDestroyed()) panel.webContents.send(IPC.push, { kind: 'trayPanel', visible })
}

/**
 * ON macOS A PANEL IS SHOWN AT MOST ONCE. Dismissing it DESTROYS it and
 * pre-creates a hidden replacement, rather than hiding and re-showing the same
 * window. Not a memory tidy — a Spaces workaround, measured 2026-08-15:
 *
 * The WindowServer keeps a HIDDEN window's Space membership from the last time
 * it was shown. When any full-screen Space is torn down (ANY app's — Safari
 * leaving full screen counts, our own display mode certainly does), the
 * windows that belonged to it are re-homed to the desktop it returns to; a
 * VISIBLE all-Spaces window comes out still on every Space, but a hidden one
 * comes out pinned to that single desktop, and re-showing it does not
 * re-expand it. Nothing Electron exposes puts it back — flipping every
 * collection-behaviour bit and the window level was tried; only a NEW window
 * gets a fresh "all Spaces" assignment on its first order-in. Read via
 * CGSCopySpacesForWindows: ALL(9) at first open → [1] after a full-screen exit
 * → ALL(9) again only after destroy + recreate.
 *
 * What the user saw: with the old activating window, opening the pinned panel
 * dragged them to desktop 1 (the app followed its key window); with the
 * non-activating panel, the click "did nothing" anywhere but desktop 1. Both
 * are the same pinned window.
 *
 * The replacement loads in the background, so the next open is as instant as
 * the kept-hidden design ever was; the price is one renderer create per
 * dismiss. Windows keeps hide/re-show — the bug is macOS's, and a hidden
 * window re-shown there lands on the current virtual desktop.
 */
const SHOW_ONCE = process.platform === 'darwin'
let precreate: ReturnType<typeof setTimeout> | null = null

function clearPrecreate(): void {
  if (precreate) clearTimeout(precreate)
  precreate = null
}

function hidePanel(): void {
  // Recorded even when there's nothing to hide: this is the point at which the
  // panel stops being wanted, and a pending retry must not outlive that.
  wantVisible = false
  clearShowRetry()
  clearReveal()
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return
  hidingUntil = Date.now() + CLICK_SWALLOW_MS
  // DevTools attached to the panel would go with it — keep the window while
  // someone is inspecting it (a dev-only path; the Spaces bug is irrelevant
  // to that session).
  if (SHOW_ONCE && !panel.webContents.isDevToolsOpened()) {
    retirePanel()
    return
  }
  panel.hide()
  announcePanel(false)
}

/** Destroy the shown panel and pre-create its never-shown replacement. */
function retirePanel(): void {
  if (panel && !panel.isDestroyed()) panel.destroy()
  panel = null
  clearPrecreate()
  // A beat later, so the dismissal itself stays instant; `ensurePanel` on the
  // next show covers a click that beats this timer.
  precreate = setTimeout(() => {
    precreate = null
    if (tray && !panel) ensurePanel()
  }, 100)
}

function destroyPanel(): void {
  wantVisible = false
  clearShowRetry()
  clearReveal()
  clearPrecreate()
  if (panel && !panel.isDestroyed()) panel.destroy()
  panel = null
}

/**
 * A playlist activation the PANEL started, still running.
 *
 * Playlist activation is a slow, cancellable batch that can also report tracks
 * it couldn't find, so dismissing the panel mid-run loses both the progress and
 * the report. The ruling: **refuse ACCIDENTAL dismissal, honour DELIBERATE
 * dismissal.** Blur is the accidental case — you clicked a playlist, music is
 * starting, you clicked back into your work — and is held. A tray-icon click or
 * Escape is a person deciding, and a 40-track run can hold the panel 15–30s;
 * overriding a decision is worse than losing a progress bar.
 *
 * Scoped to runs started FROM THE PANEL, learned from the IPC sender rather
 * than a message: a run someone kicked off in the main window has its own
 * progress UI and must not make this panel refuse to close.
 */
let panelActivation: string | null = null

/** Is this the tray panel's renderer? */
export function isPanelSender(wc: Electron.WebContents): boolean {
  return panel != null && !panel.isDestroyed() && wc === panel.webContents
}

export function notePanelActivationStart(playlistId: string): void {
  panelActivation = playlistId
}

/**
 * A panel-started run ended. If the panel was DELIBERATELY closed while it ran,
 * the report it would have shown falls back to an OS notification — otherwise
 * starting a playlist from the tray and walking away is a black box.
 */
export function notePanelActivationEnd(result: {
  name: string
  total: number
  added: number
  missed: string[]
  cancelled: boolean
} | null): void {
  panelActivation = null
  if (!result || panelVisible() || !Notification.isSupported()) return
  const missed = result.missed.length
  new Notification({
    title: result.cancelled ? 'Stopped loading' : `Loaded “${result.name}”`,
    body: result.cancelled
      ? `${result.added} of ${result.total} tracks queued.`
      : missed > 0
        ? `${result.added} of ${result.total} tracks — ${missed} not found.`
        : `${result.added} ${result.added === 1 ? 'track' : 'tracks'} queued.`,
    silent: true
  }).show()
}

/**
 * Test-only: the harness's anatomy sweep drives the OPEN panel for a minute
 * or more, and with dismiss = destroy (SHOW_ONCE) a stray blur — someone
 * touching the Mac while the suite runs — would destroy the very page the
 * sweep holds. Under TASTYTUNES_TRAY_TEST the hook can hold the panel open;
 * production never sets it.
 */
let testHold = false

/** Dismiss-on-blur, and the four things that must not count as a dismissal. */
function onPanelBlur(): void {
  if (testHold) return
  // DEVTOOLS STEAL FOCUS, so an unguarded blur-hide makes the panel impossible
  // to inspect — it vanishes the instant you open the inspector.
  if (panel && !panel.isDestroyed() && panel.webContents.isDevToolsOpened()) return
  if (Date.now() - shownAt < SETTLE_MS) return
  // The accidental case, held. Note this guard is ONLY here — `hidePanel` still
  // hides on Escape and on a tray click, which are deliberate.
  if (panelActivation != null) return
  hidePanel()
}

/**
 * Build the panel on first use and keep it around hidden.
 *
 * A third renderer costs 40–80MB, which is why it isn't created with the tray
 * — someone who turns the icon on for its menu never pays for a panel they
 * don't open. A panel that has been opened is never left un-built after that,
 * because creating one at click time shows an empty frame while React mounts:
 * on Windows the same window is kept hidden; on macOS a dismissed panel is
 * destroyed and its replacement pre-created hidden (see SHOW_ONCE) — either
 * way the next click finds a mounted renderer.
 */
function ensurePanel(): BrowserWindow {
  if (panel && !panel.isDestroyed()) return panel
  panel = new BrowserWindow({
    ...PANEL_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // NEVER FULL-SCREENABLE. Electron leaves NSWindowCollectionBehaviorFullScreenPrimary
    // on by default even for a non-resizable window, and a Primary window
    // ordered in while the app's own main window is full screen is not
    // overlaid — macOS promotes it to a full-screen tile of its own: the panel
    // came up 1728×1084 in a brand-new Space when the icon was clicked from
    // display mode (user report, 2026-08-15; measured: isFullScreen true, a
    // new Space id). With Primary cleared it is a plain auxiliary overlay,
    // 380×560, on the Space it was summoned from.
    fullscreenable: false,
    // A NON-ACTIVATING PANEL ON macOS (Electron's `type: 'panel'` wraps the
    // window in an NSPanel with NSWindowStyleMaskNonactivatingPanel). It can
    // become key — the search field still takes typing — but showing it never
    // ACTIVATES the app, and that is the whole point: `show()` on an ordinary
    // window calls activateIgnoringOtherApps BEFORE ordering the window in,
    // and app activation is what makes macOS jump to "a Space with open
    // windows for the application" — i.e. every tray click yanked the user to
    // whichever desktop the main window lived on (reported 2026-08-15). A
    // panel gives macOS nothing to switch for, and dismissing it leaves the
    // app you were in frontmost, Spotlight-style. The type also carries
    // all-Spaces + over-fullscreen in its collection behaviour, which is what
    // lets the transform below be skipped. Windows has no such type; there a
    // hidden window re-shown lands on the current virtual desktop anyway.
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    // No traffic lights, no shadow gap — the panel draws its own card.
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      // THE PANEL MUST NOT BE THROTTLED WHILE HIDDEN. Chromium suspends
      // timers and coalesces work in background windows, and this window
      // spends nearly all its life hidden — so on reopen it painted the last
      // frame it managed before falling asleep (yesterday's album art, a
      // playhead frozen mid-track) and only then caught up on the pushes it
      // had queued. That flash is the whole "is this thing live?" question,
      // answered badly. The cost is a hidden 380px window keeping up with a
      // push every second or so, which is nothing.
      backgroundThrottling: false
    }
  })
  try {
    // skipTransformProcessType IS THE FIX FOR A VANISHING DOCK ICON. Without
    // it, `visibleOnFullScreen` makes Electron flip the WHOLE APP to the
    // accessory activation policy (no dock icon, no menu bar) — the same flip
    // the mini player restores on close (4cd081b) — and this panel is created
    // once and kept hidden for the rest of the session, so nothing ever
    // flipped it back: from the first panel open onward, TastyTunes had no
    // dock icon (proven in the harness: app.dock.isVisible() true → false →
    // still false after dismiss). The panel type above already floats over
    // fullscreen without any of that, so the transform is pure cost. Guarded
    // by verify-invariants S7/S8.
    panel.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
  } catch {
    // not supported everywhere; cosmetic
  }
  panel.on('blur', () => onPanelBlur())
  // Escape is a DELIBERATE dismissal and always honoured (phase 3's
  // playlist-activation rule only ever holds the panel against ACCIDENTAL
  // blur, never against a person deciding to close it).
  panel.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') hidePanel()
  })
  // Identity-checked: with dismiss = destroy + pre-create, a `closed` from the
  // retired window must never null the replacement.
  const self = panel
  panel.on('closed', () => {
    if (panel === self) panel = null
  })
  // A push sent while the renderer is still loading is LOST, and the very
  // first open is exactly that case: the window is created and shown in the
  // same breath, so the "you're open" announcement lands before anything is
  // listening — and the tab heuristic silently never ran on a first open.
  // Re-announce once loaded (the did-finish-load rule the main window and the
  // mini player both follow).
  panel.webContents.on('did-finish-load', () => {
    if (panelVisible()) announcePanel(true)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void panel.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?tray=1`)
  } else {
    void panel.loadFile(join(__dirname, '../renderer/index.html'), { query: { tray: '1' } })
  }
  return panel
}

/**
 * What the last show computed its position from. Exists for the harness: menu
 * bar icons shift as their neighbours come and go, so reading `getBounds()`
 * again after the fact races the layout and can't tell a mis-anchored panel
 * from an icon that simply moved.
 */
let lastAnchor: { trayBounds: Rect; workArea: Rect; bounds: Rect } | null = null

/** Position the panel under the icon and show it. */
function showPanel(): void {
  if (!tray) return
  const win = ensurePanel()
  const trayBounds = tray.getBounds()
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  // getBounds() gives the icon's rectangle; the panel still has to be clamped
  // into the work area of the display that icon is ON — a menu-bar extra sits
  // at the right edge, so a centred panel hangs off the side almost always.
  const area =
    trayBounds.width > 0
      ? workAreaFor(trayBounds, displays)
      : screen.getPrimaryDisplay().workArea
  const bounds = anchorToTray(trayBounds, area, PANEL_SIZE)
  lastAnchor = { trayBounds, workArea: area, bounds }
  win.setBounds(bounds)
  wantVisible = true
  shownAt = Date.now()
  // SHOW BEHIND OPACITY 0 ON WINDOWS, then reveal once a frame exists.
  //
  // A transparent window that is composited before its renderer has painted
  // is FULLY SEE-THROUGH, so on Windows the panel appeared for an instant,
  // vanished, and then faded in under the OS's own show animation — reported
  // from real use 2026-08-04. macOS doesn't show it (its show is synchronous
  // with the first frame), so this stays scoped rather than changing a
  // behaviour that is already right.
  //
  // Opacity, not a deferred show(): the window has to be shown to paint, and
  // deferring the show is what the 900ms retry below already has to work
  // around. This way the window is live and laying out while invisible, and
  // the reveal is a single property change.
  if (FADE_IN) win.setOpacity(0)
  win.show()
  win.focus()
  if (FADE_IN) {
    clearReveal()
    // Two frames at 60Hz. Long enough for the renderer to have painted with
    // backgroundThrottling off, short enough to read as instant.
    revealTimer = setTimeout(() => {
      revealTimer = null
      if (panel && !panel.isDestroyed() && wantVisible) panel.setOpacity(1)
    }, 32)
  }
  // The panel is hidden, not destroyed, so the renderer never remounts — this
  // is the only way it learns it has been reopened.
  announcePanel(true)
  // 'ready-to-show' is unreliable for transparent windows (the mini player
  // carries the same workaround) — retry rather than never appearing. Guarded
  // on `wantVisible`, because by the time this fires the panel may have been
  // deliberately dismissed, and "not visible" would otherwise be mistaken for
  // "the show didn't take".
  clearShowRetry()
  showRetry = setTimeout(() => {
    showRetry = null
    if (!wantVisible || !panel || panel.isDestroyed() || panel.isVisible()) return
    // A late show restarts the settle window — it IS a show, and the blur it
    // may provoke is no more a dismissal than the first one was.
    shownAt = Date.now()
    panel.show()
    panel.focus()
    // The retry is a show like any other: it must lift the opacity too, or a
    // panel rescued by it stays invisible at 0 for good.
    if (FADE_IN) panel.setOpacity(1)
  }, 900)
}

/** What a click on the tray icon does. Exported for the test hook. */
export function toggleTrayPanel(): void {
  if (!tray) return
  if (Date.now() < hidingUntil) return
  if (panelVisible()) hidePanel()
  else showPanel()
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
  const menu = Menu.buildFromTemplate(toTemplate(nodes, deps))
  // On Linux the menu IS the feature, so it stays attached to the icon and
  // opens on activation. Where there's a panel, left-click belongs to it and
  // the menu moves to right-click, popped on demand.
  if (HAS_PANEL) contextMenu = menu
  else tray.setContextMenu(menu)
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
    // The panel goes with it — a hidden 40–80MB renderer belonging to a
    // feature that's been switched off is pure leak.
    destroyPanel()
    tray?.destroy()
    tray = null
    rendered = null
    contextMenu = null
    return
  }
  tray = new Tray(trayIcon())
  tray.setToolTip('TastyTunes')
  refreshTrayMenu()
  if (HAS_PANEL) {
    // Left-click toggles the panel, right-click pops the menu. `click` also
    // fires on Linux (as "activation"), which is exactly why Linux takes the
    // other branch: there it must open the MENU, and it does so via the menu
    // attached in refreshTrayMenu rather than through this handler.
    tray.on('click', () => toggleTrayPanel())
    tray.on('right-click', () => {
      // Popped fresh from the held menu — `popUpContextMenu` is macOS/Windows
      // only, which is fine, because so is this branch.
      hidePanel()
      if (tray && contextMenu) tray.popUpContextMenu(contextMenu)
    })
  }
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
        /** What a click on the icon does — the input no harness can send. */
        toggle(): void
        panel(): {
          exists: boolean
          visible: boolean
          bounds: Electron.Rectangle | null
          trayBounds: Electron.Rectangle | null
          lastAnchor: { trayBounds: Rect; workArea: Rect; bounds: Rect } | null
        }
        /** Drive a blur without a real focus change, to test dismiss-on-blur. */
        blur(): boolean
        /** Hold the open panel against blur for the duration of a sweep (test-only). */
        hold(on: boolean): void
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
    },
    toggle: () => toggleTrayPanel(),
    panel: () => ({
      exists: panel != null && !panel.isDestroyed(),
      visible: panelVisible(),
      bounds: panel && !panel.isDestroyed() ? panel.getBounds() : null,
      // The icon rect the anchor was computed from — the harness can't see the
      // menu bar, so this is the only way to tell a bad anchor from a bad
      // reading of where the icon is. `lastAnchor` is the reading taken AT SHOW
      // TIME; `trayBounds` is live and may already have moved.
      trayBounds: tray ? tray.getBounds() : null,
      lastAnchor
    }),
    // A harness can't take focus away from a window it doesn't own, so the
    // blur PATH is exercised directly — through the SAME handler a real focus
    // loss runs, guards included, not a shortcut to hide().
    blur(): boolean {
      if (!panelVisible()) return false
      onPanelBlur()
      return !panelVisible()
    },
    hold(on: boolean): void {
      testHold = on
    }
  }
}
