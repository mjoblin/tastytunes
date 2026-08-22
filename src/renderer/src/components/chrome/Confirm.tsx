import { useState } from "react";
import { PopoverCard } from "@/components/chrome/Overlay";

/**
 * The destructive-action confirm: a small popover anchored under the control
 * that asked, with the question spelled out and an explicit pair of buttons.
 *
 * THIS REPLACES THE IN-PLACE "Sure?" MORPH for icon-button deletes (law
 * changed 2026-08-03, user call). The morph swapped a trash glyph for text
 * INSIDE the button, which resized it and shoved everything beside it — a
 * confirm whose arrival moves the thing you're aiming at. The popover leaves
 * the trigger untouched at any size, names what's about to happen, and gives
 * cancel a real button instead of "click anywhere else and hope".
 *
 * Dismissal: Escape and click-away both cancel (PopoverCard's chrome), and
 * Cancel takes initial focus so Enter is always the SAFE answer — the
 * destructive verb is a deliberate reach, exactly one click or Tab away.
 *
 * WHERE THE TWO-TAP SURVIVES: the preset-save slot grid (LibraryMenus) keeps
 * `useConfirmTap` — its cells are fixed squares, so the in-place arm shifts
 * nothing, and it lives inside a popover already, where stacking a second
 * card would fight the first. The rule that emerges: an in-place arm is fine
 * ONLY where the control's box cannot change; everywhere else, this popover.
 *
 * Confirms remain for what CAN'T be undone (the standing rule) — anything
 * with a working undo stays instant.
 *
 * ```
 * const confirm = useConfirmPopover()
 * <button onClick={(e) => confirm.ask(e, { question: `Delete “${name}”?`, onConfirm: del })} />
 * {confirm.popover}
 * ```
 */
export function useConfirmPopover(): {
  /** Open the confirm, anchored under the event's currentTarget. */
  ask(
    e: { currentTarget: Element },
    opts: { question: string; verb?: string; onConfirm(): void },
  ): void;
  /** Render this once, near the trigger (portaled, so position is free). */
  popover: React.ReactNode;
} {
  const [open, setOpen] = useState<{
    at: { x: number; y: number };
    question: string;
    verb: string;
    onConfirm(): void;
  } | null>(null);

  const ask: ReturnType<typeof useConfirmPopover>["ask"] = (e, opts) => {
    const r = e.currentTarget.getBoundingClientRect();
    setOpen({
      at: { x: r.left, y: r.bottom + 6 },
      question: opts.question,
      verb: opts.verb ?? "Delete",
      onConfirm: opts.onConfirm,
    });
  };

  const popover = open != null && (
    <PopoverCard at={open.at} width="w-60" onClose={() => setOpen(null)} className="p-3">
      <div className="text-[12.5px] text-ink leading-snug">{open.question}</div>
      <div className="mt-2.5 flex items-center justify-end gap-1.5">
        <button
          autoFocus
          onClick={() => setOpen(null)}
          className="px-2.5 py-1 rounded-lg text-[12px] ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            const fire = open.onConfirm;
            setOpen(null);
            fire();
          }}
          className="px-2.5 py-1 rounded-lg text-[12px] bg-alert text-white hover:brightness-110 motion-safe:active:scale-95 transition-all"
        >
          {open.verb}
        </button>
      </div>
    </PopoverCard>
  );

  return { ask, popover };
}
