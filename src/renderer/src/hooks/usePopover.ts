import { useEffect, useLayoutEffect, useState } from "react";

/**
 * Popover plumbing shared by every transient popover in the app (⋯ menus,
 * preset picker, sort chip, sleep timer, device switcher, signal lamp,
 * preset-volume): Escape closes (capture phase, so the app's Escape cascade
 * underneath doesn't also fire), and drag regions go inert while open so the
 * full-window click-catcher can hear clicks on the header (app-region
 * swallows pointer events natively). Every popover MUST mount this — a
 * popover without it leaks Escape to whatever sits underneath.
 */
export function usePopoverChrome(onClose: () => void): void {
  useEffect(() => {
    document.documentElement.classList.add("popover-open");
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.documentElement.classList.remove("popover-open");
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
}

/**
 * Component form of usePopoverChrome for popovers rendered inside a
 * conditional (`{open && ...}`) — mount it alongside the panel instead of
 * restructuring the component around the hook rule.
 */
export function PopoverChrome({ onClose }: { onClose(): void }): null {
  usePopoverChrome(onClose);
  return null;
}

/** Clamp a click-anchored popover fully on-screen using its MEASURED size. */
export function useClampedPosition(
  ref: React.RefObject<HTMLDivElement | null>,
  x: number,
  y: number,
): { left: number; top: number } {
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(12, Math.min(x, window.innerWidth - r.width - 12)),
      top: Math.max(12, Math.min(y, window.innerHeight - r.height - 12)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);
  return pos;
}
