import { useEffect, useState } from "react";
import { cx } from "@/lib/format";

/**
 * Presence with a quick opacity fade, for surfaces that conditionally mount
 * (the Now Playing side panels, every ModalShell). `mounted` extends past
 * close by the fade duration so the exit is visible; `faded` is the class set
 * for the surface's root. Reduced motion strips the transition (motion-safe),
 * so the panel snaps — the unmount delay is imperceptible there.
 *
 * A surface that is ALREADY open when the hook first runs still fades in
 * (`visible` starts false and the effect lifts it): the modals mount open,
 * and a fade that skipped the first open would be no fade at all.
 *
 * The fade is 140ms ON PURPOSE: these panels carry backdrop-blur, and an
 * animated frame over a live blur re-runs it on software rendering (the
 * frost-law cost) — a short, bounded, once-per-open fade is fine where an
 * unbounded per-hover transition was not.
 *
 * `enter: false` opens at once and fades only on close: a surface whose mount
 * is heavy (the scene picker's thirteen live thumbnails, each a GL context)
 * did all of that work behind an opacity of zero, so its fade-in read as a
 * delay before it appeared rather than as a fade.
 *
 * `rise: true` is for a panel seen from further off, a second screen's list on
 * a tablet: it fades in over 200ms rising 8px and settling, and out over 150ms
 * dropping 4px, the exit quicker so a dismiss stays brisk (140ms read as a pop
 * across a room). Only opacity and translate move (the touch-feel doctrine),
 * and a closing panel takes no touches while it fades.
 */
export function useFadePresence(
  open: boolean,
  { enter = true, rise = false }: { enter?: boolean; rise?: boolean } = {},
): { mounted: boolean; faded: string } {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open && !enter);

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (!enter) {
        setVisible(true);
        return;
      }
      // Two frames, not one: the mount renders at opacity-0 first, and the
      // class flip must land in a LATER frame or the browser coalesces them
      // and the fade-in never plays.
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), rise ? RISE_OUT_MS : FADE_MS);
    return () => clearTimeout(t);
  }, [open, enter, rise]);

  return { mounted, faded: fadeClasses(open, visible, rise) };
}

/** The classes for a fade's moment: opening (drawn, not yet shown), shown, or closing. */
export function fadeClasses(open: boolean, visible: boolean, rise: boolean): string {
  if (rise) return !open ? RISE_LEAVING : visible ? RISE_SHOWN : RISE_ENTERING;
  return cx(
    "motion-safe:transition-opacity motion-safe:duration-[140ms]",
    visible ? "opacity-100" : "opacity-0",
  );
}

const FADE_MS = 140;
const RISE_OUT_MS = 150;
// whole class strings, so Tailwind finds each one (the classes a transition runs on are the state
// it moves to: the shown state's ease-out for an entrance, the leaving state's ease-in for an exit)
const RISE_ENTERING = "opacity-0 translate-y-2";
const RISE_SHOWN =
  "opacity-100 translate-y-0 motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)]";
const RISE_LEAVING =
  "pointer-events-none opacity-0 translate-y-1 motion-safe:transition-[opacity,translate] motion-safe:duration-150 motion-safe:ease-[cubic-bezier(0.4,0,1,1)]";
