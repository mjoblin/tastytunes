import { useEffect, useRef, useState } from "react";
import {
  ListMusic,
  Minus,
  Pause,
  Play,
  Plus,
  SkipBack,
  SkipForward,
  Square,
  X,
} from "lucide-react";
import type { DisplayVerb } from "@shared/displayControl";
import { transportAbilities } from "@shared/transport";
import { cx } from "@/lib/format";
import { onScreenKey } from "@/lib/keyboardOwner";
import { useStore } from "@/store";
import { Switch } from "@/components/controls/Switch";
import { MediaRow } from "@/components/media/MediaRow";
import { FACT_SEP } from "@/lib/mediaFacts";
import { scrollToVisible } from "@/lib/scroll";
import { SettingLine } from "@/components/display/ScenePicker";
import { steer, useControl } from "./control";
import { controlsLocked, lockControls } from "./pageSettings";

/**
 * CONTROLS ON THE OTHER SCREENS, THE PAGE'S HALF (0.17.0): previous, play or pause, and next, low
 * in the centre, shown at the same touch and for the same four seconds as the corner buttons
 * (display/touch: the first touch only shows them). They sit over the picture and never move it:
 * the picture dims a little while they show, a little more under them, so the discs read on any
 * scene and the screen says it is listening; the Sleeve's lyric line steps back until they go
 * (styles.css, .display-page[data-controls-shown]).
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
 * - THE QUEUE VIEW (step two, view and select): while the queue is what plays, a list button at the
 *   start of the row, and the next track's line, open the queue around the playing track (the
 *   display server sends allowed screens a window of it); a tap on a row plays that track. Nothing
 *   here adds, removes, reorders or clears. It opens only from its button, never from a swipe (a
 *   tap on a row jumps the music), and holds the buttons up while it is open.
 */

/** The dim's fade down as the buttons show, and back up as they go (the comment where it is drawn). */
export const DIM_IN = "opacity 600ms cubic-bezier(0.4, 0, 0.2, 1)";
export const DIM_OUT = "opacity 800ms cubic-bezier(0.65, 0, 0.35, 1)";

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
  scene,
  queueOpen,
  onQueue,
}: {
  /** The page's buttons show (display/touch). */
  shown: boolean;
  /** A scene is drawn under them (not the Sleeve): they sit inside the cathode glass's edge. */
  scene: boolean;
  /** The queue view is open (display/page holds the buttons up while it is). */
  queueOpen: boolean;
  onQueue(open: boolean): void;
}): React.JSX.Element | null {
  const control = useControl();
  const [lockedHere] = useLocked();
  const can = useAbilities();
  const playing = useStore((s) => s.playState?.state === "play");
  const usable = !lockedHere && (control.state === "ask" || control.state === "allowed");
  // the buttons' height, which the queue keeps above: two rows on a phone, the volume wrapping
  const strip = useRef<HTMLDivElement | null>(null);
  const [stripH, setStripH] = useState(112);
  useEffect(() => {
    const el = strip.current;
    if (!el || !queueOpen) return;
    const seen = new ResizeObserver(() => setStripH(el.offsetHeight));
    seen.observe(el);
    return () => seen.disconnect();
  }, [queueOpen]);
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
  const queue = control.queue;
  const bottom = scene
    ? "calc(env(safe-area-inset-bottom, 0px) + 2.5rem)"
    : "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)";
  return (
    <>
      {/* the picture dims while the buttons show, deepest under them; black in either theme (a
          light page dimmed toward its paper only washed out). Above Display mode's own layer (its
          root is fixed at z-40; drawn after it, the dim sits over it and under the buttons). The
          whole screen moves, so it moves
          slower than the app's small fades (140 to 300ms), which on a surface this size read as
          a blink: down over 0.6s from a gentle start; back up over 0.8s, after the buttons have
          gone, as a light coming back would */}
      <div
        aria-hidden
        data-page-dim
        className={cx(
          "pointer-events-none absolute inset-0 z-40 bg-gradient-to-t from-black/45 via-black/25 to-black/20",
          shown ? "opacity-100" : "opacity-0",
        )}
        style={{ transition: shown ? DIM_IN : DIM_OUT }}
      />
      {queue && queueOpen && (
        <QueuePanel
          rows={queue}
          bottom={`calc(${bottom} + ${stripH + 12}px)`}
          onClose={() => onQueue(false)}
        />
      )}
      <div
        ref={strip}
        data-page-transport={control.state}
        className={cx(
          "absolute inset-x-0 z-[46] flex flex-col items-center gap-1.5 px-4 transition-opacity duration-300 select-none",
          showing,
        )}
        // just above the bottom edge (and an iPad's home bar), inside the band the Sleeve keeps for
        // the lyric's two lines: higher, on a short screen under a browser's bars, the discs and
        // the next track met the format chips. Over a scene a little higher, inside the cathode
        // glass's curved bottom edge
        style={{ bottom }}
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
              // the next track's line opens the queue too: it grew out of it
              <button
                type="button"
                data-page-transport-next
                disabled={!queue}
                onClick={() => onQueue(!queueOpen)}
                className="max-w-[min(36rem,90vw)] truncate rounded-full bg-panel/75 px-3 py-0.5 text-[13px] text-dim backdrop-blur [-webkit-tap-highlight-color:transparent] enabled:active:scale-95 transition-transform"
              >
                <span className="text-faint">Next</span> {control.next.title}
                {control.next.artist && ` · ${control.next.artist}`}
              </button>
            )}
            <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-2">
              {anyButton && (
                <div className="flex items-center gap-2">
                  {queue && (
                    <Disc
                      label={queueOpen ? "Close the queue" : "Queue"}
                      size="side"
                      active={queueOpen}
                      onPress={() => onQueue(!queueOpen)}
                      attrs={{ "data-page-queue-button": "" }}
                    >
                      <ListMusic size={22} />
                    </Disc>
                  )}
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
  onPress,
  active = false,
  attrs,
  label,
  size,
  children,
}: {
  /** What it asks of the app; or `onPress`, for a button that acts on the page (the queue). */
  verb?: DisplayVerb;
  onPress?(): void;
  /** Its list is open (the queue's button). */
  active?: boolean;
  attrs?: Record<string, string>;
  label: string;
  size: "main" | "side";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      {...attrs}
      data-page-verb={verb}
      aria-label={label}
      aria-pressed={onPress ? active : undefined}
      onClick={() => (onPress ? onPress() : verb && void steer(verb))}
      className="group grid touch-manipulation place-items-center p-1 [-webkit-tap-highlight-color:transparent]"
    >
      <span
        className={cx(
          "grid place-items-center rounded-full shadow-lg ring-1 backdrop-blur transition-transform duration-100 group-active:scale-90 motion-reduce:transition-none",
          active ? "bg-accentdim text-accent ring-accent/50" : "bg-panel/85 text-ink ring-edge",
          size === "main" ? "h-[72px] w-[72px]" : "h-14 w-14",
        )}
      >
        {children}
      </span>
    </button>
  );
}

