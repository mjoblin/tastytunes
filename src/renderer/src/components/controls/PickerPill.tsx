import { useLayoutEffect, useRef, useState } from "react";
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
 *
 * THE PILL HOLDS ITS WIDTH (user, 2026-10-10: choosing a genre resized the pill and moved
 * everything after it). Every label the pill can show sits in one grid cell, the shown one
 * as text and the rest invisible, so the pill is as wide as its widest label whatever is
 * chosen, up to LABEL_MAX_PX; a longer label truncates and the pill's tip names it. The
 * invisible ones draw their label from a data attribute (::before), so they give width and
 * nothing else: no text for a reader, a search or a screen reader. The options narrow as the
 * other facets do, so the labels a pill has offered this session are remembered (per id,
 * bounded by the library's own facet values): the width grows to a new widest, never shrinks.
 * A SETTING'S CHOICE TOO (`choice`, 0.13.0, his ask: Settings › Libraries' Recently added list in
 * "the app's dropdown widget" rather than a native select): always one value, so no clearing row
 * and a pick never toggles off, no counts, the chip in its resting look (gold says a filter is on),
 * the list under the chip's right edge.
 */
// 112 (user, 2026-10-11, from comparison shots): at 160 one long genre ("Contemporary Hip Hop")
// set its pill's width and the lens row wrapped at a 1,180 px window; at 112 the row fits
const LABEL_MAX_PX = 112;
const offered = new Map<string, Set<string>>();

function sizingLabels(id: string, neutral: string, labels: string[]): string[] {
  let seen = offered.get(id);
  if (!seen) offered.set(id, (seen = new Set()));
  seen.add(neutral);
  for (const l of labels) seen.add(l);
  return [...seen];
}

export function PickerPill({
  id,
  neutral,
  clearLabel,
  options,
  value,
  onChange,
  min,
  choice = false,
}: {
  id: string;
  neutral: string;
  /** The facet's clearing row ("Any decade"); a choice has none. */
  clearLabel?: string;
  options: Array<{ value: string; label: string; count?: number }>;
  value: string | null;
  onChange(value: string | null): void;
  /** A setting's choice rather than a facet (see above). */
  choice?: boolean;
  /** Options needed before the pill shows (default 2 — a facet that can't
   *  distinguish is furniture; DR passes 1: one known value still filters
   *  the analyzed from the rest). */
  min?: number;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  const active = value ? options.find((o) => o.value === value) : null;
  const shown = active ? active.label : neutral;
  const sizes = sizingLabels(
    id,
    neutral,
    options.map((o) => o.label),
  );
  useLayoutEffect(() => {
    const el = labelRef.current;
    setTruncated(el != null && el.scrollWidth > el.clientWidth);
  }, [shown, sizes.length]);
  if (options.length < (min ?? (choice ? 1 : 2))) return null;
  return (
    <div className="relative">
      <Chip
        state={active && !choice ? "active" : open ? "open" : "idle"}
        data-lens-picker={id}
        data-tip={truncated ? shown : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cx("no-drag gap-1 motion-safe:active:scale-95", truncated && "tip-bottom")}
      >
        {/* text-left: the label leads and the chevron closes the pill, as in a select (a button
            centres its text, and in a pill wider than its label the word sat adrift) */}
        <span className="grid min-w-0 text-left" style={{ maxWidth: LABEL_MAX_PX }}>
          {sizes.map((l) => (
            <span
              key={l}
              aria-hidden
              data-pill-size={l}
              className="col-start-1 row-start-1 min-w-0 overflow-hidden whitespace-nowrap invisible before:content-[attr(data-pill-size)]"
            />
          ))}
          <span ref={labelRef} className="col-start-1 row-start-1 min-w-0 truncate">
            {shown}
          </span>
        </span>
        <ChevronDown size={12} className={active && !choice ? "text-gold/70" : "text-faint"} />
      </Chip>
      {open && (
        <>
          <PopoverChrome onClose={() => setOpen(false)} />
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            data-lens-picker-popover={id}
            className={cx(
              "absolute top-full mt-1.5 z-30 w-56 max-h-72 overflow-y-auto",
              choice ? "right-0" : "left-0",
              POPOVER_CARD,
              "p-1.5 space-y-0.5",
            )}
          >
            {!choice && (
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
            )}
            {options.map((o) => (
              <button
                key={o.value}
                data-lens-chip={o.label}
                onClick={() => {
                  onChange(choice ? o.value : value === o.value ? null : o.value);
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
                {o.count != null && (
                  <span className="font-mono text-[10.5px] text-faint tabular-nums">
                    {fmtCount(o.count)}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
