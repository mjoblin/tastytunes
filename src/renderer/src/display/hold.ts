/**
 * A PRESS THAT ACTS ONLY WHEN HELD (0.17.0, standby on another screen): the power disc puts the
 * streamer in standby only for a press held STANDBY_HOLD_MS and then let go on the disc, never for
 * a tap, so a brushing hand or a tap meant for the volume beside it can't send the room to sleep.
 * A ring fills around the disc over the hold; full, the line above says to let go, and standby goes
 * at the lift. A press let go before the ring is full sends nothing, the ring going back in
 * RING_BACK_MS with a hint saying how standby is reached (display/PageTransport).
 *
 * NOTHING GOES WITHOUT THE LIFT: low on an iPad a sideways drag is the system's (it switches apps)
 * and the page never hears the finger lift, so a full ring waits for a lift that may never come
 * and sends nothing then. A finger that leaves the disc, a touch the browser takes (a cancel), the
 * page hidden or behind another window (dropWhenAway) and the buttons gone all end the press, the
 * ring going back, nothing sent.
 */

/** How long the power disc is held for standby. */
export const STANDBY_HOLD_MS = 1_500;
/** The ring's way back when a press ends without standby. */
export const RING_BACK_MS = 150;

export interface HoldPress {
  /** The press began: `full` follows after the hold, unless it ends first. */
  down(): void;
  /** The finger lifted on the disc: `held` once the hold was full, `short` before it. */
  lift(): void;
  /** The finger left the disc, or the browser took the touch: `short` before the hold was full,
   *  `dropped` once it was. An end after the press has ended (the leave after a lift) is nothing. */
  leave(): void;
  /** The press ends with nothing sent, however far it got (the page hidden, the buttons gone):
   *  `dropped`. */
  drop(): void;
  /** Let go with nothing said (the disc is gone). */
  stop(): void;
}

/** A press that calls `full` when it has lasted `ms`, then `held` at its lift; `short` for a lift
 *  (or a leave) before that, and `dropped` for a press that ends any other way. */
export function holdPress(
  ms: number,
  on: { full(): void; held(): void; short(): void; dropped(): void },
): HoldPress {
  let state: "rest" | "filling" | "full" = "rest";
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The press is over: what it had come to. */
  const settle = (): "rest" | "filling" | "full" => {
    if (timer) clearTimeout(timer);
    timer = null;
    const was = state;
    state = "rest";
    return was;
  };
  return {
    down() {
      settle();
      state = "filling";
      timer = setTimeout(() => {
        timer = null;
        state = "full";
        on.full();
      }, ms);
    },
    lift() {
      const was = settle();
      if (was === "full") on.held();
      else if (was === "filling") on.short();
    },
    leave() {
      const was = settle();
      if (was === "full") on.dropped();
      else if (was === "filling") on.short();
    },
    drop() {
      if (settle() !== "rest") on.dropped();
    },
    stop() {
      settle();
    },
  };
}

/** Where a press listens for the page going away: the window, and its document (whose
 *  `visibilityState` says hidden). */
export interface PageAway {
  win: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  doc: Pick<EventTarget, "addEventListener" | "removeEventListener"> & {
    readonly visibilityState: DocumentVisibilityState;
  };
}

/** Drops `press` when the page is hidden (another app or tab in front, the screen locked), is
 *  left (pagehide), or loses focus (another window in front): a finger on the disc then is one
 *  the page may never hear lift. Returns the way to stop listening. */
export function dropWhenAway(
  press: Pick<HoldPress, "drop">,
  { win, doc }: PageAway = { win: window, doc: document },
): () => void {
  const hidden = (): void => {
    if (doc.visibilityState === "hidden") press.drop();
  };
  const away = (): void => press.drop();
  doc.addEventListener("visibilitychange", hidden);
  win.addEventListener("pagehide", away);
  win.addEventListener("blur", away);
  return () => {
    doc.removeEventListener("visibilitychange", hidden);
    win.removeEventListener("pagehide", away);
    win.removeEventListener("blur", away);
  };
}
