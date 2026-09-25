/**
 * Window placement against a synthetic display matrix.
 *
 * The tray panel is anchored from a menu-bar or taskbar click, which no
 * harness can send, so this is where its maths is proved. All coordinates
 * are Electron's: device-independent pixels, one global space, the primary
 * display's top-left at (0, 0), displays to its left or above it negative.
 * The rectangles handed to these functions are WORK AREAS, which exclude the
 * menu bar, the Dock and the taskbar: exactly the strips a tray icon lives
 * in. That one fact is what most of this file is about.
 */
import { describe, expect, it } from "vitest";
import { anchorToTray, homeWorkArea, isOnScreen, workAreaFor, type Rect } from "./windowPlacement";

/** The tray panel's size, as tray.ts creates it. */
const PANEL = { width: 380, height: 560 };
/** windowPlacement's breathing room between the panel and a work area's edge. */
const MARGIN = 4;
/** anchorToTray's default gap between the icon and the panel. */
const GAP = 6;

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

const centreOf = (r: Rect): { x: number; y: number } => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});

const contains = (area: Rect, p: { x: number; y: number }): boolean =>
  p.x >= area.x && p.x < area.x + area.width && p.y >= area.y && p.y < area.y + area.height;

/** The panel sits inside the work area with the margin kept on every side. */
function expectInside(panel: Rect, area: Rect): void {
  expect(panel.x).toBeGreaterThanOrEqual(area.x + MARGIN);
  expect(panel.y).toBeGreaterThanOrEqual(area.y + MARGIN);
  expect(panel.x + panel.width).toBeLessThanOrEqual(area.x + area.width - MARGIN);
  expect(panel.y + panel.height).toBeLessThanOrEqual(area.y + area.height - MARGIN);
}

interface Scenario {
  name: string;
  /** Work areas in the order the caller passes them. */
  displays: Rect[];
  /** Where the OS reports the tray icon. */
  icon: Rect;
  /** Which display the icon is really on (an index into `displays`). */
  on: number;
  /** Where the panel must land. */
  panel: Rect;
}

// Each display is described by its work area; the comment gives the full
// bounds and what the work area leaves out.
const SCENARIOS: Scenario[] = [
  {
    // 1512×982 laptop, 37px notch menu bar, Dock at the bottom
    name: "macOS, one display: centred under the icon, just below the menu bar",
    displays: [rect(0, 37, 1512, 880)],
    icon: rect(1180, 0, 32, 37),
    on: 0,
    panel: rect(1196 - 190, 37 + GAP, 380, 560),
  },
  {
    // laptop 1512×982 at (0, 0); a 2560×1440 external to its right with its
    // own 25px menu bar, and the icon on THAT menu bar near its right edge
    name: "macOS, side by side, menu bar on the second display: clamped to its right edge",
    displays: [rect(0, 37, 1512, 945), rect(1512, 25, 2560, 1415)],
    icon: rect(3900, 0, 24, 24),
    on: 1,
    panel: rect(1512 + 2560 - 380 - MARGIN, 24 + GAP, 380, 560),
  },
  {
    // a 4K monitor at 150% (2560×1440 points) to the LEFT of a 1728×1117
    // laptop, bottom edges aligned, so its top is at y = 1117 − 1440 = −323;
    // the icon sits on the external's menu bar
    name: "macOS, a scaled external to the left (negative coordinates), tops not aligned",
    displays: [rect(0, 38, 1728, 1079), rect(-2560, -323 + 25, 2560, 1415)],
    icon: rect(-300, -323, 28, 25),
    on: 1,
    panel: rect(-286 - 190, -323 + 25 + GAP, 380, 560),
  },
  {
    // 1920×1080 at 100%, a 48px taskbar along the bottom; the notification
    // area is at the bottom right, so the panel opens UPWARD, and the clamp
    // keeps it inside the work area rather than a gap above the icon
    name: "Windows, one display, taskbar at the bottom: opens upward, inside the work area",
    displays: [rect(0, 0, 1920, 1032)],
    icon: rect(1766, 1044, 24, 24),
    on: 0,
    panel: rect(1920 - 380 - MARGIN, 1032 - 560 - MARGIN, 380, 560),
  },
  {
    // a 2560×1440 at 150% (1707×960 DIP, 48px taskbar) beside a 1920×1080 at
    // 100% that carries the notification area: different sizes and scales
    name: "Windows, side by side at different scales, tray on the second display",
    displays: [rect(0, 0, 1707, 912), rect(1707, 0, 1920, 1032)],
    icon: rect(3400, 1044, 24, 24),
    on: 1,
    panel: rect(3412 - 190, 1032 - 560 - MARGIN, 380, 560),
  },
  {
    // a 1440×900 laptop with a wider 2560×1440 external stacked ABOVE it,
    // offset to the left; the icon on the external's menu bar, beyond the
    // laptop's columns
    name: "macOS, stacked, icon on the upper display beyond the lower one's columns",
    displays: [rect(0, 25, 1440, 875), rect(-560, -1440 + 25, 2560, 1415)],
    icon: rect(1700, -1440, 24, 25),
    on: 1,
    panel: rect(1712 - 190, -1440 + 25 + GAP, 380, 560),
  },
];

