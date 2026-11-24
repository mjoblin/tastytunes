import type { DisplayControlState, DisplayScreen, DisplayScreens } from "@shared/displayControl";

/**
 * THE SCREENS THAT MAY CONTROL (0.17.0, Display on other screens): each screen is approved once,
 * in the app. A screen's first tap asks ("Allow this screen to control playback?"); the answer is
 * kept by the screen's own id (the tt_screen cookie its browser was given at its first visit),
 * here in main and never in the settings a screen is shown. Settings lists the screens that were
 * answered, each with Remove, and can allow one that was turned down.
 *
 * - After "Not now", that screen doesn't ask again for NOT_NOW_MS, so a guest's screen can't fill
 *   the app with prompts.
 * - A new address ends every approval (clear).
 * - What approval protects against: a copied address and a stray browser. Not someone who can
 *   watch the network's traffic (the page is plain http, so its cookies can be read there), and
 *   the streamer itself takes commands from any device on the network.
 *
 * Pure apart from what it is handed: the stored list, the clock, and a word when anything changes.
 */

/** How long a screen turned down waits before it may ask again. */
export const NOT_NOW_MS = 10 * 60_000;
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
  /** The screens being asked about, oldest first. */
  private readonly asks = new Map<string, DisplayScreen>();
  /** Turned down: not asked about again until then. */
  private readonly notNow = new Map<string, number>();

  constructor(private readonly deps: ScreenBookDeps) {}

  private stored(): DisplayScreen[] {
    return this.deps.load();
  }

  /** The answered screens, newest first, and the one being asked about. */
  list(): DisplayScreens {
    return {
      screens: [...this.stored()].sort((a, b) => b.firstSeen - a.firstSeen),
      asking: this.asks.values().next().value ?? null,
    };
  }

  /** Where a screen stands, with the switch `on` or off. */
  stateOf(id: string | null, on: boolean): DisplayControlState {
    if (!on) return "off";
    if (id == null) return "ask";
    if (this.stored().some((s) => s.id === id && s.allowed)) return "allowed";
    if (this.asks.has(id)) return "asking";
    const until = this.notNow.get(id);
    if (until != null && until > this.deps.now()) return "declined";
    return "ask";
  }

  /** A screen's tap that isn't allowed yet: the app is asked, once. */
  ask(id: string, name: string, on: boolean): DisplayControlState {
    const state = this.stateOf(id, on);
    if (state !== "ask") return state;
    const known = this.stored().find((s) => s.id === id);
    this.asks.set(id, { id, name, firstSeen: known?.firstSeen ?? this.deps.now(), allowed: false });
    this.deps.changed();
    return "asking";
  }

  /** The app's answer, from its prompt or from Settings' list. */
  answer(id: string, allowed: boolean): void {
    const asked = this.asks.get(id);
    const known = this.stored().find((s) => s.id === id);
    const was = asked ?? known;
    if (!was) return;
    this.asks.delete(id);
    if (allowed) this.notNow.delete(id);
    else this.notNow.set(id, this.deps.now() + NOT_NOW_MS);
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
    if (this.asks.size === 0 && this.stored().length === 0) return;
    this.asks.clear();
    this.notNow.clear();
    this.deps.save([]);
    this.deps.changed();
  }

  /** The switch turned off: nothing is asked about any more (the answers are kept). */
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
