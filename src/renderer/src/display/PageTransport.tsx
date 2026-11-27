import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  LayoutGrid,
  List,
  Minus,
  Moon,
  Pause,
  Play,
  Plus,
  Power,
  SkipBack,
  SkipForward,
  Square,
  X,
} from "lucide-react";
import type {
  DisplayControlAnswer,
  DisplayPlaylistRow,
  DisplayPresetRow,
  DisplayQueueRow,
  DisplaySleep,
} from "@shared/displayControl";
import { transportAbilities, type TransportAbilities } from "@shared/transport";
import { cx, fmtDuration } from "@/lib/format";
import { useFadePresence } from "@/hooks/useFadePresence";
import { screenIcon } from "@/lib/screens";
import { onScreenKey } from "@/lib/keyboardOwner";
import { useStore } from "@/store";
import { Switch } from "@/components/controls/Switch";
import { MediaRow } from "@/components/media/MediaRow";
import { TtMark } from "@/components/chrome/TtMark";
import { FACT_SEP } from "@/lib/mediaFacts";
import { scrollToTop } from "@/lib/scroll";
import { MediaTile } from "@/components/media/MediaTile";
import { SettingLine } from "@/components/display/ScenePicker";
import { PageSeekBar } from "@/components/media/Waveform";
import {
  appNow,
  playPlaylist,
  seekTo,
  sleepIn,
  steer,
  useControl,
  wasDone,
  type ButtonVerb,
} from "./control";
import { whyDark } from "./dark";
import { dropWhenAway, holdPress, RING_BACK_MS, STANDBY_HOLD_MS, type HoldPress } from "./hold";
import {
  badgeChangesIn,
  sheetPlace,
  sleepBadge,
  sleepChoices,
  sleepCountdown,
  sleepRefused,
  sleepThen,
} from "./sleepTimer";
import { musicGoing } from "./rest";
import { PageTabs } from "./PageTabs";
import { onControl } from "./touch";
import {
  controlsLocked,
  keepListView,
  listView,
  lockControls,
  type ListTab,
  type ListView,
} from "./pageSettings";

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
 * - PRESETS AND WAKE (step three, with their own switch in the app): the presets beside the queue,
 *   as tabs in the one list (Presets alone where there is no queue, a station playing or the
 *   streamer asleep); a tap plays that preset, shows it tuning, and the row says so when the
 *   recall came to nothing. While the streamer sleeps the page is black, and a touch brings up,
 *   low where the buttons always are, a line saying why, Wake, the presets, and "Pick up where
 *   you left off" when there is something to return to, with the TastyTunes mark faint in the
 *   middle (SleepControls). Wake only where a wake can work; in Eco standby, the line says the
 *   streamer is out of reach.
 * - SEEK (step four), on an allowed screen where the source can seek: above the buttons, Display's
 *   strip raised from the bottom edge to a finger's height (components/media/Waveform's
 *   PageSeekBar), one seek for each lift of a finger. At rest the strip at the edge stays a
 *   picture.
 * - STANDBY AND THE SLEEP TIMER (with Presets, playlists and power, while the streamer is on): a
 *   moon and a power disc at the end of the row, as in the window's playback bar. Power puts the
 *   streamer in standby only for a press held STANDBY_HOLD_MS (display/hold), a ring filling round
 *   it over the hold, and sent as the finger lifts; a shorter press says how, in a line above the
 *   buttons, and a press that ends any other way sends nothing. No key does it. The
 *   moon opens a sheet above it to set the app's own sleep timer (display/sleepTimer); armed, the
 *   moon is lit with the minutes left over it. The sheet and the list are never open together.
 */

/** The dim's fade down as the buttons show, and back up as they go (the comment where it is drawn). */
export const DIM_IN = "opacity 600ms cubic-bezier(0.4, 0, 0.2, 1)";
export const DIM_OUT = "opacity 800ms cubic-bezier(0.65, 0, 0.35, 1)";

/** A TV remote's media keys, by the codes their browsers send. */
const TOGGLE_CODES = new Set([179, 10252]);
const PLAY_CODES = new Set([415]);
const PAUSE_CODES = new Set([19]);

