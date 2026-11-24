import { useEffect, useRef, useState } from "react";
import { Check, Maximize, Minimize, Sparkles } from "lucide-react";
import type { DisplayScene } from "@shared/model";
import { cx } from "@/lib/format";
import { SCENES_ORDERED, sceneDef } from "@/components/display/scenes";

/** How long the buttons stay after a touch. */
const SHOWN_MS = 4_000;

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

/**
 * THE PAGE'S SCENE PICKER (0.17.0, Display on other screens): a touch shows a scene button in the
 * corner, and the button opens the scenes by name, "Same as TastyTunes" first. Beside it, full
 * screen, where the browser lets a page have it (a page may ask only on a touch). Not the window's
 * picker: its live tiles are a graphics context each, more than a tablet's browser hands out
 * beside the stage, and its settings would change nothing the app keeps. Touch-sized (44px rows).
 */
export function ScenePanel({
  own,
  appScene,
  onPick,
}: {
  /** This screen's scene, or null when it shows the app's. */
  own: DisplayScene | null;
  appScene: DisplayScene;
  onPick(id: DisplayScene | null): void;
}): React.JSX.Element {
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // a touch anywhere (or the pointer moving, on a computer) shows the button for a while
  useEffect(() => {
    const show = (): void => {
      setShown(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setShown(false), SHOWN_MS);
    };
    window.addEventListener("pointerdown", show);
    window.addEventListener("pointermove", show);
    return () => {
      window.removeEventListener("pointerdown", show);
      window.removeEventListener("pointermove", show);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const chosen = sceneDef(own ?? appScene);
  const pick = (id: DisplayScene | null): void => {
    onPick(id);
    setOpen(false);
  };
  const row =
    "flex h-11 min-w-0 items-center gap-2.5 rounded-lg px-3 text-left text-[14px] transition-colors";
  const corner =
    "absolute top-4 z-50 flex h-11 w-11 items-center justify-center rounded-full bg-panel/85 ring-1 ring-edge backdrop-blur transition-opacity duration-300";
  const showing = shown || open ? "opacity-100" : "pointer-events-none opacity-0";
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
        aria-label="Scene"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(corner, "right-4", open ? "text-accent" : "text-dim", showing)}
      >
        <Sparkles size={20} />
      </button>
      {open && (
        <>
          {/* a touch outside closes it */}
          <div className="absolute inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            data-page-scenes
            className="absolute top-[4.25rem] right-4 z-50 w-[min(26rem,calc(100%_-_2rem))] max-h-[calc(100%_-_5.5rem)] overflow-y-auto rounded-2xl bg-panel/85 p-2 shadow-2xl ring-1 ring-edge backdrop-blur-md"
          >
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
            <div className="mt-1 grid grid-cols-2 gap-1 border-t border-edge pt-1">
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
            <div className="mt-1 border-t border-edge px-3 pt-2 pb-1 text-[12.5px] text-dim">
              <span className="text-ink">{chosen.label}</span> · {chosen.blurb}
            </div>
          </div>
        </>
      )}
    </>
  );
}
