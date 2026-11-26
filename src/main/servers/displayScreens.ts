import type { DisplayControlState, DisplayScreen, DisplayScreens } from "@shared/displayControl";

/**
 * THE SCREENS THAT MAY CONTROL (0.17.0, Display on other screens): each screen is approved once,
 * in the app. A screen's first tap asks ("Allow this screen to control playback?"); the answer is
 * kept by the screen's own id (the tt_screen cookie its browser was given at its first visit),
 * here in main and never in the settings a screen is shown. Settings lists the screens that were
 * answered, each with Remove, and can allow one that was turned down.
 *
 * - After "Not now", that screen doesn't ask again for NOT_NOW_MS, and no screen the app has never
 *   seen asks for NEW_SCREEN_HOLD_MS; at most MAX_ASKS_WAITING screens wait to be asked about, a
 *   new one asks at most once in ASK_GAP_MS across all screens, and an ask nobody answers lapses
 *   after ASK_LAPSE_MS (the screen's next tap asks again). A screen's id is whatever its cookie
 *   says (a private window, cleared cookies or a script holding the address is a new screen each
 *   time), so these bound the book itself: a guest's screens can't fill the app with prompts, and
 *   a stale one can't stand ahead of the owner's for long. A tap past them asks nothing and
 *   records nothing.
 * - A new address ends every approval (clear).
 * - What approval protects against: a copied address and a stray browser. Not someone who can
 *   watch the network's traffic (the page is plain http, so its cookies can be read there), and
 *   the streamer itself takes commands from any device on the network.
 *
 * Pure apart from what it is handed: the stored list, the clock, a timer, and a word when anything
 * changes.
 */

/** How long a screen turned down waits before it may ask again. */
export const NOT_NOW_MS = 10 * 60_000;
/** At most this many screens wait to be asked about at once. */
export const MAX_ASKS_WAITING = 3;
/** A new ask at most this often, across all screens. */
export const ASK_GAP_MS = 5_000;
/** An ask nobody answers is taken down after this long: the prompt goes, and the screen's next
 *  tap asks again. */
export const ASK_LAPSE_MS = 2 * 60_000;
/** After a "Not now", a screen the app has never seen waits this long before it may ask, so a
 *  script making up screens can't raise the next prompt the moment one is turned down. Shorter
 *  than NOT_NOW_MS: the owner's own new tablet, opened just after, waits with it, its taps doing
 *  nothing (a screen that never asked isn't in Settings' list to be allowed there), and a stranger
 *  can raise a prompt about this often anyway by leaving one to lapse. */
export const NEW_SCREEN_HOLD_MS = 2 * 60_000;
/** Screens kept; past it, the oldest turned down go first, then the oldest. */
export const MAX_SCREENS_KEPT = 32;
/** A screen's id: the 16 random bytes its cookie carries, in hex. */
export const SCREEN_ID = /^[0-9a-f]{32}$/;

export interface ScreenBookDeps {
  load(): DisplayScreen[];
  save(screens: DisplayScreen[]): void;
  now(): number;
  /** The list or an ask changed: the windows and the screens hear it. */
  changed(): void;
  /** Runs `fn` once, `ms` from now (a timer): an ask's lapse is said where it shows. */
  later(fn: () => void, ms: number): void;
}

/** Whether something read from disk is a screen the book could have kept. */
export function isStoredScreen(x: unknown): x is DisplayScreen {
  if (x == null || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    SCREEN_ID.test(s.id) &&
    typeof s.name === "string" &&
    s.name.length > 0 &&
    s.name.length <= 80 &&
    typeof s.firstSeen === "number" &&
    Number.isFinite(s.firstSeen) &&
    typeof s.allowed === "boolean"
  );
}

export class ScreenBook {
  /** The screens being asked about, oldest first, each with when it asked. */
  private readonly asks = new Map<string, { screen: DisplayScreen; at: number }>();
  /** Turned down: not asked about again until then (dropped once that has passed). */
  private readonly notNow = new Map<string, number>();
  /** When the last new ask was raised. */
  private lastAsk = -Infinity;
  /** When the app last said "Not now" to a screen. */
  private lastNotNow = -Infinity;
  /** An ask lapsed and the windows haven't heard it yet. */
  private lapsedUnsaid = false;

  constructor(private readonly deps: ScreenBookDeps) {}

  private stored(): DisplayScreen[] {
    return this.deps.load();
  }

  /** Drops the asks nobody answered within ASK_LAPSE_MS. */
  private lapse(): void {
    const now = this.deps.now();
    for (const [id, { at }] of this.asks)
      if (now - at >= ASK_LAPSE_MS) {
        this.asks.delete(id);
        this.lapsedUnsaid = true;
      }
  }

