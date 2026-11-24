import { useEffect, useState } from "react";
import { Minus, Pause, Play, Plus, SkipBack, SkipForward, Square } from "lucide-react";
import type { DisplayVerb } from "@shared/displayControl";
import { transportAbilities } from "@shared/transport";
import { cx } from "@/lib/format";
import { onScreenKey } from "@/lib/keyboardOwner";
import { useStore } from "@/store";
import { Switch } from "@/components/controls/Switch";
import { SettingLine } from "@/components/display/ScenePicker";
import { steer, useControl } from "./control";
import { controlsLocked, lockControls } from "./pageSettings";

/**
 * CONTROLS ON THE OTHER SCREENS, THE PAGE'S HALF (0.17.0): previous, play or pause, and next, low
 * in the centre, shown at the same touch and for the same four seconds as the corner buttons
 * (display/touch: the first touch only shows them). They sit over the picture and never move it:
 * the Sleeve's lyric line steps back while they show, and over a scene a soft shade in the panel's
 * colour keeps the discs readable (styles.css, .display-page[data-controls-shown]).
 *
 * - A screen draws only what it may do: nothing while the app's switch is off or this screen was
 *   turned down, and only the buttons the source offers (shared/transport, the window's own
 *   rule); Stop in pause's place where a source can stop and not pause. A screen not yet allowed
 *   draws them, and its first tap asks in the app; while asked, it says it is waiting.
 * - The volume, with its own switch in the app: minus and plus, one step for one tap, sent on
 *   release and never repeated on a timer; drawn only where the streamer has a volume to change.
 * - Keys act with the buttons hidden: Space plays or pauses, Left and Right (and a presentation
 *   clicker's Page Up and Page Down) go back and on. A TV remote's play and pause keys too, where
 *   its browser passes them on. No single-letter keys, no volume keys, a held key never repeats.
 * - Locked (this screen's Settings), a touch shows only the corner buttons, and keys do nothing.
 */

/** A TV remote's media keys, by the codes their browsers send. */
const TOGGLE_CODES = new Set([179, 10252]);
const PLAY_CODES = new Set([415]);
const PAUSE_CODES = new Set([19]);

function keyVerb(e: KeyboardEvent): DisplayVerb | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === " " || e.key === "MediaPlayPause" || TOGGLE_CODES.has(e.keyCode)) return "toggle";
  if (e.key === "MediaPlay" || PLAY_CODES.has(e.keyCode)) return "play";
  if (e.key === "MediaPause" || PAUSE_CODES.has(e.keyCode)) return "pause";
  if (e.key === "ArrowLeft" || e.key === "PageUp") return "previous";
  if (e.key === "ArrowRight" || e.key === "PageDown") return "next";
  return null;
}

/** Whether the screen's lock is on, as a hook (kept in the browser, display/pageSettings). */
let locked = controlsLocked();
const lockHeard = new Set<() => void>();
export function useLocked(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(locked);
  useEffect(() => {
    const l = (): void => setOn(locked);
    lockHeard.add(l);
    return () => void lockHeard.delete(l);
  }, []);
  return [
    on,
    (next) => {
      locked = next;
      lockControls(next);
      for (const l of lockHeard) l();
    },
  ];
}

/** What the buttons are for this source, from its controls list. */
function useAbilities(): ReturnType<typeof transportAbilities> {
  const controls = useStore((s) => s.nowPlaying?.controls);
  const duration = useStore((s) => s.playState?.metadata?.duration ?? null);
  return transportAbilities(controls, duration);
}

