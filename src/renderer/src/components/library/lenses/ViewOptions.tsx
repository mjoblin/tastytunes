import { useRef, useState } from "react";
import { LayoutGrid, Rows3, SlidersHorizontal, Undo2 } from "lucide-react";
import {
  type AppSettings,
  CARD_GAP_RANGE,
  CARD_SIZE_RANGE,
  DEFAULT_SETTINGS,
  type ScreenLayout,
} from "@shared/model";
import { useStore } from "@/store";
import { cx } from "@/lib/format";
import { PopoverChrome } from "@/hooks/usePopover";
import { POPOVER_CARD } from "@/components/chrome/Overlay";
import { HeaderChip } from "@/components/chrome/Chrome";
import { Segmented } from "@/components/controls/Segmented";
import { Slider, useSliderDraft } from "@/components/controls/Slider";
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
const NAME: Record<ViewKind, string> = { albums: "Albums", artists: "Artists", tracks: "Tracks" };
/** The view whose settings a Match button copies: albums and tracks match each other. */
const OTHER: Record<ViewKind, ViewKind | null> = {
  albums: "tracks",
  artists: null,
  tracks: "albums",
};
/** Everything a kind's menu sets, at its defaults: what Reset to defaults puts back. */
const defaultsOf = (kind: ViewKind): Partial<AppSettings> => ({
  ...layoutPatch(kind, layoutOf(DEFAULT_SETTINGS, kind)),
  ...(kind === "artists" ? {} : formatPatch(kind, formatOf(DEFAULT_SETTINGS, kind) ?? true)),
  presetCardSize: DEFAULT_SETTINGS.presetCardSize,
  presetGap: DEFAULT_SETTINGS.presetGap,
  presetFillRows: DEFAULT_SETTINGS.presetFillRows,
});
const sameAs = (s: AppSettings, patch: Partial<AppSettings>): boolean =>
  Object.entries(patch).every(([k, v]) => s[k as keyof AppSettings] === v);

// THE OPEN MENU'S SESSION, held across a remount: the Tracks view mounts afresh when it turns
// between rows and cards (each its own top and spot), and the menu that turned it stays open
// with its changes still undoable. `reopen` is set by that change alone, so a menu closed any
// other way never reopens by itself.
const session: { reopen: ViewKind | null; undos: number[] } = { reopen: null, undos: [] };

/**
 * VIEW OPTIONS (0.13.0-rc.4, his picks on "View Options": one button with Rows or Cards inside,
 * the sliders icon, every card option in Settings › Layout, on the Library's views first). One
 * button at a view's toolbar end, beside Sort, in place of the Rows or Cards button it holds: Rows
 * or Cards, the format line's switch where the view has one, card size, gap and Fill rows (the
 * cards follow a slider as it moves), and on the albums' and tracks' menus a button that copies
 * the other's Rows or Cards and Format and DR (his note: users may want albums and tracks to
 * differ, and an easy way to match them). The same settings Settings › Layout holds, so the two
 * always agree. NOTHING IN IT IS A ONE-WAY DOOR (his ask: "i want the user to feel like they're
 * not getting into an unwanted/unexpected state when playing with these settings"): every change
 * goes on the undo stack (Cmd-Z), the menu's own Undo steps back through the changes made since
 * it opened, and Reset to defaults puts everything it holds back, itself undoable.
 */