describe("the synthetic display matrix", () => {
  it.each(SCENARIOS)("$name", ({ displays, icon, on, panel }) => {
    // the fixture's own premise: a tray icon is never inside any work area
    for (const area of displays) expect(contains(area, centreOf(icon))).toBe(false);

    const area = workAreaFor(icon, displays);
    expect(area).toBe(displays[on]);

    const placed = anchorToTray(icon, area, PANEL);
    expect(placed).toEqual(panel);
    expectInside(placed, area);
  });
});

describe("workAreaFor: which display a tray icon is on", () => {
  // The bug this guards: a containment test on the icon's centre misses every
  // work area, falls through to the first entry, and a menu bar on a second
  // monitor anchors the panel against the wrong screen.
  it("matches by the icon's column when no work area contains it, not the first entry", () => {
    const laptop = rect(0, 37, 1512, 945);
    const external = rect(1512, 25, 2560, 1415);
    const icon = rect(2000, 0, 24, 24);
    expect(workAreaFor(icon, [laptop, external])).toBe(external);
    // and a naive centre-containment test would indeed have found nothing
    expect([laptop, external].some((a) => contains(a, centreOf(icon)))).toBe(false);
  });

  it("uses containment first, for rectangles that are inside a work area", () => {
    // a window on the lower of two stacked displays shares its column with
    // the upper one; containment tells them apart
    const upper = rect(0, -1080, 1920, 1080);
    const lower = rect(0, 0, 1920, 1032);
    expect(workAreaFor(rect(800, 400, 300, 200), [upper, lower])).toBe(lower);
    expect(workAreaFor(rect(800, -600, 300, 200), [upper, lower])).toBe(upper);
  });

  it("decides a display edge by the icon's centre, the left edge inclusive", () => {
    const left = rect(0, 25, 1440, 875);
    const right = rect(1440, 25, 1920, 1055);
    // an icon straddling the seam belongs where its centre is
    expect(workAreaFor(rect(1420, 0, 24, 24), [left, right])).toBe(left);
    expect(workAreaFor(rect(1430, 0, 24, 24), [left, right])).toBe(right);
    // a centre exactly on the seam is the right-hand display's first column
    expect(workAreaFor(rect(1428, 0, 24, 24), [left, right])).toBe(right);
  });

  it("falls back to the first entry when the icon is on no display at all", () => {
    // a display that has since been unplugged: callers pass the primary
    // first, so the panel still lands somewhere real
    const primary = rect(0, 25, 1440, 875);
    const other = rect(1440, 25, 1920, 1055);
    expect(workAreaFor(rect(9000, 0, 24, 24), [primary, other])).toBe(primary);
  });

  it("stacked displays sharing the icon's column: the first one listed wins", () => {
    // A KNOWN LIMIT, pinned so a change to it is deliberate: the fallback is
    // by column alone, because displays tile side by side far more often
    // than they stack. In a stack, an icon in a strip BETWEEN the two work
    // areas matches both columns and the list order decides; the caller
    // lists every display in Electron's order.
    const lower = rect(0, 25, 1440, 875); // 1440×900 laptop, menu bar at y 0–25
    const upper = rect(0, -1080, 1920, 1032); // 1920×1080 above, taskbar at y −48–0
    const onLowerMenuBar = rect(1300, 0, 24, 25);
    expect(workAreaFor(onLowerMenuBar, [lower, upper])).toBe(lower);
    expect(workAreaFor(onLowerMenuBar, [upper, lower])).toBe(upper);
  });
});

