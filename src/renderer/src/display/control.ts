import { useSyncExternalStore } from "react";
import type {
  DisplayControl,
  DisplayControlAnswer,
  DisplayVerb,
  SleepChoice,
} from "@shared/displayControl";

/**
 * THE PAGE'S OWN CALL FOR ITS OWN BUTTONS (0.17.0, controls on the other screens). The bridge's
 * `command` still answers nothing (display/webBridge): the Display tree calls it in places built for
 * the window, and each would become a remote the day the bridge forwarded it. This is the only way
 * a screen steers: one of the fixed verbs (shared/displayControl), posted to the display server's
 * one write route, which checks the screen and asks the app. The page seeks through it too, with
 * its own bar (step four), never through the window's strip.
 *
 * Where this screen stands arrives on its own line of the live channel (display/live): off, ask,
 * asking, declined or allowed, with the volume and the next track when allowed.
 */

const OFF: DisplayControl = {
  state: "off",
  volume: null,
  next: null,
  queue: null,
  presets: null,
  playlists: null,
  wake: null,
  resume: null,
  standby: false,
  sleep: null,
};
let control: DisplayControl = OFF;
const heard = new Set<() => void>();

export function hearControl(next: DisplayControl): void {
  control = next;
  for (const l of heard) l();
}

export function useControl(): DisplayControl {
  return useSyncExternalStore(
    (l) => {
      heard.add(l);
      return () => heard.delete(l);
    },
    () => control,
  );
}

/** Whether this browser has a touch screen: an iPad's Safari says it is a Mac otherwise. */
const touch = (): boolean => typeof navigator !== "undefined" && navigator.maxTouchPoints > 1;

/** How long a post waits for the app's answer: a tap made while the app is out of reach is given
 *  up, never left pending to land later on whatever is playing then. */
export const POST_MS = 4_000;

/** One verb to the app (`id`: the queue row playQueue plays, the preset playPreset plays). The
 *  answer says whether it was done, or why not (the screen asked the app, the app said not now,
 *  the source can't do it); null when the app couldn't be reached or didn't answer in POST_MS. */
/** The verbs a button or a key sends: all but a seek, which carries its point (seekTo), a
 *  playlist, which carries its own id (playPlaylist), and the sleep timer, its length (sleepIn). */
export type ButtonVerb = Exclude<DisplayVerb, "seek" | "playPlaylist" | "sleep">;

export const steer = (verb: ButtonVerb, id?: number): Promise<DisplayControlAnswer | null> =>
  post({ verb, ...(id != null ? { id } : {}) });

/** A seek to a point in the playing track (step four), in seconds from its start: one for each
 *  lift of a finger, never a stream during a drag (components/media/Waveform's PageSeekBar). */
export const seekTo = (secs: number): Promise<DisplayControlAnswer | null> =>
  post({ verb: "seek", secs });

/** One of the app's playlists, by its id: the window's Play, which replaces the queue. */
export const playPlaylist = (id: string): Promise<DisplayControlAnswer | null> =>
  post({ verb: "playPlaylist", id });

/** The app's sleep timer, for one of the window's lengths or to the end of the track: its action
 *  and its fade are the app's own settings. */
export const sleepIn = (minutes: SleepChoice): Promise<DisplayControlAnswer | null> =>
  post({ verb: "sleep", minutes });

/** Whether the app did what a post asked: not for a refusal, nor for a post it never answered. */
export const wasDone = (answer: DisplayControlAnswer | null): boolean =>
  answer != null && "done" in answer;

async function post(what: {
  verb: DisplayVerb;
  id?: number | string;
  secs?: number;
  minutes?: SleepChoice;
}): Promise<DisplayControlAnswer | null> {
  try {
    const res = await fetch("/api/control", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-tastytunes": "control" },
      body: JSON.stringify({ ...what, touch: touch() }),
      signal: AbortSignal.timeout(POST_MS),
    });
    const body = (await res.json().catch(() => null)) as DisplayControlAnswer | null;
    // the screen asked: it hears "asking" on its line too, but the tap's own answer is sooner
    if (body && "refused" in body && body.refused === "asking" && control.state === "ask")
      hearControl({ ...control, state: "asking" });
    return body;
  } catch {
    return null;
  }
}