export function ViewOptions({ kind }: { kind: ViewKind }): React.JSX.Element {
  const [open, setOpenState] = useState(() => {
    const reopen = session.reopen === kind;
    if (reopen) session.reopen = null;
    return reopen;
  });
  const [undos, setUndosState] = useState<number[]>(() => (open ? session.undos : []));
  const setUndos = (next: number[]): void => {
    session.undos = next;
    setUndosState(next);
  };
  const setOpen = (next: boolean): void => {
    if (next && !open) setUndos([]);
    setOpenState(next);
  };
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const layout = layoutOf(settings, kind);
  const format = formatOf(settings, kind);
  const other = OTHER[kind];
  const matches =
    other != null && layoutOf(settings, other) === layout && formatOf(settings, other) === format;
  const defaults = defaultsOf(kind);
  const atDefaults = sameAs(settings, defaults);

  /** A change from the menu: saved, and undoable from the menu's Undo and Cmd-Z alike. `before`
   *  is what to put back, when the store already shows the change (a slider's live preview). */
  const change = (
    label: string,
    patch: Partial<AppSettings>,
    before?: Partial<AppSettings>,
  ): void => {
    const s = useStore.getState().settings;
    const prior: Partial<AppSettings> =
      before ?? Object.fromEntries(Object.keys(patch).map((k) => [k, s[k as keyof AppSettings]]));
    if (sameAs({ ...s, ...prior }, patch)) return;
    // the Tracks view remounts as it turns between rows and cards: its menu comes back open
    if (
      kind === "tracks" &&
      patch.lensTracksLayout &&
      patch.lensTracksLayout !== s.lensTracksLayout
    )
      session.reopen = kind;
    void saveSettings(patch);
    const id = useStore.getState().pushUndo(label, () => {
      void useStore.getState().saveSettings(prior);
    });
    setUndos([...session.undos, id]);
  };
  const undo = (): void => {
    const { runUndo } = useStore.getState();
    const rest = [...session.undos];
    // an entry Cmd-Z has already used is gone from the stack: step past it
    for (let id = rest.pop(); id != null; id = rest.pop()) if (runUndo(id)) break;
    setUndos(rest);
  };
  const match = (): void => {
    if (!other) return;
    const s = useStore.getState().settings;
    const before = {
      ...layoutPatch(kind, layoutOf(s, kind)),
      ...formatPatch(kind, formatOf(s, kind) ?? true),
    };
    setOpen(false);
    void saveSettings({
      ...layoutPatch(kind, layoutOf(s, other)),
      ...formatPatch(kind, formatOf(s, other) ?? true),
    });
    const { pushUndo, runUndo, showToast } = useStore.getState();
    const undoId = pushUndo(`Match ${NAME[other]} View`, () => {
      void useStore.getState().saveSettings(before);
    });
    showToast({
      kind: "success",
      text: `Matched the ${NAME[other]} view`,
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
        onClick={() => setOpen(!open)}
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
                onChange={(v) =>
                  change(
                    `Show ${NAME[kind]} as ${v === "rows" ? "Rows" : "Cards"}`,
                    layoutPatch(kind, v),
                  )
                }
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
                  onChange={(v) =>
                    change(`${v ? "Show" : "Hide"} Format and DR`, formatPatch(kind, v))
                  }
                />
              </MenuRow>
            )}
            <MenuSlider
              label="Card size"
              range={CARD_SIZE_RANGE}
              value={settings.presetCardSize}
              live={(v) => ({ presetCardSize: v })}
              onCommit={(v, from) =>
                change("Change Card Size", { presetCardSize: v }, { presetCardSize: from })
              }
            />
            <MenuSlider
              label="Card gap"
              range={CARD_GAP_RANGE}
              value={settings.presetGap}
              live={(v) => ({ presetGap: v })}
              onCommit={(v, from) =>
                change("Change Card Gap", { presetGap: v }, { presetGap: from })
              }
            />
            <MenuRow label="Fill rows">
              <Switch
                checked={settings.presetFillRows}
                onChange={(v) =>
                  change(`Turn ${v ? "On" : "Off"} Fill Rows`, { presetFillRows: v })
                }
              />
            </MenuRow>
            {other && (
              <>
                <MenuRule />
                <button
                  data-view-match={other}
                  disabled={matches}
                  onClick={match}
                  className="w-full px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim enabled:hover:text-ink enabled:hover:bg-veil transition-colors disabled:opacity-50"
                >
                  <span className="block">Match the {NAME[other]} view</span>
                  <span className="block text-[10.5px] text-dim">
                    {matches ? "Already the same" : "Rows or Cards, and Format and DR"}
                  </span>
                </button>
              </>
            )}
            <MenuRule />
            <div className="flex items-center gap-1">
              <button
                data-view-undo
                disabled={undos.length === 0}
                onClick={undo}
                data-tip="Undo the last change"
                className="tip-bottom flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] text-dim enabled:hover:text-ink enabled:hover:bg-veil transition-colors disabled:opacity-40"
              >
                <Undo2 size={13} />
                Undo
              </button>
              <button
                data-view-reset
                disabled={atDefaults}
                onClick={() => change("Reset View Options", defaults)}
                data-tip="Return these options to their defaults"
                className="tip-bottom tip-end ml-auto px-2.5 py-1.5 rounded-lg text-[12.5px] text-dim enabled:hover:text-ink enabled:hover:bg-veil transition-colors disabled:opacity-40"
              >
                Reset to defaults
              </button>
            </div>
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

/**
 * A setting's slider in the menu, over Settings › Layout's range. THE CARDS FOLLOW IT AS IT MOVES
 * (his ask: "can we also live-update the size/gap while tweaking"): each value goes to the store
 * alone, at most once a frame, and only the release saves it (one save, one undo entry); a drag
 * abandoned with Escape puts back the value it began from (useSliderDraft).
 */
function MenuSlider({
  label,
  range,
  value,
  live,
  onCommit,
}: {
  label: string;
  range: { min: number; max: number };
  value: number;
  /** The store's patch for a value, shown before it is saved. */
  live(v: number): Partial<AppSettings>;
  onCommit(next: number, start: number): void;
}): React.JSX.Element {
  const frame = useRef(0);
  const preview = (v: number): void => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const st = useStore.getState();
      st.setSettings({ ...st.settings, ...live(v) });
    });
  };
  const draft = useSliderDraft(value, {
    onCommit: (v, start) => {
      cancelAnimationFrame(frame.current);
      onCommit(v, start);
    },
    onLive: preview,
  });
  const toValue = (ratio: number): number =>
    Math.round(range.min + ratio * (range.max - range.min));
  return (
    <div className="px-2.5 py-1.5 text-[13px] text-dim">
      <div className="flex items-center gap-2">
        <span className="flex-1">{label}</span>
        <span className="font-mono text-[11px] tabular-nums">{draft.shown}px</span>
      </div>
      <div className="pt-1.5">
        <Slider
          value={(draft.shown - range.min) / (range.max - range.min)}
          ariaLabel={label}
          thumb="always"
          onScrub={(r) => draft.scrub(toValue(r))}
          onCancel={draft.cancel}
          onCommit={(r) => draft.commit(toValue(r))}
        />
      </div>
    </div>
  );
}