describe("anchorToTray: where the panel goes", () => {
  const macArea = rect(0, 25, 1440, 875);

  it("centres the panel under the icon and pins it the gap below", () => {
    const icon = rect(700, 0, 24, 25);
    const placed = anchorToTray(icon, macArea, PANEL);
    expect(placed.x + placed.width / 2).toBe(712);
    expect(placed.y).toBe(25 + GAP);
    expect(placed).toMatchObject(PANEL);
  });

  it("clamps to the right edge: a menu-bar extra near the corner does not hang off", () => {
    const placed = anchorToTray(rect(1400, 0, 24, 25), macArea, PANEL);
    expect(placed.x).toBe(1440 - 380 - MARGIN);
    expectInside(placed, macArea);
  });

  it("clamps to the left edge too", () => {
    const placed = anchorToTray(rect(10, 0, 24, 25), macArea, PANEL);
    expect(placed.x).toBe(MARGIN);
  });

  it("opens above the icon when there is no room below it", () => {
    // a taskbar icon near the bottom of a tall work area: the panel's bottom
    // is the gap above the icon (the clamp has nothing to correct)
    const area = rect(0, 0, 1920, 1200);
    const icon = rect(1000, 1100, 24, 24);
    const placed = anchorToTray(icon, area, PANEL);
    expect(placed.y + placed.height).toBe(1100 - GAP);
  });

  it("sits at the top of the work area when it fits neither below nor above", () => {
    // a work area shorter than the panel: the top edge wins, the bottom
    // overflows (there is nowhere better)
    const short = rect(0, 25, 1280, 500);
    expect(anchorToTray(rect(600, 0, 24, 25), short, PANEL).y).toBe(25 + MARGIN);
    // and a taskbar on the LEFT edge with the icon mid-height: beside the
    // taskbar, at the top
    const beside = rect(48, 0, 1872, 1080);
    const placed = anchorToTray(rect(12, 500, 24, 24), beside, PANEL);
    expect(placed).toEqual(rect(48 + MARGIN, MARGIN, 380, 560));
  });

  it("puts the panel in the top-right corner when the platform reports no icon bounds", () => {
    // Linux's tray reports all zeroes; a menu-bar extra's corner is the
    // honest guess (the menu bar here is 25px, so the margin clears it)
    const placed = anchorToTray(rect(0, 0, 0, 0), macArea, PANEL);
    expect(placed.x).toBe(1440 - 380 - MARGIN);
    expect(placed.y).toBe(25 + MARGIN);
  });

  it("returns whole pixels when the icon's centre falls between two", () => {
    // an odd-width icon, or a fractional one on a scaled display: the centre
    // is at 1012.5 and the icon's bottom at 24.5, so both sums end in .5
    const placed = anchorToTray(rect(1000, 0, 25, 24.5), macArea, PANEL);
    expect(placed.x).toBe(823); // 1012.5 − 190 = 822.5
    expect(placed.y).toBe(31); // 24.5 + 6 = 30.5
  });

  it("takes a custom gap", () => {
    expect(anchorToTray(rect(700, 0, 24, 25), macArea, PANEL, 12).y).toBe(25 + 12);
  });

  it("keeps the panel on-screen and under the icon for every icon position along a strip", () => {
    // a sweep across each scenario's menu bar or taskbar, one icon every
    // 37px: whatever the position, the panel is inside the icon's display
    // and overlaps the icon's column (columns another display shares are
    // the stacked limit pinned above, so the sweep steps over them)
    for (const { displays, icon, on } of SCENARIOS) {
      const area = displays[on];
      const others = displays.filter((d) => d !== area);
      for (let x = area.x + MARGIN; x + icon.width <= area.x + area.width - MARGIN; x += 37) {
        const moved = { ...icon, x };
        const cx = centreOf(moved).x;
        if (others.some((d) => cx >= d.x && cx < d.x + d.width)) continue;
        expect(workAreaFor(moved, displays)).toBe(area);
        const placed = anchorToTray(moved, area, PANEL);
        expectInside(placed, area);
        expect(placed.x).toBeLessThan(moved.x + moved.width);
        expect(placed.x + placed.width).toBeGreaterThan(moved.x);
      }
    }
  });
});

describe("homeWorkArea: is a remembered window position still usable", () => {
  const laptop = rect(0, 25, 1440, 875);
  const external = rect(1440, 0, 2560, 1415);
  const areas = [laptop, external];

  it("returns the work area the position is on", () => {
    expect(homeWorkArea({ x: 200, y: 200 }, areas)).toBe(laptop);
    expect(homeWorkArea({ x: 2000, y: 300 }, areas)).toBe(external);
  });

  it("rejects a position saved on a monitor that is no longer connected", () => {
    // saved on the external, reopened with only the laptop
    expect(homeWorkArea({ x: 2000, y: 300 }, [laptop])).toBeNull();
    expect(isOnScreen({ x: 2000, y: 300 }, [laptop])).toBe(false);
  });

  it("is generous at the left and top: a window hanging slightly off is still grabbable", () => {
    expect(homeWorkArea({ x: -40, y: 200 }, [laptop])).toBe(laptop);
    expect(homeWorkArea({ x: -41, y: 200 }, [laptop])).toBeNull();
    expect(homeWorkArea({ x: 200, y: 25 - 10 }, [laptop])).toBe(laptop);
    expect(homeWorkArea({ x: 200, y: 25 - 11 }, [laptop])).toBeNull();
  });

  it("needs room to grab at the right and bottom: 100px of width, 60px of height", () => {
    expect(homeWorkArea({ x: 1440 - 100, y: 200 }, [laptop])).toBe(laptop);
    expect(homeWorkArea({ x: 1440 - 99, y: 200 }, [laptop])).toBeNull();
    expect(homeWorkArea({ x: 200, y: 25 + 875 - 60 }, [laptop])).toBe(laptop);
    expect(homeWorkArea({ x: 200, y: 25 + 875 - 59 }, [laptop])).toBeNull();
  });

  it("isOnScreen is the same test as a yes or no", () => {
    expect(isOnScreen({ x: 200, y: 200 }, areas)).toBe(true);
    expect(isOnScreen({ x: 200, y: 200 }, [])).toBe(false);
  });
});
