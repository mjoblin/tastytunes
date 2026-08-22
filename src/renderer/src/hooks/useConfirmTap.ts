import { useCallback, useEffect, useRef, useState } from "react";

/** How long an armed confirm waits before giving up on its second tap. */
const DISARM_MS = 3000;

/**
 * The two-tap "Sure?" state machine — now ONE site: the preset-save overwrite
 * slot grid (LibraryMenus), whose cells are fixed squares so the in-place arm
 * shifts nothing, and which lives inside a popover already, where stacking a
 * second card would fight the first.
 *
 * EVERY OTHER CONFIRM IS `useConfirmPopover` (law changed 2026-08-03, user
 * call): the in-place morph resized icon buttons — a trash glyph becoming
 * "Sure?" text — and a confirm whose arrival moves the thing you're aiming at
 * is worse than no confirm. The rule that emerged: an in-place arm is
 * acceptable ONLY where the control's box cannot change; everywhere else,
 * the anchored popover (components/chrome/Confirm.tsx).
 *
 * DISARM IS THE UNION OF WHAT THE SITES USED TO DO (decided 2026-07-26): a 3s
 * timeout AND blur — before this, an armed control could sit indefinitely
 * waiting to delete something.
 *
 * Confirms are for what CAN'T be undone; anything with a working undo should
 * stay instant (see the destructive-edit rules in the ROADMAP). This hook is
 * for the former.
 *
 * ```
 * const confirm = useConfirmTap<string>()
 * <button
 *   onClick={() => { if (confirm.tap(playlist.id)) doDelete() }}
 *   {...confirm.blurProps}
 * >{confirm.isArmed(playlist.id) ? 'Sure?' : <Trash2 />}</button>
 * ```
 */
export function useConfirmTap<K extends string | number | boolean = boolean>(): {
  /** The armed key, or null. */
  armed: K | null;
  /** Is this key armed? Keyless sites can call it with no argument. */
  isArmed(key?: K): boolean;
  /**
   * One tap. Returns TRUE when it fires (this key was already armed) and FALSE
   * when it merely arms — so a call site reads `if (confirm.tap(id)) remove()`.
   * Tapping a different key re-arms on that one; the old arm is dropped.
   */
  tap(key?: K): boolean;
  disarm(): void;
  /** Spread onto the confirming control — focus leaving it disarms. */
  blurProps: { onBlur: () => void };
} {
  const [armed, setArmed] = useState<K | null>(null);
  // The ref mirrors the state so `tap` can decide arm-vs-fire SYNCHRONOUSLY.
  // Reading `armed` from the closure would be a render behind after a tap that
  // arms, and a state updater can't return an answer to the caller.
  const armedRef = useRef<K | null>(null);

  const set = useCallback((next: K | null): void => {
    armedRef.current = next;
    setArmed(next);
  }, []);

  useEffect(() => {
    if (armed === null) return;
    const t = setTimeout(() => set(null), DISARM_MS);
    return () => clearTimeout(t);
  }, [armed, set]);

  const tap = useCallback(
    (key?: K): boolean => {
      const k = (key ?? true) as K;
      if (armedRef.current === k) {
        set(null);
        return true;
      }
      set(k);
      return false;
    },
    [set],
  );

  const disarm = useCallback(() => set(null), [set]);
  const isArmed = useCallback((key?: K): boolean => armed === ((key ?? true) as K), [armed]);
  const blurProps = useRef({ onBlur: disarm }).current;
  blurProps.onBlur = disarm;

  return { armed, isArmed, tap, disarm, blurProps };
}
