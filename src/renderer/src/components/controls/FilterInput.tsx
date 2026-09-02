import { useEffect, useRef } from "react";
import { Search, X } from "lucide-react";
import { cx, fmtCount } from "@/lib/format";

/**
 * Compact text filter for the list screens' headers. `/` focuses it from
 * anywhere (useShortcuts); Escape clears, then blurs. Shows shown/total while
 * active; the value lives in the store per screen (session only), so an
 * active filter is always visible in the box.
 */
export function FilterInput({
  value,
  onChange,
  shown,
  total,
  onSubmit,
}: {
  value: string;
  onChange(value: string): void;
  shown: number;
  total: number;
  /** Optional Enter action (the Library escalates a filter to a full search). */
  onSubmit?(): void;
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Clicks on non-focusable chrome don't move focus off an input, so the
  // caret would keep blinking — blur explicitly when a press lands outside.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (
        document.activeElement === inputRef.current &&
        !wrapRef.current?.contains(e.target as Node)
      ) {
        inputRef.current?.blur();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      // unmounting while focused (screen switch) must restore window dragging
      document.documentElement.classList.remove("filter-focused");
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      // the whole box reads as an input — clicking anywhere in it focuses
      onClick={() => inputRef.current?.focus()}
      className={cx(
        "no-drag flex items-center gap-1.5 h-8 pl-2.5 pr-1.5 rounded-lg ring-1 transition-all",
        value ? "ring-gold/50 bg-golddim" : "ring-edge bg-panel/70 focus-within:ring-edge2",
      )}
    >
      <Search size={13} className={value ? "text-gold" : "text-faint"} />
      <input
        ref={inputRef}
        data-filter-input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // ESCAPE RELEASES FOCUS, NEVER CLEARS (user, 2026-08-23). A filter is
          // persistent state — remembered per screen and per folder — and the
          // most reflexive key on the keyboard must not destroy it; it used to
          // clear first and release on a second press, which cost the filter
          // every time someone wanted their hotkeys back. Clearing is the ✕
          // and ⌘⌫. Enter releases focus too: the natural end of typing hands
          // the hotkeys back without a reach for Escape.
          if (e.key === "Escape") {
            e.stopPropagation();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (onSubmit) onSubmit();
            else (e.target as HTMLInputElement).blur();
          }
        }}
        onFocus={() => document.documentElement.classList.add("filter-focused")}
        onBlur={() => document.documentElement.classList.remove("filter-focused")}
        placeholder="Filter"
        spellCheck={false}
        className="w-28 bg-transparent outline-none text-[12.5px] text-ink placeholder:text-faint"
      />
      {/* count + clear always occupy their space so the box never changes
          width — the slot is sized from THIS listing's total ("345/345"
          worst case), so no count it can ever show grows it */}
      <span
        className="font-mono text-[10.5px] text-dim tabular-nums text-right"
        style={{ minWidth: `${Math.max(9, fmtCount(total).length * 2 + 1)}ch` }}
      >
        {value ? `${fmtCount(shown)}/${fmtCount(total)}` : ""}
      </span>
      <button
        aria-label="Clear filter"
        onClick={() => onChange("")}
        className={cx(
          "p-1 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all",
          !value && "invisible pointer-events-none",
        )}
      >
        <X size={12} />
      </button>
    </div>
  );
}
