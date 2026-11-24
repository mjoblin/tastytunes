import { useEffect, useState } from "react";
import { Check, Maximize, Minimize, SlidersHorizontal, Sparkles } from "lucide-react";
import type { DisplayScene } from "@shared/model";
import { cx } from "@/lib/format";
import { SCENES_ORDERED, sceneDef } from "@/components/display/scenes";
import { SyncRow } from "@/components/display/ScenePicker";
import { HeaderChip } from "@/components/chrome/Chrome";
import { ALL_SCENES_KEYS, ownSettings, type OwnKey } from "./pageSettings";

/** Full screen as this browser offers it to a page (Safari on an iPad, the desktop browsers), or
 *  null where it doesn't (a phone, a browser app that keeps the page in its frame). */
type Fs = { on(): boolean; enter(): void; exit(): void };
function fullScreen(): Fs | null {
  const d = document as Document & {
    webkitFullscreenEnabled?: boolean;
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => void;
  };
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (d.fullscreenEnabled && el.requestFullscreen)
    return {
      on: () => d.fullscreenElement != null,
      enter: () => void el.requestFullscreen().catch(() => {}),
      exit: () => void d.exitFullscreen().catch(() => {}),
    };
  if (d.webkitFullscreenEnabled && el.webkitRequestFullscreen)
    return {
      on: () => d.webkitFullscreenElement != null,
      enter: () => el.webkitRequestFullscreen?.(),
      exit: () => d.webkitExitFullscreen?.(),
    };
  return null;
}
const FS = typeof document !== "undefined" ? fullScreen() : null;

type Tab = "scene" | "settings";

/**
 * THE PAGE'S SCENE PICKER (0.17.0, Display on other screens): at a touch (display/touch) a scene
 * button shows in the corner, and opens a panel of two tabs. Scene: the scenes by name, "Same as
 * TastyTunes" first. Settings: the window's All scenes rows (the glass, Show, the drops, the
 * sync), sized for a finger, set for this screen alone until "Use TastyTunes' settings", and
 * anything else this screen keeps for itself (`extra`: its controls). The window's picker calls
 * them "All scenes" beside "Reading" and "This scene"; here, beside a scene's description, that
 * read as "show all the scenes". A screen that can't draw scenes opens Settings alone. Beside the
 * button, full screen, where the browser lets a page have it (a page may ask only on a touch).
 * Not the window's picker: its live tiles are a graphics context each, more than a tablet's
 * browser hands out beside the stage. Touch-sized (44px rows and controls, decisions/0007).
 */
