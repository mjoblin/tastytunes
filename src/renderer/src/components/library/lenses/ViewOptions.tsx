import { useState } from "react";
import { LayoutGrid, Rows3, SlidersHorizontal } from "lucide-react";
import {
  type AppSettings,
  CARD_GAP_RANGE,
  CARD_SIZE_RANGE,
  type ScreenLayout,
} from "@shared/model";
import { useStore } from "@/store";
import { cx } from "@/lib/format";
import { PopoverChrome } from "@/hooks/usePopover";
import { POPOVER_CARD } from "@/components/chrome/Overlay";
import { HeaderChip } from "@/components/chrome/Chrome";
import { Segmented } from "@/components/controls/Segmented";
import { Slider } from "@/components/controls/Slider";
import { Switch } from "@/components/controls/Switch";

/** The view a menu dresses: albums (the Albums view and the artist page), artists, or tracks. */
export type ViewKind = "albums" | "artists" | "tracks";

// Each kind's own Rows or Cards and Format and DR (his note on "View Options": albums and tracks
// keep separate display settings). The Artists view shares the albums' Rows or Cards, the
// Library's one choice before tracks had their own, and has no format line. Card size, gap and
// Fill rows are every card grid's, as in Settings › Layout (his answer, 2026-10-26).
const layoutOf = (s: AppSettings, kind: ViewKind): ScreenLayout =>
  kind === "tracks" ? s.lensTracksLayout : s.libraryLayout;
const formatOf = (s: AppSettings, kind: ViewKind): boolean | null =>
  kind === "albums" ? s.albumCardFormat : kind === "tracks" ? s.trackCardFormat : null;
const layoutPatch = (kind: ViewKind, v: ScreenLayout): Partial<AppSettings> =>
  kind === "tracks" ? { lensTracksLayout: v } : { libraryLayout: v };
const formatPatch = (kind: ViewKind, v: boolean): Partial<AppSettings> =>
  kind === "tracks" ? { trackCardFormat: v } : { albumCardFormat: v };
/** The view whose settings a Match button copies: albums and tracks match each other. */
const OTHER: Record<ViewKind, { kind: ViewKind; name: string } | null> = {
  albums: { kind: "tracks", name: "Tracks" },
  artists: null,
  tracks: { kind: "albums", name: "Albums" },
};

/**
 * VIEW OPTIONS (0.13.0-rc.4, his picks on "View Options": one button with Rows or Cards inside,
 * the sliders icon, every card option in Settings › Layout, on the Library's views first). One
 * button at a view's toolbar end, beside Sort, in place of the Rows or Cards button it holds: Rows
 * or Cards, the format line's switch where the view has one, card size, gap and Fill rows, and on
 * the albums' and tracks' menus a button that copies the other's Rows or Cards and Format and DR,
 * which Undo reverses (his note: users may want albums and tracks to differ, and an easy way to
 * match them). The same settings Settings › Layout holds, so the two always agree.
 */
export function ViewOptions({ kind }: { kind: ViewKind }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const layout = layoutOf(settings, kind);
  const format = formatOf(settings, kind);
  const other = OTHER[kind];
  const matches =
    other != null &&
    layoutOf(settings, other.kind) === layout &&
    formatOf(settings, other.kind) === format;
  const match = (): void => {
    if (!other) return;
    const s = useStore.getState().settings;
    const before = {
      ...layoutPatch(kind, layoutOf(s, kind)),
      ...formatPatch(kind, formatOf(s, kind) ?? true),
    };
    setOpen(false);
    void saveSettings({
      ...layoutPatch(kind, layoutOf(s, other.kind)),
      ...formatPatch(kind, formatOf(s, other.kind) ?? true),
    });
    const { pushUndo, runUndo, showToast } = useStore.getState();
    const undoId = pushUndo(`Match ${other.name} View`, () => {
      void useStore.getState().saveSettings(before);
    });
    showToast({
      kind: "success",
      text: `Matched the ${other.name} view`,
      action: { label: "Undo", undo: () => runUndo(undoId) },
    });
  };
  return (
    <div className="relative">
      <HeaderChip
        active={open}
        data-tip={open ? undefined : "View options"}
        aria-label="View options"
        aria-expanded={open}
        data-view-options={kind}
        onClick={() => setOpen((o) => !o)}
        className="no-drag tip-bottom p-2"
      >
        <SlidersHorizontal size={16} />
      </HeaderChip>
      {open && (
        <>
          <PopoverChrome onClose={() => setOpen(false)} />
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            data-view-menu={kind}
            className={cx("absolute right-0 top-full mt-1.5 z-30 w-64", POPOVER_CARD, "p-1.5")}
          >
            <div className="microlabel px-2.5 pt-1 pb-1.5">View</div>
            <div className="px-1 pb-1">
              <Segmented<ScreenLayout>
                value={layout}
                onChange={(v) => void saveSettings(layoutPatch(kind, v))}
                options={[
                  { value: "rows", label: "Rows", icon: <Rows3 size={14} /> },
                  { value: "cards", label: "Cards", icon: <LayoutGrid size={14} /> },
                ]}
                className="w-full [&>button]:flex-1 [&>button]:justify-center"
              />
            </div>
            <MenuRule />
            {format != null && (
              <MenuRow label="Format and DR">
                <Switch
                  checked={format}
                  onChange={(v) => void saveSettings(formatPatch(kind, v))}
                />
              </MenuRow>
            )}
            <MenuSlider
              label="Card size"
              range={CARD_SIZE_RANGE}
              value={settings.presetCardSize}
              onCommit={(presetCardSize) => void saveSettings({ presetCardSize })}
            />
            <MenuSlider
              label="Card gap"
              range={CARD_GAP_RANGE}
              value={settings.presetGap}
              onCommit={(presetGap) => void saveSettings({ presetGap })}
            />
            <MenuRow label="Fill rows">
              <Switch
                checked={settings.presetFillRows}
                onChange={(presetFillRows) => void saveSettings({ presetFillRows })}
              />
            </MenuRow>
            {other && (
              <>
                <MenuRule />
                <button
                  data-view-match={other.kind}
                  disabled={matches}
                  onClick={match}
                  className="w-full px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim enabled:hover:text-ink enabled:hover:bg-veil transition-colors disabled:opacity-50"
                >
                  <span className="block">Match the {other.name} view</span>
                  <span className="block text-[10.5px] text-faint">
                    {matches ? "Already the same" : "Rows or Cards, and Format and DR"}
                  </span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MenuRule(): React.JSX.Element {
  return <div className="mx-1.5 my-1.5 h-px bg-edge" />;
}

function MenuRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-dim">
      <span className="flex-1">{label}</span>
      {children}
    </div>
  );
}

/** A setting's slider in the menu: Settings › Layout's, its value shown while it moves. */
function MenuSlider({
  label,
  range,
  value,
  onCommit,
}: {
  label: string;
  range: { min: number; max: number };
  value: number;
  onCommit(next: number): void;
}): React.JSX.Element {
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? value;
  const toValue = (ratio: number): number =>
    Math.round(range.min + ratio * (range.max - range.min));
  return (
    <div className="px-2.5 py-1.5 text-[13px] text-dim">
      <div className="flex items-center gap-2">
        <span className="flex-1">{label}</span>
        <span className="font-mono text-[11px] tabular-nums">{shown}px</span>
      </div>
      <div className="pt-1.5">
        <Slider
          value={(shown - range.min) / (range.max - range.min)}
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
    </div>
  );
}
