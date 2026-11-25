import { useCallback, useEffect, useRef, useState } from "react";

/** How long the page's buttons stay after a touch. */
export const SHOWN_MS = 4_000;

/**
 * THE PAGE'S TOUCH SURFACE (0.17.0, Display on other screens): one home for when the page's own
 * buttons show (the corner buttons, display/ScenePanel; the transport, display/PageTransport). A touch
 * anywhere shows them for SHOWN_MS, the time starting again at every touch and held while a finger
 * is down or `hold` is true (a panel or a list open); on a computer the pointer moving shows them
 * too, never a still one. THE FIRST TOUCH ONLY SHOWS: a touch on a page whose buttons are hidden is swallowed before
 * its click reaches anything, so a tap where the play button will appear never presses it.
 * A TOUCH AWAY FROM THEM PUTS THEM AWAY: with the buttons up and nothing open, a deliberate tap on
 * the picture, away from every control, lets them go at once (the dim lifting at its own pace)
 * rather than holding them up another four seconds. With a panel or a list open, a tap outside
 * only closes that.
 */

/** A control, or anything a touch on means to use (a panel's or a list's own area). */
const CONTROL =
  'button, a, input, select, textarea, label, [role="button"], [role="switch"], [role="tab"], [role="slider"], [data-page-scenes], [data-page-queue]';
const onControl = (t: EventTarget | null): boolean =>
  t instanceof Element && t.closest(CONTROL) != null;
export function useTouchShown(hold: boolean): boolean {
  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);
  const holdRef = useRef(hold);
  const down = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // both touch only refs and state's setter, so they never change
  const show = useCallback((on: boolean): void => {
    shownRef.current = on;
    setShown(on);
  }, []);
  const later = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!holdRef.current && !down.current) timer.current = setTimeout(() => show(false), SHOWN_MS);
  }, [show]);
  useEffect(() => {
    holdRef.current = hold;
    if (hold) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    } else if (shownRef.current) later();
  }, [hold, later]);
  useEffect(() => {
    // whether this touch's click is the one that showed the buttons
    let swallow = false;
    // whether this touch, away from every control, puts the buttons away when it lifts
    let away = false;
    const pressed = (e: PointerEvent): void => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      swallow = !shownRef.current;
      away = shownRef.current && !holdRef.current && !onControl(e.target);
      down.current = true;
      if (!away) show(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const lifted = (): void => {
      if (!down.current) return;
      down.current = false;
      if (away) {
        away = false;
        show(false);
        return;
      }
      later();
    };
    const moved = (e: PointerEvent): void => {
      if (e.pointerType !== "mouse" || down.current) return;
      // a pointer that hasn't moved: the browser's own move when the page changes under a still
      // cursor (a track change, the screen going dark), which would show the buttons unasked
      if (e.movementX === 0 && e.movementY === 0) return;
      show(true);
      later();
    };
    const clicked = (e: MouseEvent): void => {
      if (!swallow) return;
      swallow = false;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("pointerdown", pressed, true);
    window.addEventListener("pointerup", lifted, true);
    window.addEventListener("pointercancel", lifted, true);
    window.addEventListener("pointermove", moved);
    window.addEventListener("click", clicked, true);
    return () => {
      window.removeEventListener("pointerdown", pressed, true);
      window.removeEventListener("pointerup", lifted, true);
      window.removeEventListener("pointercancel", lifted, true);
      window.removeEventListener("pointermove", moved);
      window.removeEventListener("click", clicked, true);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [show, later]);
  return shown;
}

/**
 * A PANEL KEEPS ITS SWIPES (iPadOS Safari in full screen): a swipe down that nothing on the page
 * takes leaves full screen, and a list at its top, or one too short to scroll, takes nothing, so
 * a swipe down on the queue or the presets left full screen. As a touch starts in the panel, its
 * scroller is moved a pixel in from the edge it sits at, so native scrolling takes the swipe (its
 * bounce kept, decisions/0007's sacred scrolling); a touch that moves where nothing can scroll
 * (the tabs, a list that fits) is held. The rest of the page keeps the system's gesture.
 */
export function useHoldSwipes(ref: React.RefObject<HTMLElement | null>, on = true): void {
  useEffect(() => {
    const panel = ref.current;
    if (!panel || !on) return;
    const scrollerOf = (t: EventTarget | null): HTMLElement | null => {
      const sc = t instanceof Element ? t.closest<HTMLElement>(".overflow-y-auto") : null;
      return sc && panel.contains(sc) && sc.scrollHeight > sc.clientHeight ? sc : null;
    };
    const start = (e: TouchEvent): void => {
      const sc = scrollerOf(e.target);
      if (!sc) return;
      const bottom = sc.scrollHeight - sc.clientHeight;
      if (sc.scrollTop <= 0) sc.scrollTop = 1;
      else if (sc.scrollTop >= bottom) sc.scrollTop = bottom - 1;
    };
    const move = (e: TouchEvent): void => {
      if (scrollerOf(e.target)) return;
      if (e.cancelable) e.preventDefault();
    };
    panel.addEventListener("touchstart", start, { passive: true });
    panel.addEventListener("touchmove", move, { passive: false });
    return () => {
      panel.removeEventListener("touchstart", start);
      panel.removeEventListener("touchmove", move);
    };
  }, [ref, on]);
}