export function PageTransport({
  shown,
  shade,
}: {
  /** The page's buttons show (display/touch). */
  shown: boolean;
  /** A scene is drawn under them: a soft shade keeps the discs readable on a bright one. */
  shade: boolean;
}): React.JSX.Element | null {
  const control = useControl();
  const [lockedHere] = useLocked();
  const can = useAbilities();
  const playing = useStore((s) => s.playState?.state === "play");
  const usable = !lockedHere && (control.state === "ask" || control.state === "allowed");
  // the keys, with the buttons hidden too
  useEffect(() => {
    if (!usable) return;
    return onScreenKey((e) => {
      const verb = keyVerb(e);
      if (!verb) return;
      e.preventDefault();
      if (e.repeat) return;
      void steer(verb);
    });
  }, [usable]);
  if (lockedHere || control.state === "off" || control.state === "declined") return null;
  const asking = control.state === "asking";
  const anyButton = can.canPrev || can.canToggle || can.canStop || can.canNext;
  const vol = control.volume;
  const level = vol?.percent ?? vol?.step ?? null;
  const showing = shown ? "opacity-100" : "pointer-events-none opacity-0";
  return (
    <>
      {shade && (
        <div
          aria-hidden
          data-page-transport-shade
          className={cx(
            "pointer-events-none absolute inset-x-0 bottom-0 z-30 h-72 bg-gradient-to-t from-panel/90 via-panel/55 to-transparent transition-opacity duration-300",
            shown ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      <div
        data-page-transport={control.state}
        className={cx(
          "absolute inset-x-0 z-40 flex flex-col items-center gap-1.5 px-4 transition-opacity duration-300 select-none",
          showing,
        )}
        // just above the bottom edge (and an iPad's home bar), inside the band the Sleeve keeps for
        // the lyric's two lines: higher, on a short screen under a browser's bars, the discs and
        // the next track met the format chips. Over a scene a little higher, inside the cathode
        // glass's curved bottom edge
        style={{
          bottom: shade
            ? "calc(env(safe-area-inset-bottom, 0px) + 2.5rem)"
            : "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)",
        }}
      >
        {asking ? (
          <div
            data-page-transport-asking
            className="rounded-full bg-panel/90 px-4 py-2.5 text-[14px] text-ink ring-1 ring-edge backdrop-blur"
          >
            Waiting for TastyTunes to allow this screen.
          </div>
        ) : (
          <>
            {control.next && (
              <div
                data-page-transport-next
                className="max-w-[min(36rem,90vw)] truncate rounded-full bg-panel/75 px-3 py-0.5 text-[13px] text-dim backdrop-blur"
              >
                <span className="text-faint">Next</span> {control.next.title}
                {control.next.artist && ` · ${control.next.artist}`}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-2">
              {anyButton && (
                <div className="flex items-center gap-2">
                  {can.canPrev && (
                    <Disc verb="previous" label="Previous" size="side">
                      <SkipBack size={24} fill="currentColor" />
                    </Disc>
                  )}
                  {can.canToggle ? (
                    <Disc verb="toggle" label={playing ? "Pause" : "Play"} size="main">
                      {playing ? (
                        <Pause size={32} fill="currentColor" />
                      ) : (
                        <Play size={32} fill="currentColor" className="translate-x-0.5" />
                      )}
                    </Disc>
                  ) : can.canStop ? (
                    // a source that can stop and not pause (a stream): Stop in pause's place
                    <Disc verb="stop" label="Stop" size="main">
                      <Square size={26} fill="currentColor" />
                    </Disc>
                  ) : null}
                  {can.canNext && (
                    <Disc verb="next" label="Next" size="side">
                      <SkipForward size={24} fill="currentColor" />
                    </Disc>
                  )}
                </div>
              )}
              {vol && (
                <div data-page-volume className="flex items-center gap-1">
                  <Disc verb="volumeDown" label="Volume down" size="side">
                    <Minus size={22} />
                  </Disc>
                  {level != null && (
                    <span
                      data-page-volume-level
                      className="w-10 text-center font-mono text-[15px] tabular-nums text-ink"
                    >
                      {level}
                    </span>
                  )}
                  <Disc verb="volumeUp" label="Volume up" size="side">
                    <Plus size={22} />
                  </Disc>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** One of the page's round buttons: 72px in the centre, 56px beside it, its touch target a little
 *  larger than the disc. A press shows at once (decisions/0007); the verb goes on release. */
function Disc({
  verb,
  label,
  size,
  children,
}: {
  verb: DisplayVerb;
  label: string;
  size: "main" | "side";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-page-verb={verb}
      aria-label={label}
      onClick={() => void steer(verb)}
      className="group grid touch-manipulation place-items-center p-1 [-webkit-tap-highlight-color:transparent]"
    >
      <span
        className={cx(
          "grid place-items-center rounded-full bg-panel/85 text-ink shadow-lg ring-1 ring-edge backdrop-blur transition-transform duration-100 group-active:scale-90 motion-reduce:transition-none",
          size === "main" ? "h-[72px] w-[72px]" : "h-14 w-14",
        )}
      >
        {children}
      </span>
    </button>
  );
}

/** The page's Settings row for its controls: the lock, and where this screen stands. */
export function ControlsSetting(): React.JSX.Element | null {
  const control = useControl();
  const [lockedHere, setLocked] = useLocked();
  if (control.state === "off") return null;
  const hint =
    control.state === "declined"
      ? "TastyTunes didn't allow this screen. It can be allowed in TastyTunes, in Settings › Integrations."
      : control.state === "asking"
        ? "Waiting for TastyTunes to allow this screen."
        : control.state === "ask"
          ? "The first tap on a button asks TastyTunes to allow this screen."
          : "Locked, a touch shows only these settings and full screen.";
  return (
    <div data-page-controls-setting className="border-t border-edge text-[14px] text-dim">
      <SettingLine touch label="Controls" hint={hint}>
        <label className="flex items-center gap-2.5">
          <Switch size="lg" checked={lockedHere} onChange={setLocked} />
          Lock
        </label>
      </SettingLine>
    </div>
  );
}
