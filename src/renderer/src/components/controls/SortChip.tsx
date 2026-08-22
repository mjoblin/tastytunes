import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cx } from "@/lib/format";
import { PopoverChrome } from "@/hooks/usePopover";
import { POPOVER_CARD } from "@/components/chrome/Overlay";
import { HeaderChip } from "@/components/chrome/Chrome";

/**
 * The sort control chip + popover (lifted from LibraryScreen so the library
 * lenses share it): gold when any non-neutral sort or reverse is active;
 * clicking the active sort flips its direction unless it's noReverse.
 */
export function SortChip<T extends string>({
  sorts,
  neutral,
  value,
  reversed,
  onChange,
  onToggleReverse,
}: {
  sorts: Array<{ value: T; label: string; noReverse?: boolean }>;
  /** The unlit default (server order / relevance). */
  neutral: T;
  value: T;
  reversed: boolean;
  onChange(value: T): void;
  onToggleReverse(): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <HeaderChip
        active={value !== neutral || reversed}
        data-tip="Sort"
        aria-label="Sort"
        onClick={() => setOpen((o) => !o)}
        className="no-drag tip-bottom p-2"
      >
        <ArrowUpDown size={16} />
      </HeaderChip>
      {open && (
        <>
          <PopoverChrome onClose={() => setOpen(false)} />
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            className={cx(
              "absolute right-0 top-full mt-1.5 z-30 w-48",
              POPOVER_CARD,
              "p-1.5 space-y-0.5",
            )}
          >
            {sorts.map((s) => {
              const active = s.value === value;
              return (
                <button
                  key={s.value}
                  onClick={() => {
                    // clicking the active sort flips its direction
                    if (active) {
                      if (s.noReverse) return setOpen(false);
                      onToggleReverse();
                    } else {
                      setOpen(false);
                      onChange(s.value);
                    }
                  }}
                  aria-label={active && !s.noReverse ? `${s.label} — click to reverse` : s.label}
                  className={cx(
                    "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[13px] transition-colors",
                    active ? "text-gold bg-golddim" : "text-dim hover:text-ink hover:bg-veil",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{s.label}</span>
                  {active &&
                    !s.noReverse &&
                    (reversed ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
                </button>
              );
            })}
            <div className="px-2.5 pt-1 pb-0.5 text-[10.5px] text-faint">
              Click the active sort to reverse it
            </div>
          </div>
        </>
      )}
    </div>
  );
}
