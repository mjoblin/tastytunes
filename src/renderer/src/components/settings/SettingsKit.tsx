import { useEffect, useState } from "react";
import { tt } from "@/api";
import { cx } from "@/lib/format";
import { Slider } from "@/components/controls/Slider";
import { Switch } from "@/components/controls/Switch";
import { useConfirmPopover } from "@/components/chrome/Confirm";

// The Settings screen's rows and controls, shared by its sections (split out of
// SettingsScreen.tsx 2026-09-13 with the sections): a setting row, the toggle, the
// slider, the segmented switch, the number field, the legend row, the cache row
// and the byte formatter. The segmented switch is the app's one Segmented
// (components/controls) since 2026-09-13; the kit had carried a near-copy.

export const fmtBytes = (b: number): string =>
  b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

/**
 * The Libraries tab: every media server the streamer has listed, each with
 * its index state — the rebuildable metadata cache behind instant library
 * search. Searchable servers build and refresh themselves (unless automatic
 * building is off); Browse-only servers get a Build button (a walk can be
 * slow, so it stays the user's call).
 */
export function CacheRow(): React.JSX.Element {
  const [stats, setStats] = useState<{ entries: number; bytes: number } | null>(null);
  useEffect(() => {
    void tt.lookupCacheStats().then(setStats);
  }, []);
  const empty = stats != null && stats.entries === 0;
  // a cache clears with the record's confirm (user, 2026-09-14): the copies come back
  // on their own, but filling them again can take a while, and the ask is a quick one
  const confirmClear = useConfirmPopover();
  return (
    <SettingRow
      label="Cached lookups"
      hint="Lyrics, artist, and album lookups are kept on disk (a fixed size; the entries you haven't used longest drop first) so repeat plays don't re-ask the services above. The panels' refresh buttons overwrite the stored copy."
    >
      {confirmClear.popover}
      <button
        onClick={(e) =>
          confirmClear.ask(e, {
            question:
              "Clear the cached lookups? Lyrics, artist and album details are fetched again as they are needed.",
            verb: "Clear",
            onConfirm: () => void tt.clearLookupCaches().then(setStats),
          })
        }
        disabled={empty}
        className="shrink-0 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all disabled:opacity-40 disabled:hover:text-dim disabled:hover:ring-edge disabled:hover:bg-panel/70"
      >
        {stats == null
          ? "…"
          : empty
            ? "Cache empty"
            : `Clear (${stats.entries} · ${fmtBytes(stats.bytes)})`}
      </button>
    </SettingRow>
  );
}

export function NumberField({
  value,
  min,
  max,
  allowEmpty,
  placeholder,
  widthClass,
  onCommit,
}: {
  value: number | null;
  min: number;
  max: number;
  allowEmpty?: boolean;
  placeholder?: string;
  widthClass: string;
  onCommit(next: number | null): void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    if (draft === null) return;
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (allowEmpty) onCommit(null);
    } else {
      const n = Number(trimmed);
      if (!Number.isNaN(n)) onCommit(Math.max(min, Math.min(max, Math.round(n))));
    }
    setDraft(null);
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft ?? value ?? ""}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") setDraft(null);
      }}
      className={cx(
        widthClass,
        "bg-bg rounded-lg ring-1 ring-edge focus:ring-edge2 outline-none px-3 py-1.5 text-[13px] font-mono",
      )}
    />
  );
}

export function LegendRow({
  swatch,
  label,
  desc,
}: {
  swatch: React.ReactNode;
  label: string;
  desc: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span className="w-4 flex justify-center shrink-0">{swatch}</span>
      <span className="text-[12.5px] w-32 shrink-0">{label}</span>
      <span className="text-[11.5px] text-faint">{desc}</span>
    </div>
  );
}

/**
 * Sidebar card (Layout tab): a row per screen in registry order with an eye
 * toggle to hide/show it in the left nav — the way to un-hide, mirroring the
 * right-click "Hide from left nav" verb on the nav itself. now-playing is locked
 * (never hideable). Below a divider, the pinned bottom-cluster tools (Commands,
 * Mini player) get the same toggle; Settings is shown locked, last, for
 * completeness. Hidden items stay reachable by their keyboard shortcut / route.
 */
export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6">
      <div>
        <div className="text-[13.5px]">{label}</div>
        <div className="text-[11.5px] text-faint max-w-sm">{hint}</div>
      </div>
      {children}
    </div>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}): React.JSX.Element {
  return (
    <label
      className={cx(
        "flex items-center justify-between gap-6",
        disabled ? "opacity-40 pointer-events-none" : "cursor-pointer",
      )}
    >
      <div>
        <div className="text-[13.5px]">{label}</div>
        <div className="text-[11.5px] text-faint max-w-sm">{hint}</div>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </label>
  );
}

export function SliderSetting({
  label,
  hint,
  min,
  max,
  unit,
  value,
  onCommit,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  unit: string;
  value: number;
  onCommit(next: number): void;
}): React.JSX.Element {
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? value;
  const toValue = (ratio: number): number => Math.round(min + ratio * (max - min));

  return (
    <SettingRow label={label} hint={hint}>
      <div className="flex items-center gap-3 w-52 shrink-0">
        <div className="flex-1">
          <Slider
            value={(shown - min) / (max - min)}
            ariaLabel={label}
            thumb="always"
            onScrub={(r) => setScrub(toValue(r))}
            onCancel={() => setScrub(null)}
            onCommit={(r) => {
              setScrub(null);
              onCommit(toValue(r));
            }}
          />
        </div>
        <span className="font-mono text-[11px] text-dim w-12 text-right tabular-nums">
          {shown}
          {unit}
        </span>
      </div>
    </SettingRow>
  );
}
