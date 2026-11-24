import { useSyncExternalStore } from "react";
import type { DisplayControl, DisplayControlAnswer, DisplayVerb } from "@shared/displayControl";

/**
 * THE PAGE'S OWN CALL FOR ITS OWN BUTTONS (0.17.0, controls on the other screens). The bridge's
 * `command` still answers nothing (display/webBridge): the Display tree calls it in places built for
 * the window (the waveform's seek), and each would become a remote the day the bridge forwarded
 * it. This is the only way a screen steers: one of the fixed verbs (shared/displayControl), posted
 * to the display server's one write route, which checks the screen and asks the app.
 *
 * Where this screen stands arrives on its own line of the live channel (display/live): off, ask,
 * asking, declined or allowed, with the volume and the next track when allowed.
 */

const OFF: DisplayControl = { state: "off", volume: null, next: null };
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

/** One verb to the app. The answer says whether it was done, or why not (the screen asked the
 *  app, the app said not now, the source can't do it); null when the app couldn't be reached. */
export async function steer(verb: DisplayVerb): Promise<DisplayControlAnswer | null> {
  try {
    const res = await fetch("/api/control", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-tastytunes": "control" },
      body: JSON.stringify({ verb, touch: touch() }),
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
