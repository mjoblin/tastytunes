import { useEffect, useRef } from "react";

/**
 * Consume a ONE-SHOT ASK — a value one screen plants in the store for another
 * screen to act on exactly once (jump to a Settings tab, select this playlist,
 * open the Library ready to search).
 *
 * Three things have to be true, and getting any of them wrong has shipped a
 * real bug here before:
 *
 *  1. CLAIM ONCE. `claim` identifies this ask — a monotonic id for the asks
 *     that carry one, the value itself for the plain ones. It's remembered in
 *     a ref, so a StrictMode double-run (which re-runs the effect with the
 *     pre-clear value still captured) sees its own claim and no-ops.
 *  2. CLEAR. An ask left in the store re-fires the next time the screen mounts
 *     — a stale jump landing on a later visit reads as the app moving on its
 *     own.
 *  3. WAIT, DON'T DROP. `ready` gates an ask that arrived before this screen
 *     had the data to act on it (the Library's server listing). The ask stays
 *     in the store and runs when `ready` flips, rather than being consumed
 *     into nothing.
 *
 * `run` is called through a ref, so it always sees the latest render's
 * closure rather than the one that happened to be current when the ask landed.
 *
 * NOT ADOPTED BY `searchRequest` (the unified Search screen), on purpose: its
 * effect also focuses the input on EVERY mount and re-arms an rAF each time
 * the ask changes, so the ask and the focus are one effect by design — pulling
 * the ask out would split a rAF cleanup across two effects for no gain.
 * `libraryTarget` keeps its own nonce pairing too (deliberately coupled to the
 * reset nonce — see the store).
 */
export function useOneShotAsk<T>(
  ask: T | null | undefined,
  run: (ask: T) => void,
  opts?: {
    /** Identity of this ask; defaults to the ask value (fine for primitives). */
    claim?: string | number;
    /** Called once the ask is claimed, before `run`. */
    clear?: () => void;
    /** False parks the ask until the screen can act on it. Default true. */
    ready?: boolean;
  },
): void {
  const { claim, clear, ready = true } = opts ?? {};
  const runRef = useRef(run);
  runRef.current = run;
  const clearRef = useRef(clear);
  clearRef.current = clear;
  const claimed = useRef<string | number | null>(null);

  const token = claim ?? (ask as unknown as string | number);
  useEffect(() => {
    if (ask == null) return;
    if (!ready) return;
    if (claimed.current === token) return;
    claimed.current = token;
    clearRef.current?.();
    runRef.current(ask);
  }, [ask, token, ready]);
}