function keyVerb(e: KeyboardEvent): ButtonVerb | null {
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

/** How long a button the source stops offering stays drawn: a skip passes through the streamer's
 *  buffering for 300 to 600 ms with pause and seek dropped from its controls (docs/streamer.md),
 *  and the page drew the play button and the seek bar out and back in for it. */
const ABILITY_SETTLE_MS = 1_200;
const ABILITIES = [
  "canToggle",
  "canPrev",
  "canNext",
  "canSeek",
  "canShuffle",
  "canRepeat",
  "canStop",
] as const satisfies readonly (keyof TransportAbilities)[];

/** What the buttons are for this source, from its controls list, steady through a change: a button
 *  the source starts offering shows at once, one it stops offering goes only once that has lasted
 *  ABILITY_SETTLE_MS (a lost one past it is gone; main refuses a verb the source can't do). */
function useAbilities(): TransportAbilities {
  const controls = useStore((s) => s.nowPlaying?.controls);
  const duration = useStore((s) => s.playState?.metadata?.duration ?? null);
  const now = transportAbilities(controls, duration);
  const nowKey = ABILITIES.map((k) => (now[k] ? "1" : "0")).join("");
  const [heldKey, setHeldKey] = useState(nowKey);
  useEffect(() => {
    // gains at once, losses later
    setHeldKey((h) => [...nowKey].map((c, i) => (c === "1" || h[i] === "1" ? "1" : "0")).join(""));
    const t = setTimeout(() => setHeldKey(nowKey), ABILITY_SETTLE_MS);
    return () => clearTimeout(t);
  }, [nowKey]);
  return Object.fromEntries(
    ABILITIES.map((k, i) => [k, heldKey[i] === "1"]),
  ) as unknown as TransportAbilities;
}

export function PageTransport({
  shown,
  queueOpen,
  onQueue,
  sleepOpen,
  onSleep,
}: {
  /** The page's buttons show (display/touch). */
  shown: boolean;
  /** The queue view is open (display/page holds the buttons up while it is). */
  queueOpen: boolean;
  onQueue(open: boolean): void;
  /** The sleep timer's sheet is open (held like the list, never open with it). */
  sleepOpen: boolean;
  onSleep(open: boolean): void;
}): React.JSX.Element | null {
  const control = useControl();
  const [lockedHere] = useLocked();
  const can = useAbilities();
  // pause stays pause through a skip's buffering (the music is still going: display/rest)
  const playing = useStore((s) => musicGoing(s.playState?.state));
  const usable = !lockedHere && (control.state === "ask" || control.state === "allowed");
  // the buttons' height, which the list keeps above: two rows on a phone, the volume wrapping
  const strip = useRef<HTMLDivElement | null>(null);
  const stripH = useHeightWhile(strip, queueOpen || sleepOpen);
  // the sleep timer's sheet, above the moon it opens from, rising and dropping as the list does
  const moon = useRef<HTMLButtonElement | null>(null);
  const sheetAt = useSheetPlace(moon, strip, sleepOpen);
  const sleepFade = useFadePresence(sleepOpen && control.sleep != null, { rise: true });
  // the line above the buttons: what a press on power is doing, and a standby or a sleep timer
  // choice the app didn't do
  const [hint, say] = useLine();
  // the list fades in rising and out dropping, as a panel seen from across a room does
  const listFade = useFadePresence(
    queueOpen && (control.queue != null || control.presets != null || control.playlists != null),
    { rise: true },
  );
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
  const vol = control.volume;
  const level = vol?.percent ?? vol?.step ?? null;
  const showing = shown ? "opacity-100" : "pointer-events-none opacity-0";
  const queue = control.queue;
  const presets = control.presets;
  const playlists = control.playlists;
  const list = queue != null || presets != null || playlists != null;
  const sleep = control.sleep;
  // over a scene a little higher (styles.css, --page-transport-lift)
  const bottom = "calc(env(safe-area-inset-bottom, 0px) + var(--page-transport-lift, 0.75rem))";
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
      {list && listFade.mounted && (
        <ListPanel
          queue={queue}
          presets={presets}
          playlists={playlists}
          bottom={`calc(${bottom} + ${stripH + 12}px)`}
          open={queueOpen}
          faded={listFade.faded}
          onClose={() => onQueue(false)}
        />
      )}
      {sleep && sleepFade.mounted && (
        <SleepSheet
          sleep={sleep}
          bottom={`calc(${bottom} + ${stripH + 12}px)`}
          at={sheetAt}
          open={sleepOpen}
          faded={sleepFade.faded}
          onClose={() => onSleep(false)}
          onRefused={(text) => say(text, PASSING_LINE_MS)}
        />
      )}
      <div
        ref={strip}
        data-page-transport={control.state}
        // the strip spans the screen above the list's and the sheet's catcher: a touch on it that
        // isn't on one of its controls closes them too, as one anywhere else outside them does
        onClick={(e) => {
          if (!(queueOpen || sleepOpen) || onControl(e.target)) return;
          onQueue(false);
          onSleep(false);
        }}
        className={cx(
          "absolute inset-x-0 z-[46] flex flex-col items-center gap-1.5 px-4 transition-opacity duration-300 select-none",
          showing,
        )}
        // just above the bottom edge (and an iPad's home bar), inside the band the Sleeve keeps for
        // the lyric's two lines: higher, on a short screen under a browser's bars, the discs and
        // the next track met the format chips. Over a scene that draws a little higher, inside the
        // cathode glass's curved bottom edge
        style={{ bottom }}
      >
        {/* what a press on power is doing, or a choice the app didn't do, just above the buttons
            and out of their flow, so the list above them never moves for it */}
        <div
          aria-live="polite"
          className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2"
        >
          {hint && (
            <div
              data-page-hold-hint
              className="whitespace-nowrap rounded-full bg-panel/75 px-3 py-0.5 text-[13px] text-dim backdrop-blur"
            >
              {hint}
            </div>
          )}
        </div>
        {asking ? (
          <div
            data-page-transport-asking
            className="rounded-full bg-panel/90 px-4 py-2.5 text-[14px] text-ink ring-1 ring-edge backdrop-blur"
          >
            Waiting for TastyTunes to allow this screen{control.code && ` (code ${control.code})`}.
          </div>
        ) : (
          <>
            {control.state === "ask" && (
              // a screen not yet allowed has the buttons (its first tap asks), but the queue and
              // the presets go only to an allowed one: it says so, where the next track will be
              <div
                data-page-transport-allow
                className="mb-1.5 max-w-[min(36rem,90vw)] truncate rounded-full bg-panel/75 px-3 py-0.5 text-[13px] text-dim backdrop-blur"
              >
                Allow this screen in TastyTunes to see the queue and presets.
              </div>
            )}
            {control.next && (
              // the next track's line opens the queue too: it grew out of it
              <button
                type="button"
                data-page-transport-next
                disabled={!queue}
                onClick={() => onQueue(!queueOpen)}
                className="mb-1.5 max-w-[min(36rem,90vw)] truncate rounded-full bg-panel/75 px-3 py-0.5 text-[13px] text-dim backdrop-blur [-webkit-tap-highlight-color:transparent] enabled:active:scale-95 transition-transform"
              >
                {/* the word set apart from the track it names, 10px on */}
                <span className="mr-2.5 text-faint">Next</span>
                {control.next.title}
                {control.next.artist && ` · ${control.next.artist}`}
              </button>
            )}
            {control.state === "allowed" && can.canSeek && (
              // SEEK (step four): the strip at the bottom edge, raised above the buttons to meet
              // the finger. Above them, not below: low on an iPad a sideways drag is the system's
              // (it switches apps, and the page never hears the finger lift), while the buttons
              // only take taps, which reach the page there
              <PageSeekBar live={shown} onSeek={async (secs) => wasDone(await seekTo(secs))} />
            )}
            <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-2">
              {/* the list stands apart from the transport by the same gap as the volume does */}
              {list && (
                <Disc
                  label={
                    queueOpen
                      ? "Close the list"
                      : queue
                        ? "Queue"
                        : presets
                          ? "Presets"
                          : "Playlists"
                  }
                  size="side"
                  active={queueOpen}
                  onPress={() => onQueue(!queueOpen)}
                  attrs={{ "data-page-queue-button": "" }}
                >
                  {queue ? (
                    <QueueIcon size={22} />
                  ) : presets ? (
                    <PresetsIcon size={22} />
                  ) : (
                    <PlaylistsIcon size={22} />
                  )}
                </Disc>
              )}
              {/* previous, play or pause, and next always in their places, a disc the source can't
                  use now dimmed, so the row never shifts as the streamer's abilities come and go */}
              <div className="flex items-center gap-2">
                <Disc verb="previous" label="Previous" size="side" disabled={!can.canPrev}>
                  <SkipBack size={24} fill="currentColor" />
                </Disc>
                {!can.canToggle && can.canStop ? (
                  // a source that can stop and not pause (a stream): Stop in pause's place
                  <Disc verb="stop" label="Stop" size="main">
                    <Square size={26} fill="currentColor" />
                  </Disc>
                ) : (
                  <Disc
                    verb="toggle"
                    label={playing ? "Pause" : "Play"}
                    size="main"
                    disabled={!can.canToggle}
                  >
                    {playing ? (
                      <Pause size={32} fill="currentColor" />
                    ) : (
                      <Play size={32} fill="currentColor" className="translate-x-0.5" />
                    )}
                  </Disc>
                )}
                <Disc verb="next" label="Next" size="side" disabled={!can.canNext}>
                  <SkipForward size={24} fill="currentColor" />
                </Disc>
              </div>
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
              {/* the sleep timer and standby at the end, as in the window's playback bar */}
              {(sleep || control.standby) && (
                <div data-page-power className="flex items-center gap-2">
                  {sleep && (
                    <Disc
                      label={sleepOpen ? "Close the sleep timer" : "Sleep timer"}
                      size="side"
                      active={sleepOpen}
                      lit={sleepOpen || sleep.armed != null}
                      onPress={() => onSleep(!sleepOpen)}
                      buttonRef={moon}
                      attrs={{ "data-page-sleep-button": "" }}
                    >
                      <Moon size={22} />
                      {sleep.armed && (
                        <SleepBadge
                          key={String(sleep.armed.firesAt)}
                          firesAt={sleep.armed.firesAt}
                        />
                      )}
                    </Disc>
                  )}
                  {control.standby && <PowerDisc live={shown} say={say} />}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** A disc's button: its touch target a little larger than the disc. */
const DISC_BUTTON =
  "group grid touch-manipulation place-items-center p-1 [-webkit-tap-highlight-color:transparent]";
/** The power disc's button: a disc's, but a finger on it is never the browser's to pan with, so one
 *  that drifts during the hold doesn't end it (touch-none in place of touch-manipulation). */
const HOLD_BUTTON =
  "group grid touch-none place-items-center p-1 [-webkit-tap-highlight-color:transparent]";

/** A disc's face: 72px in the centre, 56px beside it, lit while what it opens is open. */
const discFace = (size: "main" | "side", lit: boolean, off = false): string =>
  cx(
    "relative grid place-items-center rounded-full shadow-lg ring-1 backdrop-blur transition-transform duration-100 group-active:scale-90 motion-reduce:transition-none",
    lit ? "bg-accentdim text-accent ring-accent/50" : "bg-panel/85 text-ink ring-edge",
    size === "main" ? "h-[72px] w-[72px]" : "h-14 w-14",
    // a disc that can't act now keeps its place, dimmed, so the others never move round it
    off && "opacity-40 group-active:scale-100",
  );

/** One of the page's round buttons. A press shows at once (decisions/0007); the verb goes on
 *  release. */
function Disc({
  verb,
  onPress,
  active = false,
  lit = active,
  attrs,
  buttonRef,
  label,
  size,
  disabled = false,
  children,
}: {
  /** What it asks of the app; or `onPress`, for a button that acts on the page (the queue). */
  verb?: ButtonVerb;
  onPress?(): void;
  /** What it opens is open (the list's button, the moon's). */
  active?: boolean;
  /** Drawn lit: while open, and for the moon while the timer is armed too. */
  lit?: boolean;
  attrs?: Record<string, string>;
  buttonRef?: React.Ref<HTMLButtonElement>;
  label: string;
  size: "main" | "side";
  /** It can't act now (the source offers no previous track, say): drawn dimmed in its place. */
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      ref={buttonRef}
      {...attrs}
      data-page-verb={verb}
      aria-label={label}
      aria-pressed={onPress ? active : undefined}
      disabled={disabled}
      onClick={() => (onPress ? onPress() : verb && void steer(verb))}
      className={DISC_BUTTON}
    >
      <span className={discFace(size, lit, disabled)}>{children}</span>
    </button>
  );
}

/** What the line above the buttons says while power is held, once the hold is full, and after a
 *  press too short. */
const HOLDING_HINT = "Keep holding for standby";
const LET_GO_HINT = "Let go for standby";
const SHORT_HINT = "Hold to put the streamer in standby";
/** What it says when the app didn't put the streamer in standby. */
const STANDBY_REFUSED = "TastyTunes couldn't put the streamer in standby.";

/** How long a passing line above the buttons stays: the hint after a short press, a standby or a
 *  sleep timer choice the app didn't do (the sheet's own, display/sleepTimer sleepRefused). */
const PASSING_LINE_MS = 2_000;

/** Says `text` in the line above the buttons, for `ms` or until the next word (null: nothing). */
type Say = (text: string | null, ms?: number) => void;

/** The line above the buttons: one thing at a time, a word replacing the one before and its time. */
function useLine(): [string | null, Say] {
  const [line, setLine] = useState<string | null>(null);
  const goes = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback<Say>((text, ms) => {
    if (goes.current) clearTimeout(goes.current);
    goes.current = null;
    setLine(text);
    if (text != null && ms != null) goes.current = setTimeout(() => setLine(null), ms);
  }, []);
  useEffect(
    () => () => {
      if (goes.current) clearTimeout(goes.current);
    },
    [],
  );
  return [line, say];
}

/** The hold ring's circle: 3px, just outside the disc's edge, in a box 5px wider all round. */
const RING_R = 30.5;
const RING_LENGTH = 2 * Math.PI * RING_R;
type RingPhase = "rest" | "filling" | "full" | "back";

/**
 * STANDBY, BY A HOLD: the window's own standby (network standby, so the screen's Wake brings the
 * streamer back), sent only as the finger lifts from a press that has lasted STANDBY_HOLD_MS, the
 * ring full round the disc and the line above saying to let go. A press let go before it sends
 * nothing, the ring going back and the line above saying how; so does a full one that never lifts
 * on the disc: a finger or pointer leaving it, the page hidden or behind another window
 * (display/hold), or the buttons gone (`live`: a lift the page never heard, let go by the page's
 * minute, display/touch). No click and no key sends it. The press is the finger's own
 * (display/touch keeps a press that only shows the buttons from it whole, as the seek bar's).
 */
function PowerDisc({ live, say }: { live: boolean; say: Say }): React.JSX.Element {
  const [ring, setRing] = useState<RingPhase>("rest");
  const press = useRef<HoldPress | null>(null);
  useEffect(() => {
    const held = holdPress(STANDBY_HOLD_MS, {
      full: () => {
        setRing("full");
        say(LET_GO_HINT);
      },
      held: () => {
        // the ring lets go with the finger
        setRing("rest");
        say(null);
        void steer("standby").then((answer) => {
          if (!wasDone(answer)) say(STANDBY_REFUSED, PASSING_LINE_MS);
        });
      },
      short: () => {
        setRing("back");
        say(SHORT_HINT, PASSING_LINE_MS);
      },
      dropped: () => {
        setRing("back");
        say(null);
      },
    });
    press.current = held;
    const unwatch = dropWhenAway(held);
    return () => {
      unwatch();
      held.stop();
      say(null);
    };
  }, [say]);
  useEffect(() => {
    if (!live) press.current?.drop();
  }, [live]);
  return (
    <button
      type="button"
      data-page-hold="standby"
      aria-label="Standby"
      onPointerDown={(e) => {
        if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
        // a finger is held to the control it went down on: let go, so leaving the disc ends the
        // press for a finger as it does for a pointer
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        say(HOLDING_HINT);
        setRing("filling");
        press.current?.down();
      }}
      onPointerUp={() => press.current?.lift()}
      onPointerLeave={() => press.current?.leave()}
      onPointerCancel={() => press.current?.leave()}
      // a long press is a menu's or a callout's on some tablets
      onContextMenu={(e) => e.preventDefault()}
      className={cx(HOLD_BUTTON, "[-webkit-touch-callout:none]")}
    >
      <span className={discFace("side", false)}>
        <Power size={22} />
        <svg
          aria-hidden
          viewBox="0 0 66 66"
          className="pointer-events-none absolute -top-[5px] -left-[5px] h-[66px] w-[66px] -rotate-90 text-accent"
        >
          <circle
            cx="33"
            cy="33"
            r={RING_R}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={ring === "filling" || ring === "full" ? 0 : RING_LENGTH}
            style={{
              transition:
                ring === "filling"
                  ? `stroke-dashoffset ${STANDBY_HOLD_MS}ms linear`
                  : ring === "back"
                    ? `stroke-dashoffset ${RING_BACK_MS}ms ease-out`
                    : "none",
            }}
          />
        </svg>
      </span>
    </button>
  );
}

/** The minutes left on the moon, over its top edge, changing once a minute (keyed by when the
 *  timer runs out, so a timer armed again starts from now). Counted by the app's clock, as the
 *  timer runs (display/control appNow). */
function SleepBadge({ firesAt }: { firesAt: number | null }): React.JSX.Element {
  const [now, setNow] = useState(() => appNow());
  useEffect(() => {
    if (firesAt == null) return;
    const t = setTimeout(() => setNow(appNow()), badgeChangesIn(firesAt, now));
    return () => clearTimeout(t);
  }, [firesAt, now]);
  return (
    <span
      data-page-sleep-badge
      className="pointer-events-none absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-panel px-1.5 py-[3px] font-mono text-[11px] font-semibold leading-none tabular-nums text-accent ring-1 ring-accent/50"
    >
      {sleepBadge(firesAt, now)}
    </span>
  );
}

/** The time left, by the second while the sheet shows it (keyed as the badge is, and counted by
 *  the app's clock as it is). */
function SleepCountdown({ firesAt }: { firesAt: number | null }): React.JSX.Element {
  const [now, setNow] = useState(() => appNow());
  useEffect(() => {
    if (firesAt == null) return;
    const t = setInterval(() => setNow(appNow()), 1000);
    return () => clearInterval(t);
  }, [firesAt]);
  return (
    <div
      data-page-sleep-countdown
      className="mt-1.5 font-mono text-[30px] leading-none font-semibold tabular-nums text-accent"
    >
      {sleepCountdown(firesAt, now)}
    </div>
  );
}

/** The sheet's place, over the moon and inside the screen (display/sleepTimer sheetPlace):
 *  measured as it opens and again when the screen changes size. */
function useSheetPlace(
  anchor: React.RefObject<HTMLButtonElement | null>,
  box: React.RefObject<HTMLDivElement | null>,
  on: boolean,
): { left: number; width: number } | null {
  const [at, setAt] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!on) return;
    const place = (): void => {
      const a = anchor.current?.getBoundingClientRect();
      const b = box.current?.getBoundingClientRect();
      if (a && b) setAt(sheetPlace(a.left + a.width / 2 - b.left, b.width));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, box, on]);
  return at;
}

/** A choice on the sheet: large enough for a finger across a room. */
const SHEET_CHIP =
  "h-12 rounded-xl bg-veil text-[15px] text-ink ring-1 ring-edge motion-safe:transition-transform motion-safe:active:scale-95 [-webkit-tap-highlight-color:transparent]";

/**
 * THE SLEEP TIMER'S SHEET: above the moon, the list panel's surface. Not armed, the window's
 * lengths and End of track (where the window offers it); armed, the time left and Cancel the
 * timer. Either way, what the app will do then, by its own setting. A tap on a choice sends it
 * and closes the sheet, and a choice the app didn't do (End of track no longer offered, the rate
 * cap) is said in the line above the buttons; a touch outside closes it.
 */
function SleepSheet({
  sleep,
  bottom,
  at,
  open,
  faded,
  onClose,
  onRefused,
}: {
  sleep: DisplaySleep;
  /** The top of the buttons: the sheet keeps above them. */
  bottom: string;
  /** Its place across the screen, once measured. */
  at: { left: number; width: number } | null;
  open: boolean;
  faded: string;
  onClose(): void;
  /** A choice the app didn't do, in words. */
  onRefused(text: string): void;
}): React.JSX.Element {
  const choose = (
    verb: "sleep" | "sleepCancel",
    send: () => Promise<DisplayControlAnswer | null>,
  ): void => {
    void send().then((answer) => {
      const refused = sleepRefused(verb, answer);
      if (refused) onRefused(refused);
    });
    onClose();
  };
  return (
    <>
      {open && <div className="absolute inset-0 z-[45]" onClick={onClose} />}
      <div
        data-page-sleep-sheet={open || undefined}
        data-page-sleep-armed={sleep.armed ? "" : undefined}
        className={cx(
          "absolute z-50 rounded-2xl bg-panel/90 p-4 shadow-2xl ring-1 ring-edge backdrop-blur-md select-none",
          faded,
        )}
        style={{
          bottom,
          left: at?.left ?? 16,
          width: at?.width ?? "min(340px, calc(100% - 32px))",
        }}
      >
        <div className="text-[15px] font-medium text-ink">Sleep timer</div>
        {sleep.armed ? (
          <>
            <SleepCountdown key={String(sleep.armed.firesAt)} firesAt={sleep.armed.firesAt} />
            <p className="mt-2 text-[13px] text-dim">{sleepThen(sleep.action)}</p>
            <button
              type="button"
              data-page-sleep-cancel
              onClick={() => choose("sleepCancel", () => steer("sleepCancel"))}
              className={cx(SHEET_CHIP, "mt-3 w-full text-alert")}
            >
              Cancel the timer
            </button>
          </>
        ) : (
          <>
            <p className="mt-0.5 text-[13px] text-dim">{sleepThen(sleep.action)}</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {sleepChoices(sleep).map((c) => (
                <button
                  key={c.minutes}
                  type="button"
                  data-page-sleep-choice={c.minutes}
                  onClick={() => choose("sleep", () => sleepIn(c.minutes))}
                  className={cx(SHEET_CHIP, c.minutes === "track" && "col-span-3")}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** An element's tallest height while `on` (the buttons, which a list keeps above): measured afresh
 *  as the list opens, then only ever higher, so the list holds still while a track it played
 *  changes over and the strip's lines come and go (a list that followed every change grew and
 *  shrank under the finger). */
function useHeightWhile(ref: React.RefObject<HTMLDivElement | null>, on: boolean): number {
  const [h, setH] = useState(112);
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    setH(el.offsetHeight);
    const seen = new ResizeObserver(() => setH((was) => Math.max(was, el.offsetHeight)));
    seen.observe(el);
    return () => seen.disconnect();
  }, [ref, on]);
  return h;
}

/** The Queue, Presets and Playlists icons, the app's own (its screen registry's). */
const QueueIcon = screenIcon("queue");
const PresetsIcon = screenIcon("presets");
const PlaylistsIcon = screenIcon("playlists");

/** The list's tabs in their order, with what each is called and drawn as. */
const LIST_TABS: ReadonlyArray<{ id: ListTab; label: string; icon: React.ReactNode }> = [
  { id: "queue", label: "Queue", icon: <QueueIcon size={16} /> },
  { id: "presets", label: "Presets", icon: <PresetsIcon size={16} /> },
  { id: "playlists", label: "Playlists", icon: <PlaylistsIcon size={16} /> },
];

/**
 * THE LIST, VIEWED (steps two and three, and the playlists after): the queue's window the display
 * server sent, the presets and the app's playlists, as tabs where there is more than one (Presets
 * and Playlists alone where there is no queue), the playing one marked and in view when it opens,
 * each row the app's own (components/media/MediaRow, the menu bar panel's rows: one home) at its
 * full, finger-sized height. A tap plays that row; nothing edits. Above the buttons, so play and
 * pause stay in reach; a touch outside closes it.
 */
function ListPanel({
  queue,
  presets,
  playlists,
  bottom,
  open,
  faded,
  onClose,
}: {
  queue: DisplayQueueRow[] | null;
  presets: DisplayPresetRow[] | null;
  playlists: DisplayPlaylistRow[] | null;
  /** The top of the buttons: the panel keeps above them. */
  bottom: string;
  /** Whether it is open: a closing panel is still drawn while it fades (hooks/useFadePresence). */
  open: boolean;
  /** Its fade's classes. */
  faded: string;
  onClose(): void;
}): React.JSX.Element {
  const here = LIST_TABS.filter((t) => ({ queue, presets, playlists })[t.id] != null);
  const [tab, setTab] = useState<ListTab>(here[0]?.id ?? "queue");
  // the chosen tab while it has something to show, else the first that does
  const showing: ListTab = here.some((t) => t.id === tab) ? tab : (here[0]?.id ?? "queue");
  // rows or cards, each tab its own, kept in this browser (the menu bar panel's choice)
  const [views, setViews] = useState<Record<ListTab, ListView>>(() => ({
    queue: listView("queue"),
    presets: listView("presets"),
    playlists: listView("playlists"),
  }));
  const view = views[showing];
  const flip = (): void => {
    const next: ListView = view === "cards" ? "rows" : "cards";
    keepListView(showing, next);
    setViews((v) => ({ ...v, [showing]: next }));
  };
  const square =
    "grid h-11 w-11 shrink-0 place-items-center rounded-lg text-dim motion-safe:active:scale-90 [-webkit-tap-highlight-color:transparent]";
  return (
    <>
      {/* a touch outside closes it; gone the moment it closes, so a touch during the fade-out
          reaches the page */}
      {open && <div className="absolute inset-0 z-[45]" onClick={onClose} />}
      <div
        // marked open only while it is: a closing panel, still drawn as it fades, is not the list
        data-page-queue={open || undefined}
        data-page-list={showing}
        className={cx(
          "absolute top-[calc(env(safe-area-inset-top,0px)+4.25rem)] left-1/2 z-50 flex w-[min(max(36rem,60vw),60rem,calc(100%_-_2rem))] -translate-x-1/2 flex-col rounded-2xl bg-panel/90 shadow-2xl ring-1 ring-edge backdrop-blur-md select-none",
          faded,
        )}
        style={{ bottom }}
      >
        {/* 8px from the panel's edge all round */}
        <div className="flex shrink-0 items-center gap-2 p-2 pb-0">
          {here.length > 1 ? (
            <div className="min-w-0 flex-1 overflow-x-auto">
              <PageTabs<ListTab>
                tabs={here.map((t) => ({ ...t, attrs: { "data-page-list-tab": t.id } }))}
                value={showing}
                onChange={setTab}
              />
            </div>
          ) : (
            <span className="flex-1 pl-3 text-[15px] font-medium text-ink">
              {LIST_TABS.find((t) => t.id === showing)?.label}
            </span>
          )}
          <button
            type="button"
            data-page-list-view={view}
            aria-label={view === "cards" ? "View as rows" : "View as cards"}
            onClick={flip}
            className={square}
          >
            {view === "cards" ? <List size={20} /> : <LayoutGrid size={20} />}
          </button>
          <button type="button" aria-label="Close the list" onClick={onClose} className={square}>
            <X size={20} />
          </button>
        </div>
        {showing === "queue" && queue ? (
          <QueueRows key={`queue-${view}`} rows={queue} cards={view === "cards"} />
        ) : showing === "playlists" && playlists ? (
          <PlaylistRows key={`playlists-${view}`} rows={playlists} cards={view === "cards"} />
        ) : (
          <PresetRows key={`presets-${view}`} rows={presets ?? []} cards={view === "cards"} />
        )}
      </div>
    </>
  );
}

/** The list's body: 8px at the sides, and at each end its edge's ramp (styles.css fade-edges, the
 *  app's pages' own): a row passing under the tabs or the panel's foot dissolves rather than being
 *  cut through its words, and at rest the first row and, at full scroll, the last sit clear of it,
 *  the playing row's ring with them. */
const LIST_EDGE_PX = 12;
const listBody =
  "fade-edges min-h-0 overflow-y-auto overscroll-contain px-2 py-3 [--fade-top-solid:12px] [--fade-bottom:12px]";
const rowsBody = cx(listBody, "space-y-1.5");
// the panel 60% of a wide screen (never under 36rem, at most 60rem): five cards across on an 11-inch
// tablet in landscape, six on a 13-inch, four in portrait, two on a phone, so more than one row
// shows on a short screen
const cardsBody = cx(listBody, "grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2.5");

/**
 * The list opens on the playing one, at its top (8px of ring room), container-scoped, never the
 * page; and again while the list settles to its size in its first moments (the panel's height
 * follows the buttons', measured as it opens), so the landing holds.
 */
function useLandOn(ref: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const land = (): void => scrollToTop(el, LIST_EDGE_PX);
    land();
    const box = el.closest(".overflow-y-auto");
    const seen = box ? new ResizeObserver(land) : null;
    if (box) seen?.observe(box);
    const settled = setTimeout(() => seen?.disconnect(), 800);
    return () => {
      clearTimeout(settled);
      seen?.disconnect();
    };
  }, [ref]);
}

/** The queue's rows: the playing track marked and in view as they open. */
function QueueRows({
  rows,
  cards,
}: {
  rows: DisplayQueueRow[];
  cards: boolean;
}): React.JSX.Element {
  const playingRow = useRef<HTMLDivElement | null>(null);
  // the playing track at the top as it opens, what comes next below it
  useLandOn(playingRow);
  if (cards)
    return (
      <div className={cardsBody}>
        {rows.map((r) => (
          <div key={r.id} ref={r.playing ? playingRow : undefined} className="min-w-0">
            <MediaTile
              attrs={{ "data-page-queue-row": String(r.id) }}
              art={r.art}
              kind="track"
              title={r.title}
              sub={r.artist}
              playing={r.playing}
              onPress={() => void steer("playQueue", r.id)}
            />
          </div>
        ))}
      </div>
    );
  return (
    <div className={rowsBody}>
      {rows.map((r) => (
        <div key={r.id} ref={r.playing ? playingRow : undefined}>
          <MediaRow
            touch
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
  );
}

/**
 * The app's playlists, as the menu bar panel draws them: the track count (how far, while one is on
 * its way into the queue) and the running time, the first picture. A tap plays it, the window's
 * Play: it replaces the queue a track at a time, the row saying how far, the others dimmed until
 * it is done (two at once would fight for the queue; main refuses a second). Stop loading on the
 * loading row, as the menu bar panel has it (a line across the top as cards): a wrong tap on a
 * long playlist has its remedy here, what is already queued staying.
 */
function PlaylistRows({
  rows,
  cards,
}: {
  rows: DisplayPlaylistRow[];
  cards: boolean;
}): React.JSX.Element {
  // the tap's own answer, sooner than the line's first word of loading
  const [asked, setAsked] = useState<string | null>(null);
  const running = rows.find((r) => r.loading != null)?.id ?? null;
  useEffect(() => {
    if (asked == null) return;
    if (running != null) {
      setAsked(null);
      return;
    }
    const t = setTimeout(() => setAsked(null), TUNING_MS);
    return () => clearTimeout(t);
  }, [asked, running]);
  const loadingId = running ?? asked;
  const play = (id: string): void => {
    setAsked(id);
    void playPlaylist(id).then((answer) => {
      if (!answer || !("done" in answer)) setAsked(null);
    });
  };
  const loadingRow = rows.find((r) => r.loading != null) ?? null;
  const stop = (e?: React.MouseEvent): void => {
    e?.stopPropagation();
    void steer("stopPlaylist");
  };
  const line = (p: DisplayPlaylistRow): string =>
    p.loading
      ? `Loading ${p.loading.done} of ${p.loading.total}…`
      : loadingId === p.id
        ? "Loading…"
        : `${p.tracks} ${p.tracks === 1 ? "track" : "tracks"}`;
  if (cards)
    return (
      <div className={cardsBody}>
        {loadingRow && (
          <button
            type="button"
            data-page-playlist-stop
            onClick={stop}
            className="col-span-full flex h-11 items-center justify-center gap-2 rounded-lg text-[14px] text-dim ring-1 ring-edge motion-safe:active:scale-[0.98] [-webkit-tap-highlight-color:transparent]"
          >
            <X size={16} />
            Stop loading “{loadingRow.name}”
          </button>
        )}
        {rows.map((p) => (
          <div key={p.id} className="min-w-0">
            <MediaTile
              attrs={{ "data-page-playlist-row": p.id }}
              art={p.art}
              kind="album"
              title={p.name}
              sub={line(p)}
              playing={false}
              tuning={loadingId === p.id}
              dimmed={loadingId != null && loadingId !== p.id}
              onPress={() => loadingId == null && play(p.id)}
            />
          </div>
        ))}
      </div>
    );
  return (
    <div className={rowsBody}>
      {rows.map((p) => (
        <div key={p.id}>
          <MediaRow
            touch
            attrs={{ "data-page-playlist-row": p.id }}
            title={p.name}
            subtitle={line(p)}
            meta={p.secs != null ? fmtDuration(p.secs) : undefined}
            kind="album"
            artUrl={p.art}
            tuning={loadingId === p.id}
            dimmed={loadingId != null && loadingId !== p.id}
            actions={
              p.loading ? (
                <button
                  type="button"
                  data-page-playlist-stop
                  aria-label="Stop loading"
                  onClick={stop}
                  className="grid h-11 w-11 place-items-center rounded-lg text-dim motion-safe:active:scale-90 [-webkit-tap-highlight-color:transparent]"
                >
                  <X size={20} />
                </button>
              ) : undefined
            }
            onClick={loadingId == null ? () => play(p.id) : undefined}
          />
        </div>
      ))}
    </div>
  );
}

/** How long a tapped preset shows it is tuning before the app's answer: recallWatch's clock. */
const TUNING_MS = 8_000;

/** The presets' rows, as the menu bar panel draws them (their slot numbers, the playing one lit):
 *  a tap recalls at once, the row tuning until it lights, or says it came to nothing. */
function PresetRows({
  rows,
  cards,
}: {
  rows: DisplayPresetRow[];
  cards: boolean;
}): React.JSX.Element {
  const playingRow = useRef<HTMLDivElement | null>(null);
  useLandOn(playingRow);
  const [tuning, setTuning] = useState<number | null>(null);
  const answered = rows.find((p) => p.id === tuning && (p.lit || p.dead)) != null;
  useEffect(() => {
    if (tuning == null) return;
    if (answered) {
      setTuning(null);
      return;
    }
    const t = setTimeout(() => setTuning(null), TUNING_MS);
    return () => clearTimeout(t);
  }, [tuning, answered]);
  const play = (id: number): void => {
    setTuning(id);
    void steer("playPreset", id);
  };
  if (cards)
    return (
      <div className={cardsBody}>
        {rows.map((p) => (
          <div key={p.id} ref={p.lit ? playingRow : undefined} className="min-w-0">
            <MediaTile
              attrs={{ "data-page-preset-row": String(p.id) }}
              art={p.art}
              kind="preset"
              title={p.name}
              sub={p.dead && tuning !== p.id ? "Nothing played" : null}
              playing={p.lit}
              tuning={tuning === p.id && !p.lit}
              onPress={() => play(p.id)}
            />
          </div>
        ))}
      </div>
    );
  return (
    <div className={rowsBody}>
      {rows.map((p) => {
        const isTuning = tuning === p.id;
        return (
          <div key={p.id} ref={p.lit ? playingRow : undefined}>
            <MediaRow
              touch
              attrs={{ "data-page-preset-row": String(p.id) }}
              slot={p.id}
              title={p.name}
              subtitle={p.dead && !isTuning ? "Nothing played" : undefined}
              kind="preset"
              artUrl={p.art}
              playing={p.lit}
              tuning={isTuning && !p.lit}
              onClick={() => play(p.id)}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * THE DARK SCREEN (step three, and why it is dark): while the streamer sleeps, or the app or the
 * streamer is out of reach, the page is black, and a touch brings up the TastyTunes mark faint in
 * the middle, so a touched black screen says what it is, and low, where the playback buttons
 * always are, one line saying why (display/dark). Neither is drawn at rest (no light at night). A
 * screen allowed with Presets, playlists and power on has its controls under the line: "Pick up
 * where you left off" with what it would play, and below it the presets' list and Wake, apart by
 * the gap the volume keeps. Wake only where a wake can work; where the streamer is out of reach
 * (Eco standby), the line says to wake it with its remote.
 */
export function SleepControls({
  heard,
  shown,
  listOpen,
  onList,
}: {
  /** Whether the app is heard (display/live): unheard, no controls are drawn from its last word. */
  heard: boolean;
  shown: boolean;
  listOpen: boolean;
  onList(open: boolean): void;
}): React.JSX.Element {
  const control = useControl();
  const [lockedHere] = useLocked();
  const connected = useStore((s) => s.connection.phase === "connected");
  const group = useRef<HTMLDivElement | null>(null);
  const groupH = useHeightWhile(group, listOpen);
  // this screen's own Wake, where it has one
  const wake = heard && !lockedHere && control.state === "allowed" ? control.wake : null;
  const { cause, line } = whyDark({ heard, connected, wake });
  const ready = wake === "ready";
  const presets = ready ? control.presets : null;
  const resume = ready ? control.resume : null;
  const presetsFade = useFadePresence(presets != null && listOpen, { rise: true });
  const showing = shown ? "opacity-100" : "pointer-events-none opacity-0";
  const bottom = "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)";
  return (
    <>
      <div
        aria-hidden
        data-page-sleep-mark
        className={cx(
          "pointer-events-none absolute inset-0 grid place-items-center",
          shown ? "opacity-100" : "opacity-0",
        )}
        style={{ transition: shown ? DIM_IN : DIM_OUT }}
      >
        <TtMark className="text-[64px] text-ink opacity-40" />
      </div>
      {presets && presetsFade.mounted && (
        <ListPanel
          queue={null}
          presets={presets}
          playlists={null}
          bottom={`calc(${bottom} + ${groupH + 12}px)`}
          open={listOpen}
          faded={presetsFade.faded}
          onClose={() => onList(false)}
        />
      )}
      <div
        ref={group}
        data-page-sleep={wake ?? undefined}
        data-page-dark={cause}
        className={cx(
          "absolute inset-x-0 z-[46] flex flex-col items-center gap-2 px-4 transition-opacity duration-300 select-none",
          showing,
        )}
        style={{ bottom }}
      >
        <p
          data-page-dark-line
          className="mb-1 max-w-[min(36rem,90vw)] text-center text-[15px] leading-snug text-dim"
        >
          {line}
        </p>
        {resume && (
          <button
            type="button"
            data-page-resume
            onClick={() => void steer("resume")}
            className="flex max-w-[min(36rem,90vw)] items-center gap-2.5 rounded-full bg-panel/85 py-2.5 pr-5 pl-3.5 text-[14px] text-ink shadow-lg ring-1 ring-edge backdrop-blur [-webkit-tap-highlight-color:transparent] transition-transform active:scale-95"
          >
            <Play size={15} fill="currentColor" className="shrink-0" />
            <span className="truncate">
              Pick up where you left off <span className="text-dim">· {resume.title}</span>
            </span>
          </button>
        )}
        {ready && (
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-2">
            {presets && (
              <Disc
                label={listOpen ? "Close the list" : "Presets"}
                size="side"
                active={listOpen}
                onPress={() => onList(!listOpen)}
                attrs={{ "data-page-presets-button": "" }}
              >
                <PresetsIcon size={22} />
              </Disc>
            )}
            <Disc verb="wake" label="Wake" size="main">
              <Power size={30} />
            </Disc>
          </div>
        )}
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