export function ScenePanel({
  own,
  appScene,
  onPick,
  onAppSettings,
  scenes,
  shown,
  open,
  onOpen,
  onAwake,
  extra,
}: {
  /** This screen's scene, or null when it shows the app's. */
  own: DisplayScene | null;
  appScene: DisplayScene;
  onPick(id: DisplayScene | null): void;
  /** Let these settings go: the screen shows the app's again. */
  onAppSettings(keys: readonly OwnKey[]): void;
  /** Whether this browser draws the scenes: without them, the button opens Settings alone (the
   *  Show row; the rest shape scenes), and full screen stays. */
  scenes: boolean;
  /** Whether the page's buttons show (display/touch). */
  shown: boolean;
  open: boolean;
  onOpen(open: boolean): void;
  /** Whether the panel is in use (a touch in the last few seconds, or open): the page stays
   *  awake while it is, so a resting screen can be set up (display/rest). */
  onAwake(awake: boolean): void;
  /** More of this screen's own settings, under the scenes' (its controls' lock). */
  extra?: React.ReactNode;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("scene");
  const keptHere = ALL_SCENES_KEYS.some((k) => k in ownSettings());
  const [full, setFull] = useState(() => FS?.on() ?? false);
  useEffect(() => {
    if (!FS) return;
    const heard = (): void => setFull(FS.on());
    document.addEventListener("fullscreenchange", heard);
    document.addEventListener("webkitfullscreenchange", heard);
    return () => {
      document.removeEventListener("fullscreenchange", heard);
      document.removeEventListener("webkitfullscreenchange", heard);
    };
  }, []);
  useEffect(() => onAwake(shown || open), [shown, open, onAwake]);
  const chosen = sceneDef(own ?? appScene);
  const pick = (id: DisplayScene | null): void => {
    onPick(id);
    onOpen(false);
  };
  const showingTab: Tab = scenes ? tab : "settings";
  const row =
    "flex h-11 min-w-0 items-center gap-2.5 rounded-lg px-3 text-left text-[14px] transition-colors motion-safe:active:scale-[0.97]";
  const corner =
    "absolute top-4 z-50 flex h-11 w-11 items-center justify-center rounded-full bg-panel/85 ring-1 ring-edge backdrop-blur transition-opacity duration-300 motion-safe:active:scale-90";
  const showing = shown || open ? "opacity-100" : "pointer-events-none opacity-0";
  const tabClass = (on: boolean): string =>
    cx(
      "flex h-11 flex-1 items-center justify-center gap-2 rounded-md text-[14px] transition-colors motion-safe:active:scale-[0.97]",
      on ? "bg-accentdim text-accent" : "text-dim",
    );
  return (
    <>
      {FS && (
        <button
          type="button"
          data-page-fullscreen
          aria-label={full ? "Exit full screen" : "Full screen"}
          onClick={() => (full ? FS.exit() : FS.enter())}
          className={cx(corner, "right-[4.25rem] text-dim", showing)}
        >
          {full ? <Minimize size={20} /> : <Maximize size={20} />}
        </button>
      )}
      <button
        type="button"
        data-page-scene-button
        aria-label={scenes ? "Scene" : "Settings"}
        aria-expanded={open}
        onClick={() => onOpen(!open)}
        className={cx(corner, "right-4", open ? "text-accent" : "text-dim", showing)}
      >
        {scenes ? <Sparkles size={20} /> : <SlidersHorizontal size={20} />}
      </button>
      {open && (
        <>
          {/* a touch outside closes it */}
          <div className="absolute inset-0 z-40" onClick={() => onOpen(false)} />
          <div
            data-page-scenes
            className="absolute top-[4.25rem] right-4 z-50 flex max-h-[calc(100%_-_5.5rem)] w-[min(36rem,calc(100%_-_2rem))] flex-col rounded-2xl bg-panel/90 shadow-2xl ring-1 ring-edge backdrop-blur-md select-none"
          >
            {scenes && (
              <div className="shrink-0 p-2 pb-0">
                <div role="tablist" className="flex rounded-lg bg-veil p-0.5 ring-1 ring-edge">
                  <button
                    type="button"
                    role="tab"
                    data-page-scene-tab
                    aria-selected={tab === "scene"}
                    onClick={() => setTab("scene")}
                    className={tabClass(tab === "scene")}
                  >
                    <Sparkles size={14} />
                    Scene
                  </button>
                  <button
                    type="button"
                    role="tab"
                    data-page-settings
                    aria-selected={tab === "settings"}
                    onClick={() => setTab("settings")}
                    className={tabClass(tab === "settings")}
                  >
                    <SlidersHorizontal size={14} />
                    Settings
                  </button>
                </div>
              </div>
            )}
            <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
              {showingTab === "scene" && (
                <>
                  <button
                    type="button"
                    data-page-scene="app"
                    aria-pressed={own == null}
                    onClick={() => pick(null)}
                    className={cx(row, "w-full", own == null ? "bg-veil2 text-accent" : "text-ink")}
                  >
                    <span className="flex-1 truncate">
                      Same as TastyTunes
                      <span className="text-dim"> · {sceneDef(appScene).label}</span>
                    </span>
                    {own == null && <Check size={16} />}
                  </button>
                  <div className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-1 border-t border-edge pt-1">
                    {SCENES_ORDERED.map((s) => {
                      const active = own === s.id;
                      const Icon = s.icon;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          data-page-scene={s.id}
                          aria-pressed={active}
                          onClick={() => pick(s.id)}
                          className={cx(row, active ? "bg-veil2 text-accent" : "text-ink")}
                        >
                          <Icon size={16} className={active ? "" : "text-dim"} />
                          <span className="truncate">{s.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-1 border-t border-edge px-3 pt-2.5 pb-1 text-[13px] leading-snug text-dim">
                    <span className="text-ink">{chosen.label}</span> · {chosen.blurb}
                  </div>
                </>
              )}
              {showingTab === "settings" && (
                <div data-page-scene-settings className="px-3 pt-1 pb-1">
                  <SyncRow host="display" sleeveOnly={!scenes} touch />
                  {keptHere && (
                    <div className="border-t border-edge pt-3.5 pb-1">
                      <HeaderChip
                        type="button"
                        data-page-app-settings
                        onClick={() => onAppSettings(ALL_SCENES_KEYS)}
                        className="h-11 px-4 text-[14px] motion-safe:active:scale-95"
                      >
                        Use TastyTunes' settings
                      </HeaderChip>
                    </div>
                  )}
                  {extra}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
