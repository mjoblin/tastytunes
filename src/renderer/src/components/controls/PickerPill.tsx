import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Chip } from "@/components/chrome/Chrome";
import { POPOVER_CARD } from "@/components/chrome/Overlay";
import { PopoverChrome } from "@/hooks/usePopover";
import { cx, fmtCount } from "@/lib/format";

/**
 * A FACET PICKER: a chip that names the facet (or its chosen value) and opens
 * a popover of count-carrying options; the first row clears. One home
 * (2026-09-05, moved out of the Library lenses when the History Timeline
 * grew its own facets): the Albums and Tracks lenses' Genre / Decade / Format
 * / DR / Played pickers and the Timeline's Source / Period.
 */
export function PickerPill({
  id,
  neutral,
  clearLabel,
  options,
  value,
  onChange,
  min,
}: {
  id: string;
  neutral: string;
  clearLabel: string;
  options: Array<{ value: string; label: string; count: number }>;
  value: string | null;
  onChange(value: string | null): void;
  /** Options needed before the pill shows (default 2 — a facet that can't
   *  distinguish is furniture; DR passes 1: one known value still filters
   *  the analyzed from the rest). */
  min?: number;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (options.length < (min ?? 2)) return null;
  const active = value ? options.find((o) => o.value === value) : null;
  return (
    <div className="relative">
      <Chip
        state={active ? "active" : open ? "open" : "idle"}
        data-lens-picker={id}
        onClick={() => setOpen((o) => !o)}
        className="no-drag gap-1 motion-safe:active:scale-95"
      >
        {active ? active.label : neutral}
        <ChevronDown size={12} className={active ? "text-gold/70" : "text-faint"} />
      </Chip>
      {open && (
        <>
          <PopoverChrome onClose={() => setOpen(false)} />
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            data-lens-picker-popover={id}
            className={cx(
              "absolute left-0 top-full mt-1.5 z-30 w-56 max-h-72 overflow-y-auto",
              POPOVER_CARD,
              "p-1.5 space-y-0.5",
            )}
          >
            <button
              data-lens-chip={clearLabel}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className={cx(
                "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[13px] transition-colors",
                value === null ? "text-gold bg-golddim" : "text-dim hover:text-ink hover:bg-veil",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{clearLabel}</span>
            </button>
            {options.map((o) => (
              <button
                key={o.value}
                data-lens-chip={o.label}
                onClick={() => {
                  onChange(value === o.value ? null : o.value);
                  setOpen(false);
                }}
                className={cx(
                  "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[13px] transition-colors",
                  value === o.value
                    ? "text-gold bg-golddim"
                    : "text-dim hover:text-ink hover:bg-veil",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <span className="font-mono text-[10.5px] text-faint tabular-nums">
                  {fmtCount(o.count)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
