/**
 * Where windows go — as PURE functions over plain rectangles.
 *
 * Two reasons this isn't inline in index.ts. The on-screen check was written
 * twice already (main window, mini player) and a third copy was about to be
 * born. And the tray panel's anchor math is the one piece of the tray that a
 * harness genuinely cannot reach: Playwright can't click the macOS menu bar,
 * so the only way to test "does the panel land somewhere sane on a second
 * display, at the right edge, under a short work area" is to test the maths
 * directly. Nothing here touches Electron.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/**
 * Is a remembered position still usable on one of `workAreas`?
 *
 * Deliberately generous rather than exact: a window may hang slightly off the
 * left edge or above the top and still be perfectly grabbable, and a saved
 * spot that's *nearly* right is better than dumping the window in the middle
 * of the primary display. What it rejects is the real failure — bounds saved
 * on an external monitor that isn't plugged in any more, which would otherwise
 * reopen the window somewhere no cursor can reach.
 */
export function homeWorkArea(spot: { x: number; y: number }, workAreas: Rect[]): Rect | null {
  return (
    workAreas.find(
      (w) =>
        spot.x >= w.x - 40 &&
        spot.x <= w.x + w.width - 100 &&
        spot.y >= w.y - 10 &&
        spot.y <= w.y + w.height - 60
    ) ?? null
  )
}

/** As `homeWorkArea`, for callers that only need yes/no. */
export const isOnScreen = (spot: { x: number; y: number }, workAreas: Rect[]): boolean =>
  homeWorkArea(spot, workAreas) != null

/** Clamp `n` into [min, max], tolerating an inverted range (max < min). */
const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(n, max))

/**
 * Where the tray panel goes, given the tray icon's rectangle and the work area
 * of the display that icon is on.
 *
 * Centred under the icon and pinned just below it, then clamped into the work
 * area. The clamp is the whole job: menu-bar extras live at the RIGHT edge of
 * the screen, so a centred 380px panel hangs off the side for almost every
 * icon position, and on Windows the taskbar can be on any edge — which is why
 * the vertical placement flips above the icon when there isn't room below.
 *
 * `trayBounds` is all zeroes on platforms that don't report it (and the caller
 * shouldn't be building a panel there at all), so a zero-width icon falls back
 * to the top-right corner of the work area rather than the top-left, which is
 * where a menu-bar extra would be.
 */
export function anchorToTray(trayBounds: Rect, workArea: Rect, panel: Size, gap = 6): Rect {
  const minX = workArea.x + MARGIN
  const maxX = workArea.x + workArea.width - panel.width - MARGIN
  const anchored =
    trayBounds.width > 0
      ? trayBounds.x + trayBounds.width / 2 - panel.width / 2
      : workArea.x + workArea.width - panel.width - MARGIN
  const x = Math.round(clamp(anchored, minX, maxX))

  // Below the icon if it fits, above it if it doesn't (a taskbar on the bottom
  // edge puts the icon near the bottom of the screen). If neither fits, sit at
  // the top of the work area and let the clamp keep it on screen.
  const below = trayBounds.y + trayBounds.height + gap
  const above = trayBounds.y - gap - panel.height
  const fitsBelow = below + panel.height <= workArea.y + workArea.height - MARGIN
  const minY = workArea.y + MARGIN
  const maxY = workArea.y + workArea.height - panel.height - MARGIN
  const y = Math.round(clamp(fitsBelow ? below : above, minY, maxY))

  return { x, y, width: panel.width, height: panel.height }
}

/** Breathing room between the panel and the edge of the work area. */
const MARGIN = 4

/**
 * The work area of the display a rectangle sits on, chosen from a list.
 *
 * The vertical fallback is the whole point. A TRAY ICON LIVES OUTSIDE THE WORK
 * AREA — it's in the menu bar or the taskbar, which is precisely the strip a
 * work area excludes — so a containment test on the centre point misses every
 * time (a macOS icon at y=0 against a work area starting at y=25). Falling
 * back to horizontal containment is what actually identifies the display,
 * since displays are tiled side by side far more often than stacked.
 *
 * Without this, a menu bar on a SECOND monitor anchored the panel against the
 * primary display's work area and the clamp then dragged it onto the wrong
 * screen entirely.
 *
 * Final fallback is the first entry — callers pass the primary display first,
 * so an icon on a display that has since vanished still lands somewhere real.
 */
export function workAreaFor(rect: Rect, displays: Rect[]): Rect {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const contains = displays.find(
    (w) => cx >= w.x && cx < w.x + w.width && cy >= w.y && cy < w.y + w.height
  )
  if (contains) return contains
  return displays.find((w) => cx >= w.x && cx < w.x + w.width) ?? displays[0]
}