  /** The answered screens, newest first, and the one being asked about. */
  list(): DisplayScreens {
    this.lapse();
    return {
      screens: [...this.stored()].sort((a, b) => b.firstSeen - a.firstSeen),
      asking: this.asks.values().next().value?.screen ?? null,
    };
  }

  /** Where a screen stands, with the switch `on` or off. */
  stateOf(id: string | null, on: boolean): DisplayControlState {
    if (!on) return "off";
    if (id == null) return "ask";
    this.lapse();
    if (this.stored().some((s) => s.id === id && s.allowed)) return "allowed";
    if (this.asks.has(id)) return "asking";
    const until = this.notNow.get(id);
    if (until == null) return "ask";
    if (until > this.deps.now()) return "declined";
    this.notNow.delete(id);
    return "ask";
  }

  /** A screen's tap that isn't allowed yet: the app is asked, once; "busy" (nothing asked, nothing
   *  recorded) while MAX_ASKS_WAITING wait, another was asked within ASK_GAP_MS, or for a screen
   *  never seen, within NEW_SCREEN_HOLD_MS of a "Not now". */
  ask(id: string, name: string, on: boolean): DisplayControlState | "busy" {
    const state = this.stateOf(id, on);
    if (state !== "ask") return state;
    const now = this.deps.now();
    for (const [other, until] of this.notNow) if (until <= now) this.notNow.delete(other);
    if (this.asks.size >= MAX_ASKS_WAITING || now - this.lastAsk < ASK_GAP_MS) return "busy";
    const known = this.stored().find((s) => s.id === id);
    if (!known && now - this.lastNotNow < NEW_SCREEN_HOLD_MS) return "busy";
    this.lastAsk = now;
    this.asks.set(id, {
      screen: { id, name, firstSeen: known?.firstSeen ?? now, allowed: false },
      at: now,
    });
    // taken down where it shows once it lapses (a read of the book may have dropped it first)
    this.deps.later(() => {
      this.lapse();
      if (!this.lapsedUnsaid) return;
      this.lapsedUnsaid = false;
      this.deps.changed();
    }, ASK_LAPSE_MS);
    this.deps.changed();
    return "asking";
  }

  /** Screens turned down and still waiting out NOT_NOW_MS (for the tests). */
  get heldOff(): number {
    return this.notNow.size;
  }

  /** The app's answer, from its prompt or from Settings' list. */
  answer(id: string, allowed: boolean): void {
    const asked = this.asks.get(id)?.screen;
    const known = this.stored().find((s) => s.id === id);
    const was = asked ?? known;
    if (!was) return;
    this.asks.delete(id);
    if (allowed) this.notNow.delete(id);
    else {
      this.notNow.set(id, this.deps.now() + NOT_NOW_MS);
      this.lastNotNow = this.deps.now();
    }
    const next = this.stored().filter((s) => s.id !== id);
    next.push({ ...was, allowed });
    this.deps.save(trim(next));
    this.deps.changed();
  }

  /** Settings' Remove: the screen is forgotten, and its next tap asks again. */
  remove(id: string): void {
    const had = this.asks.delete(id);
    const next = this.stored().filter((s) => s.id !== id);
    if (!had && next.length === this.stored().length) return;
    this.notNow.delete(id);
    this.deps.save(next);
    this.deps.changed();
  }

  /** A new address: every approval ends, every ask with it. */
  clear(): void {
    this.lastNotNow = -Infinity;
    if (this.asks.size === 0 && this.stored().length === 0) return;
    this.asks.clear();
    this.notNow.clear();
    this.deps.save([]);
    this.deps.changed();
  }

  /** A switch turned off (the display's or its controls'): nothing is asked about any more (the
   *  answers are kept). */
  dropAsks(): void {
    if (this.asks.size === 0) return;
    this.asks.clear();
    this.deps.changed();
  }
}

/** At most MAX_SCREENS_KEPT: the oldest turned down leave first, then the oldest allowed. */
function trim(screens: DisplayScreen[]): DisplayScreen[] {
  if (screens.length <= MAX_SCREENS_KEPT) return screens;
  const order = [...screens].sort(
    (a, b) => Number(a.allowed) - Number(b.allowed) || a.firstSeen - b.firstSeen,
  );
  const gone = new Set(order.slice(0, screens.length - MAX_SCREENS_KEPT).map((s) => s.id));
  return screens.filter((s) => !gone.has(s.id));
}
