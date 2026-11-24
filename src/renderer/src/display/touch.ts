import { useCallback, useEffect, useRef, useState } from "react";

/** How long the page's buttons stay after a touch. */
export const SHOWN_MS = 4_000;

/**
 * THE PAGE'S TOUCH SURFACE (0.17.0, Display on other screens): one home for when the page's own
 * buttons show (the corner buttons, display/ScenePanel; the transport, display/PageTransport). A touch
 * anywhere shows them for SHOWN_MS, the time starting again at every touch and held while a finger
 * is down or `hold` is true (a panel or a list open); on a computer the pointer moving shows them
 * too. THE FIRST TOUCH ONLY SHOWS: a touch on a page whose buttons are hidden is swallowed before
 * its click reaches anything, so a tap where the play button will appear never presses it.
 */
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
    const pressed = (e: PointerEvent): void => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      swallow = !shownRef.current;
      down.current = true;
      show(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const lifted = (): void => {
      if (!down.current) return;
      down.current = false;
      later();
    };
    const moved = (e: PointerEvent): void => {
      if (e.pointerType !== "mouse" || down.current) return;
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