/**
 * THE QUEUE, VIEWED (step two): the window the display server sent, the playing track marked and
 * in view when it opens, each row the app's own (components/media/MediaRow, the menu bar panel's
 * queue rows: one home) at its full, finger-sized height. A tap plays that track; nothing edits.
 * Above the buttons, so play and pause stay in reach; a touch outside closes it.
 */
function QueuePanel({
  rows,
  bottom,
  onClose,
}: {
  rows: NonNullable<ReturnType<typeof useControl>["queue"]>;
  /** The top of the buttons: the panel keeps above them. */
  bottom: string;
  onClose(): void;
}): React.JSX.Element {
  const playingRow = useRef<HTMLDivElement | null>(null);
  // the playing track in view as it opens (container-scoped, never the page)
  useEffect(() => scrollToVisible(playingRow.current, 8), []);
  return (
    <>
      <div className="absolute inset-0 z-[45]" onClick={onClose} />
      <div
        data-page-queue
        className="absolute top-[4.25rem] left-1/2 z-50 flex w-[min(36rem,calc(100%_-_2rem))] -translate-x-1/2 flex-col rounded-2xl bg-panel/90 shadow-2xl ring-1 ring-edge backdrop-blur-md select-none"
        style={{ bottom }}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 py-1 pr-1 pl-4">
          <span className="text-[14px] text-ink">Queue</span>
          <button
            type="button"
            aria-label="Close the queue"
            onClick={onClose}
            className="grid h-11 w-11 place-items-center rounded-full text-dim motion-safe:active:scale-90 [-webkit-tap-highlight-color:transparent]"
          >
            <X size={20} />
          </button>
        </div>
        <div className="min-h-0 space-y-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {rows.map((r) => (
            <div key={r.id} ref={r.playing ? playingRow : undefined}>
              <MediaRow
                attrs={{ "data-page-queue-row": String(r.id) }}
                title={r.title}
                subtitle={[r.artist, r.album].filter(Boolean).join(FACT_SEP) || undefined}
                kind="track"
                artUrl={r.art}
                playing={r.playing}
                duration={r.duration}
                onClick={() => void steer("playQueue", r.id)}
              />
            </div>
          ))}
        </div>
      </div>
    </>
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
