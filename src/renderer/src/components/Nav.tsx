import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Command, EyeOff, PanelLeftClose, PanelLeftOpen, PictureInPicture2 } from "lucide-react";
import { tt } from "@/api";
import { useStore, type Screen } from "@/store";
import { cx } from "@/lib/format";
import {
  MOD,
  orderedNavScreens,
  NAV_UNHIDEABLE,
  SETTINGS_SCREEN,
  sanitizeNavHidden,
  sanitizeNavHiddenTools,
  type NavTool,
  type ScreenDef,
} from "@/lib/screens";
import { PopoverCard } from "@/components/chrome/Overlay";

/**
 * Right-click target: which nav item (a screen or a bottom-cluster tool), and
 * where the cursor was. Discriminated so onHide writes the right hide-set.
 */
type NavMenu =
  | { kind: "screen"; id: Screen; label: string; x: number; y: number }
  | { kind: "tool"; id: NavTool; label: string; x: number; y: number };

export function Nav(): React.JSX.Element {
  const screen = useStore((s) => s.screen);
  const connection = useStore((s) => s.connection);
  const saveSettings = useStore((s) => s.saveSettings);
  const setScreen = useStore((s) => s.setScreen);
  const setInfoOpen = useStore((s) => s.setInfoOpen);
  const jumpToSettingsTab = useStore((s) => s.jumpToSettingsTab);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const queueTotal = useStore((s) => s.queue?.total ?? null);
  const ambientWindow = useStore((s) => s.ambientWindowActive);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.update);
  const [menu, setMenu] = useState<NavMenu | null>(null);
  // Collapsed-rail tooltips are portaled to <body> so they escape the screens
  // scroller's overflow-x clip (a CSS ::after tooltip can't). No-op expanded —
  // there the label + shortcut already show on the row.
  const [navTip, setNavTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const navTipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The rail outlives every screen, so this only bites on a dev hot-update —
  // but a pending timer surviving its component is exactly the leak class the
  // entry-idempotency rules exist for. Clear it on the way out.
  useEffect(
    () => () => {
      if (navTipTimer.current) clearTimeout(navTipTimer.current);
    },
    [],
  );

  const collapsed = settings.navCollapsed;
  const toggleCollapsed = async (): Promise<void> => {
    await saveSettings({ navCollapsed: !collapsed });
  };
  const navTipHandlers = (label: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      if (!collapsed) return;
      const r = e.currentTarget.getBoundingClientRect();
      const pos = { label, top: r.top + r.height / 2, left: r.right + 10 };
      if (navTipTimer.current) clearTimeout(navTipTimer.current);
      navTipTimer.current = setTimeout(() => setNavTip(pos), 450);
    },
    onMouseLeave: () => {
      if (navTipTimer.current) clearTimeout(navTipTimer.current);
      setNavTip(null);
    },
  });

  const hidden = sanitizeNavHidden(settings.navHidden);
  const hiddenSet = new Set(hidden);
  // ORDER FIRST, then hide. A hidden screen keeps its slot in navOrder, so
  // unhiding puts it back where it was rather than at the bottom.
  const visibleScreens = orderedNavScreens(settings.navOrder).filter((s) => !hiddenSet.has(s.id));
  const navDropTarget = useStore((s) => s.navDropTarget);
  const navDragActive = useStore((s) => s.navDragActive);

  const hiddenTools = sanitizeNavHiddenTools(settings.navHiddenTools);
  const hiddenToolSet = new Set(hiddenTools);

  // One verb for both nav-item kinds; the discriminant picks the hide-set.
  const hideFromMenu = (m: NavMenu): void => {
    if (m.kind === "screen") {
      if (!hidden.includes(m.id)) void saveSettings({ navHidden: [...hidden, m.id] });
    } else {
      if (!hiddenTools.includes(m.id))
        void saveSettings({ navHiddenTools: [...hiddenTools, m.id] });
    }
    setMenu(null);
  };

  // Right-click a bottom-cluster tool → the same "Hide from sidebar" menu.
  const openToolMenu =
    (id: NavTool, label: string) =>
    (e: React.MouseEvent): void => {
      e.preventDefault();
      setMenu({ kind: "tool", id, label, x: e.clientX, y: e.clientY });
    };

  const navItem = ({ id, label, icon: Icon, key }: ScreenDef): React.JSX.Element => (
    <button
      key={id}
      data-nav-screen={id}
      onClick={() => setScreen(id)}
      // Right-click → "Hide from sidebar" (the fast path). Not for the
      // unhideable screens (now-playing): no menu at all there.
      onContextMenu={
        NAV_UNHIDEABLE.includes(id)
          ? undefined
          : (e) => {
              e.preventDefault();
              setMenu({ kind: "screen", id, label, x: e.clientX, y: e.clientY });
            }
      }
      {...navTipHandlers(`${label} (${key})`)}
      aria-label={`${label} (${key})`}
      className={cx(
        "w-full flex items-center rounded-lg h-9 text-[13.5px] transition-colors",
        collapsed ? "justify-center px-0" : "gap-3 px-3",
        screen === id ? "bg-amberdim text-amber" : "text-dim hover:text-ink hover:bg-veil",
        // While a rail-capable drag is live, hover must not suggest
        // droppability — only a real target lights, via the class below.
        navDragActive && "pointer-events-none",
        // a live drag hovering this row: the drop glow (drag-to-rail)
        navDropTarget === id && "ring-1 ring-gold/60 bg-golddim text-gold",
      )}
    >
      <Icon size={16} strokeWidth={1.8} className="shrink-0" />
      {!collapsed && (
        // inner wrapper clips so labels never re-wrap mid collapse/expand
        <span className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden whitespace-nowrap">
          <span className="flex-1 text-left">{label}</span>
          {id === "queue" && queueTotal != null && queueTotal > 0 && (
            <span className="font-mono text-[10px] text-faint">{queueTotal}</span>
          )}
          <span className="font-mono text-[9px] text-faint/60">{key}</span>
        </span>
      )}
    </button>
  );

  return (
    <nav
      data-app-nav
      className={cx(
        "shrink-0 flex flex-col border-r border-edge transition-all",
        collapsed ? "w-16" : "w-56",
        ambientWindow ? "bg-transparent" : "bg-panel/60",
      )}
    >
      {/* macOS traffic-light inset + wordmark; draggable like a title bar */}
      <div className={cx("drag-region pt-11 pb-5", collapsed ? "px-0 text-center" : "px-5")}>
        <button
          // the dot's promise: with an update pending, the wordmark lands on
          // Settings → Updates (the panel's home); otherwise it opens About
          onClick={() => (update ? jumpToSettingsTab("updates") : setInfoOpen(true))}
          data-tip={update ? `v${update.version} available — open Updates` : "About TastyTunes"}
          aria-label={update ? `v${update.version} available — open Updates` : "About TastyTunes"}
          className="no-drag relative inline-block align-top font-wordmark font-bold text-[21px] leading-none tracking-tight cursor-pointer"
        >
          {collapsed ? (
            <>
              t<span className="text-gold">t</span>
            </>
          ) : (
            <>
              tasty<span className="text-gold">tunes</span>
            </>
          )}
          {update && (
            // no-drag + a 16px hit box: the dot pokes outside the button's
            // rect into the title-bar drag region, where un-exempted pixels
            // grab the window instead of clicking.
            <span
              aria-label="Update available"
              className="no-drag absolute -top-1.5 -right-4 w-4 h-4 flex items-center justify-center"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-gold" />
            </span>
          )}
        </button>
        {/* demo-mode marker doubles as the exit — the Device screen's
            Disconnect works too, but this makes leaving obvious */}
        {!collapsed && connection.phase !== "idle" && connection.demo && (
          // tip-bottom + explicit z: the default right-side tip lands on the
          // main area's screen title (and loses the paint-order fight there)
          <button
            onClick={() => void tt.disconnect()}
            data-tip="You're in the demo — click to exit"
            aria-label="Exit demo"
            className="no-drag tip-bottom z-[70] ml-2 align-[3px] px-1.5 py-0.5 rounded-md ring-1 ring-gold/40 bg-golddim font-mono text-[9px] uppercase tracking-widest text-gold hover:brightness-110 motion-safe:active:scale-95 transition-all"
          >
            demo
          </button>
        )}
      </div>

      {/* ONE scroller under the wordmark holds screens AND the tool cluster.
          The tools' mt-auto absorbs the slack at comfortable heights (they
          read as pinned to the bottom, as ever); once the two groups would
          meet, the margin is zero and the whole column scrolls as a single
          block — no measurement, the auto-margin does all the work. */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        <div className={cx("space-y-0.5 pb-2", collapsed ? "px-2" : "px-3")}>
          {visibleScreens.map(navItem)}
        </div>

        {/* mini player + settings at the bottom, collapse last.
            Commands + Mini player are hideable (right-click → Hide from left nav,
            un-hide from Settings); Settings is locked; Collapse is never hideable. */}
        <div className={cx("mt-auto space-y-0.5 pb-3", collapsed ? "px-2" : "px-3")}>
          {/* visible entry point for the palette — the shortcut teaches itself */}
          {!hiddenToolSet.has("commands") && (
            <button
              onClick={() => setPaletteOpen(true)}
              onContextMenu={openToolMenu("commands", "Commands")}
              {...navTipHandlers(`Command palette (${MOD}K)`)}
              aria-label={`Command palette (${MOD}K)`}
              className={cx(
                "w-full flex items-center rounded-lg h-9 text-[13.5px] text-dim hover:text-ink hover:bg-veil transition-colors",
                collapsed ? "justify-center px-0" : "gap-3 px-3",
              )}
            >
              <Command size={16} strokeWidth={1.8} className="shrink-0" />
              {!collapsed && (
                <span className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden whitespace-nowrap">
                  <span className="flex-1 text-left">Commands</span>
                  <span className="font-mono text-[9px] text-faint/60">{MOD}K</span>
                </span>
              )}
            </button>
          )}
          {!hiddenToolSet.has("mini-player") && (
            <button
              onClick={() => void tt.toggleMini()}
              onContextMenu={openToolMenu("mini-player", "Mini player")}
              {...navTipHandlers("Mini player")}
              aria-label="Mini player"
              className={cx(
                "w-full flex items-center rounded-lg h-9 text-[13.5px] text-dim hover:text-ink hover:bg-veil transition-colors",
                collapsed ? "justify-center px-0" : "gap-3 px-3",
              )}
            >
              <PictureInPicture2 size={16} strokeWidth={1.8} className="shrink-0" />
              {!collapsed && (
                <span className="flex-1 min-w-0 overflow-hidden whitespace-nowrap text-left">
                  Mini player
                </span>
              )}
            </button>
          )}
          {navItem(SETTINGS_SCREEN)}
          <button
            onClick={() => void toggleCollapsed()}
            {...navTipHandlers(collapsed ? "Expand menu" : "Collapse menu")}
            aria-label={collapsed ? "Expand menu" : "Collapse menu"}
            className={cx(
              "w-full flex items-center rounded-lg h-9 text-[13.5px] text-faint hover:text-dim hover:bg-veil transition-colors",
              collapsed ? "justify-center px-0" : "gap-3 px-3",
            )}
          >
            {collapsed ? (
              <PanelLeftOpen size={16} strokeWidth={1.8} className="shrink-0" />
            ) : (
              <PanelLeftClose size={16} strokeWidth={1.8} className="shrink-0" />
            )}
            {!collapsed && (
              <span className="flex-1 min-w-0 overflow-hidden whitespace-nowrap text-left">
                Collapse
              </span>
            )}
          </button>
        </div>
      </div>

      {menu && (
        <NavItemMenu menu={menu} onHide={() => hideFromMenu(menu)} onClose={() => setMenu(null)} />
      )}
      {collapsed &&
        navTip &&
        // z-50 = the app's menu tier (z-40 overlays, z-50 menus). Portaled to
        // <body>, so it still paints above same-tier siblings without inventing
        // a fourth stacking level that outranks every modal.
        createPortal(
          <div
            className="fixed z-50 pointer-events-none px-2 py-1 rounded-md bg-raised text-ink text-[11px] whitespace-nowrap ring-1 ring-edge2 shadow-[0_8px_24px_rgb(0_0_0_/_0.35)]"
            style={{ top: navTip.top, left: navTip.left, transform: "translateY(-50%)" }}
          >
            {navTip.label}
          </div>,
          document.body,
        )}
    </nav>
  );
}

/**
 * Right-click menu for a nav item — one verb, "Hide from left nav". PopoverCard
 * anchors it at the cursor, clamps it on-screen and mounts the popover chrome
 * (Escape-capture + inert drag regions, so the full-window click-catcher can
 * hear a click on the title-bar drag region at the top of the nav).
 */
function NavItemMenu({
  menu,
  onHide,
  onClose,
}: {
  menu: NavMenu;
  onHide(): void;
  onClose(): void;
}): React.JSX.Element {
  return (
    <PopoverCard
      at={menu}
      width="w-52"
      onClose={onClose}
      rightClickCloses
      className="p-1.5 space-y-0.5"
    >
      <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint truncate">{menu.label}</div>
      <button
        onClick={onHide}
        className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim hover:text-ink hover:bg-veil transition-colors"
      >
        <EyeOff size={14} strokeWidth={1.8} className="shrink-0" />
        Hide from left nav
      </button>
    </PopoverCard>
  );
}
