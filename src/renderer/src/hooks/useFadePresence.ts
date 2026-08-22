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
 */
export function useFadePresence(open: boolean): { mounted: boolean; faded: string } {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames, not one: the mount renders at opacity-0 first, and the
      // class flip must land in a LATER frame or the browser coalesces them
      // and the fade-in never plays.
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 140);
    return () => clearTimeout(t);
  }, [open]);

  return {
    mounted,
    faded: cx(
      "motion-safe:transition-opacity motion-safe:duration-[140ms]",
      visible ? "opacity-100" : "opacity-0",
    ),
  };
}
