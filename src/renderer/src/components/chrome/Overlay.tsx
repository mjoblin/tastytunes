import { useRef } from "react";
import { createPortal } from "react-dom";
import { cx } from "@/lib/format";
import { PopoverChrome, usePopoverChrome, useClampedPosition } from "@/hooks/usePopover";
import { useFadePresence } from "@/hooks/useFadePresence";

/**
 * The two overlay shells. Every transient surface in the app is one of these:
 * a POPOVER anchored at a click, or a MODAL centred over a dimmed room.
 *
 * They existed as ~10 hand-rolled copies of the same four lines (portal,
 * backdrop, clamp, card classes) — the copies had already started to drift,
 * which is what a shell prevents.
 */

/**
 * The popover card surface. Exported on its own for the ANCHORED dropdowns
 * (SortChip, the lens rails' "+N more" and picker pills) which position
 * themselves against their trigger with `absolute top-full` and so have no use
 * for the portal or the click-point clamp — they take the surface and nothing
 * else, deliberately.
 *
 * NB the playback-bar dropdowns (sleep timer, device switcher, signal lamp) and
 * the preset-volume popover wear `shadow-2xl` rather than `shadow-xl`. That is
 * either drift or a deliberate lift over the bar; either way changing it is a
 * visible change, so they are left alone here.
 */
export const POPOVER_CARD = "rounded-xl ring-1 ring-edge2 bg-raised shadow-xl";

/**
 * A popover anchored at a click point: portaled to <body>, backed by a
 * full-window click-catcher, clamped on-screen by its measured size, and
 * mounting the popover chrome (Escape-capture + inert drag regions).
 *
 * PORTALED ON PURPOSE — rows on several of these screens are dnd-kit
 * sortables, and a sortable's transform makes it a containing block that would
 * trap a fixed-position card (see the renderer conventions).
 *
 * `width` is a Tailwind width class and `className` carries the padding and
 * spacing; the card surface itself is never a caller's business.
 */
export function PopoverCard({
  at,
  width,
  onClose,
  rightClickCloses = false,
  className,
  children,
  ...rest
}: {
  /** Where the click happened — the card is clamped to stay fully on-screen. */
  at: { x: number; y: number };
  /** Tailwind width class: w-52, w-[272px]. */
  width: string;
  onClose(): void;
  /** Menus opened by right-click also dismiss on right-click elsewhere. */
  rightClickCloses?: boolean;
  /** Padding/spacing for the card's contents. */
  className?: string;
  children: React.ReactNode;
} & Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "className" | "children" | "style"
>): React.JSX.Element {
  usePopoverChrome(onClose);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pos = useClampedPosition(boxRef, at.x, at.y);

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={rightClickCloses ? onClose : undefined}
      />
      <div
        ref={boxRef}
        className={cx("fixed z-50", width, POPOVER_CARD, className)}
        style={pos}
        {...rest}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/**
 * A centred modal over the dimmed, blurred room: backdrop click closes, the
 * panel swallows its own clicks.
 *
 * `escapeCloses` mounts the popover chrome for modals that own their own open
 * state (the save-queue dialog). The two store-backed overlays — shortcuts and
 * info — are closed by the app's global Escape cascade instead, and mounting a
 * second handler here would just fight it.
 *
 * FADES IN AND OUT (2026-08-16, user call: the modals popped while the Now
 * Playing side panels faded). Presence is the shell's, not the caller's:
 * pass `open` and keep the shell MOUNTED across close, and the shell holds the
 * room for one `useFadePresence` beat (140ms — the frost-law budget, see the
 * hook) before rendering nothing. While it fades out it keeps showing the
 * LAST children it was given while open, so a caller whose content is
 * derived from a value that becomes null on close (the Info modal's target)
 * needs no ghost of its own; the exiting surface takes no clicks. A caller
 * that still mounts conditionally gets the fade IN and a pop out — every
 * shell caller passes `open` for that reason.
 */
export function ModalShell({
  open = true,
  onClose,
  escapeCloses = false,
  className,
  children,
}: {
  /** Keep the shell mounted and flip this — the exit fade needs the DOM. */
  open?: boolean;
  onClose(): void;
  escapeCloses?: boolean;
  /** Panel geometry — width, max-*, flex, padding. The surface is the shell's. */
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const { mounted, faded } = useFadePresence(open);
  const shown = useRef(children);
  if (open) shown.current = children;
  if (!mounted) return null;
  return (
    // THE BLUR STAYS; HOVER TRANSITIONS INSIDE THE SHELL GO (2026-08-04,
    // measured round). The frosted backdrop is what dissolves the room's
    // text at the card edge — a dim alone (tried at /70 and /80) leaves
    // sharp glyph fragments there, and the user called both ugly. The cost
    // was never the blur at rest: on the software path (GPU-less VMs, RDP)
    // every repaint over the blur re-runs it at ~50-120ms, so an ANIMATED
    // hover (transition-all, ~150ms of frames) crawled at 117ms/frame p95.
    // Untransitioned hovers pay ONE such frame per state flip (50ms p95
    // measured) — the palette has lived exactly this way over the same blur
    // all along. So: no transition-* on hover-styled elements inside a
    // ModalShell. Also measured, don't re-try: blur as a childless sibling
    // layer (108ms p95) and will-change card promotion (117ms) — software
    // compositing re-rasterizes the filter regardless of the layer tree.
    //
    // PORTALED TO <body>, fixed: a modal dims the WHOLE room — nav rail and
    // playback bar included — wherever it happens to render. The save-queue
    // dialog mounts inside the Queue screen's content container, and its
    // inset-0 dimmed only that area while the app-level Info/Shortcuts
    // modals covered the window (user call, 2026-08-04): coverage must not
    // depend on the mount point.
    createPortal(
      <div
        className={cx(
          "fixed inset-0 z-30 bg-black/60 backdrop-blur-sm flex items-center justify-center",
          faded,
          !open && "pointer-events-none",
        )}
        data-modal-open={open ? "" : undefined}
        onClick={onClose}
      >
        {escapeCloses && open && <PopoverChrome onClose={onClose} />}
        <div
          className={cx("rounded-2xl bg-panel ring-1 ring-edge2 shadow-2xl", className)}
          onClick={(e) => e.stopPropagation()}
        >
          {open ? children : shown.current}
        </div>
      </div>,
      document.body,
    )
  );
}
