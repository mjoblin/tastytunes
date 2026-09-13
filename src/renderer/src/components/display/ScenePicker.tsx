import { useEffect, useRef, useState } from "react";
import { BookOpen, Disc3, Layers, SlidersHorizontal } from "lucide-react";
import type { DisplayScene } from "@shared/model";
import { cx } from "@/lib/format";
import { useStore } from "@/store";
import { Segmented } from "@/components/controls/Segmented";
import { Slider } from "@/components/controls/Slider";
import { Switch } from "@/components/controls/Switch";
import { HeaderChip } from "@/components/chrome/Chrome";
import type { SceneFeed } from "./feed";
import { SceneCanvas } from "./SceneCanvas";
import {
  SCENES_ORDERED,
  SHUFFLE_POOL,
  isAbstract,
  sceneDef,
  type SceneDef,
  type Shuffleable,
} from "./scenes";
import type { SceneSettingDef } from "./scenes/types";
import { useSceneSettings } from "./useSceneSettings";

type Section = "reading" | "scene" | "display";
/** Where the picker is: display mode's stage, or the Now Playing tile, which draws no words,
 *  sounds or bloom and so shows none of the settings that govern them. */
export type PickerHost = "display" | "tile";
/** A scene's settings this host shows. */
const settingsFor = (def: SceneDef, host: PickerHost): SceneSettingDef[] =>
  (def.settings ?? []).filter((s) => host === "display" || !s.full);
/** The section left open last, kept for the session, so the panel reopens where it was left. */
let lastSection: Section | null = null;

/**
 * The scene picker: a strip of live tiles, each running its scene small on
 * the playing track, so a scene is chosen by looking rather than by name.
 * Under the tiles one line, the chosen scene's name and blurb with three
 * chips, and under that ONE SECTION AT A TIME or none (the user, 2026-09-12:
 * the reading, the scene's settings and the display-wide settings all at
 * once was "a lot to show"): Reading is the scene's key (what you see, what
 * it means), Scene its own settings (Shuffle's, under Shuffle), Display the
 * finish, drops and sync every scene shares. Closed by default, since picking
 * and leaving is the common case, so the panel is tiles and a line. Lives in
 * display mode's own chrome (its options are in-mode, never Settings rows);
 * the Shuffle tile shows the scene the shuffle drew.
 */
export function ScenePicker({
  feed,
  current,
  shuffled,
  art,
  host = "display",
  onPick,
}: {
  feed: SceneFeed;
  current: DisplayScene;
  shuffled: Shuffleable;
  art: string | null;
  host?: PickerHost;
  onPick(id: DisplayScene): void;
}): React.JSX.Element {
  const shuffle = current === "shuffle";
  const chosenDef = sceneDef(current);
  const shownDef = sceneDef(shuffle ? shuffled : current);
  const [section, setSection] = useState<Section | null>(lastSection);
  const toggle = (id: Section): void => {
    const next = section === id ? null : id;
    setSection(next);
    lastSection = next;
  };
  return (
    <div
      data-display-scenes
      onClick={(e) => e.stopPropagation()}
      // the panel is as wide as five tiles and no wider (three rows of them, the user's word
      // 2026-09-12; seven to a row before), whatever the chosen scene's reading and settings
      // need: sized to its content, it widened for a wordy scene and the tile grid's
      // fractional columns spread with it (the user: "the width of all the screen thumbnails
      // changes"). The reading wraps inside; the settings row wraps inside. It is FLUID
      // against its host (2026-09-12, the Now Playing tile's picker in a small window): capped
      // to the host's box, not the viewport, so it never runs under the nav; the tiles wrap to
      // as many columns as fit, never resizing; and it scrolls inside itself when a section
      // runs past the host's bottom. The scrollbar's gutter is always reserved, so the width
      // the tiles lay out in does not depend on whether the panel happens to scroll (with
      // classic scrollbars that dependence left the grid a row taller after a resize, the
      // user's report); the panel is a little wider than the tiles to pay for it. Its face
      // is the app's glass over content, the playback bar's density (80 over a blur): the
      // stage or the art shows through it frosted, and the live tiles stay legible on it
      className="@container absolute top-16 right-4 z-30 w-[800px] max-w-[calc(100%_-_2rem)] max-h-[calc(100%_-_5rem)] overflow-y-auto [scrollbar-gutter:stable] rounded-2xl bg-panel/80 p-2.5 shadow-2xl ring-1 ring-edge backdrop-blur-md"
    >
      {/* the tiles alphabetical, Shuffle last, five to a row at the panel's full width, fewer
          as its host narrows: 146px is a tile plus its padding. In a panel narrower than its
          full width (only ever the Now Playing tile's, in a small window) the tiles are
          three-quarter size, so the smallest window shows a grid rather than a column */}
      <div className="grid grid-cols-[repeat(auto-fit,146px)] @max-[740px]:grid-cols-[repeat(auto-fit,122px)] justify-center justify-items-center gap-1.5">
        {SCENES_ORDERED.map((s) => {
          const active = current === s.id;
          const Icon = s.icon;
          // the shuffle tile shows whatever the shuffle is showing (the sleeve's tile is the art)
          const tileScene: DisplayScene = s.id === "shuffle" ? shuffled : s.id;
          return (
            <button
              key={s.id}
              type="button"
              data-display-scene={s.id}
              data-active={active ? "true" : undefined}
              onClick={() => onPick(s.id)}
              title={s.blurb}
              className={cx(
                "group flex flex-col items-center gap-1.5 rounded-xl p-1.5 transition-colors hover:bg-veil",
                active && "bg-veil2",
              )}
            >
              <div
                className={cx(
                  "relative h-[76px] w-[134px] @max-[740px]:h-[62px] @max-[740px]:w-[110px] overflow-hidden rounded-lg bg-bg ring-1",
                  active ? "ring-gold" : "ring-edge",
                )}
              >
                {isAbstract(tileScene) ? (
                  <SceneCanvas scene={tileScene} feed={feed} mini />
                ) : art ? (
                  <img src={art} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-faint">
                    <Disc3 size={28} strokeWidth={1.2} />
                  </div>
                )}
                {s.id === "shuffle" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-bg/40">
                    <Icon size={22} className="text-ink drop-shadow" />
                  </div>
                )}
              </div>
              <span
                className={cx(
                  "flex items-center gap-1 text-[11.5px]",
                  active ? "text-gold" : "text-dim group-hover:text-ink",
                )}
              >
                <Icon size={11} />
                {s.label}
              </span>
            </button>
          );
        })}
      </div>
      {/* the line: which scene, in a phrase, and the three sections' chips */}
      <div
        data-display-footer
        className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-edge px-1.5 pt-2 text-[11.5px]"
      >
        <div className="min-w-0 flex-1 truncate">
          <span className="text-ink">{chosenDef.label}</span>
          <span className="text-faint">{" · "}</span>
          <span className="text-dim">{chosenDef.blurb}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {/* named by what they cover, not where they live (the user, 2026-09-12: "Scene" beside
              a row of scenes and "Display" in the tile, where Display is the other view, both
              read wrong); the icons scan, the words settle it */}
          {(
            [
              ["reading", "Reading", BookOpen],
              ["scene", "This scene", SlidersHorizontal],
              ["display", "All scenes", Layers],
            ] as const
          ).map(([id, label, Icon]) => (
            <HeaderChip
              key={id}
              type="button"
              data-display-section-chip={id}
              active={section === id}
              aria-expanded={section === id}
              onClick={() => toggle(id)}
              className="flex items-center gap-1.5 px-2 py-0.5 text-[11.5px] motion-safe:active:scale-90"
            >
              <Icon size={12} />
              {label}
            </HeaderChip>
          ))}
        </div>
      </div>
      {/* A SECTION IS AS TALL AS ITS TALLEST SCENE: every scene's reading (or controls) sits
          in the same grid cell, the chosen one visible and the rest laid out unseen, so the
          cell is the height of the tallest at whatever width the panel has and the panel's
          bottom edge never moves as scenes are chosen (the user's word; a guessed reserve
          held for most scenes and grew for the tunnel). Unseen rows are visibility-hidden,
          so nothing in them takes a click or a Tab */}
      {section && (
        <div data-display-section={section} className="mt-2 border-t border-edge px-1.5 pt-2">
          {section === "reading" && (
            <div className="grid">
              {SCENES_ORDERED.filter((s) => s.id !== "shuffle").map((s) => (
                <Stacked key={s.id} on={s.id === shownDef.id}>
                  <SceneReading def={s} shuffle={shuffle && s.id === shownDef.id} />
                </Stacked>
              ))}
            </div>
          )}
          {section === "scene" && (
            <div className="grid">
              {SCENES_ORDERED.map((s) => (
                <Stacked key={s.id} on={s.id === current}>
                  {s.id === "shuffle" ? (
                    <ShuffleRow />
                  ) : settingsFor(s, host).length > 0 ? (
                    <SceneSettingsRow def={s} host={host} />
                  ) : (s.settings?.length ?? 0) > 0 ? (
                    <SectionQuiet>
                      This scene&apos;s settings are for the fullscreen view.
                    </SectionQuiet>
                  ) : (
                    <SectionQuiet>This scene has no settings.</SectionQuiet>
                  )}
                </Stacked>
              ))}
            </div>
          )}
          {section === "display" && <SyncRow host={host} />}
        </div>
      )}
    </div>
  );
}

/** One scene's slice of a section, in the cell every scene's slice shares: seen when it is the
 *  chosen scene's, laid out unseen otherwise. */
function Stacked({ on, children }: { on: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      aria-hidden={!on}
      className={cx("[grid-area:1/1]", !on && "invisible pointer-events-none")}
    >
      {children}
    </div>
  );
}

/** A section with nothing in it for this scene says so, at a row's height, rather than closing
 *  (a section that came and went would move the panel's bottom edge as scenes are chosen). */
function SectionQuiet({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex min-h-8 items-center text-[11.5px] text-faint">{children}</div>;
}

/** Display mode's sync nudge. The streamer reports its position about once a second and the
 *  chain has its own latency, so every scene's hits and words can sit a constant offset from
 *  what is heard; this slides them all, in-mode, remembered. */
/**
 * The app's Slider over a numeric range (the faceplate track with the amber fill, the same
 * one the volume and the playhead use; the native range input looked like a stranger here).
 * Every move is reported, the release marked final, so a caller can answer locally and save
 * on a debounce rather than let a save's round trip drag the thumb.
 */
function RangeSlider({
  value,
  min,
  max,
  step,
  ariaLabel,
  className,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  className?: string;
  onChange(value: number, final: boolean): void;
}): React.JSX.Element {
  const toValue = (r: number): number => {
    const q = Math.round((min + r * (max - min)) / step) * step;
    return Math.min(max, Math.max(min, Number(q.toFixed(6))));
  };
  return (
    <div className={cx("shrink-0", className)}>
      <Slider
        value={(value - min) / (max - min)}
        ariaLabel={ariaLabel}
        thumb="always"
        onScrub={(r) => onChange(toValue(r), false)}
        onCommit={(r) => onChange(toValue(r), true)}
      />
    </div>
  );
}

function SyncRow({ host }: { host: PickerHost }): React.JSX.Element {
  const value = useStore((s) => s.settings.displaySyncMs ?? 0);
  const drops = useStore((s) => s.settings.displayDrops ?? "normal");
  const finish = useStore((s) => s.settings.displayFinish ?? "cathode");
  const curve = useStore((s) => s.settings.displayCathodeCurve ?? "deep");
  const fill = useStore((s) => s.settings.displayCathodeFill ?? false);
  const saveSettings = useStore((s) => s.saveSettings);
  const cathode = finish === "cathode";
  // the slider is answered locally: a save is an IPC round trip to disk, and a controlled value
  // that waits for it drags behind the thumb (the user: "very sluggish")
  const [sync, setSync] = useState(value);
  useEffect(() => setSync(value), [value]);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudge = (v: number, final = false): void => {
    setSync(v);
    if (syncTimer.current) clearTimeout(syncTimer.current);
    if (final) void saveSettings({ displaySyncMs: v });
    else syncTimer.current = setTimeout(() => void saveSettings({ displaySyncMs: v }), 150);
  };
  return (
    <div data-display-sync className="flex flex-col gap-y-2 text-[11.5px] text-dim">
      {/* the glass is the fullscreen view's alone: the tile draws no cathode finish, so its
          picker shows the drops and the sync, which shape what the tile draws through the feed */}
      {host === "display" && (
        <SettingLine
          label="Finish"
          hint="A cathode tube's glass over every scene. Curve is how much it bows the picture and Fill lets the picture reach the frame."
        >
          <Segmented
            value={finish}
            options={[
              { value: "plain", label: "Plain" },
              { value: "cathode", label: "Cathode" },
            ]}
            onChange={(v) => void saveSettings({ displayFinish: v })}
          />
          {/* the glass's controls are always in the row, dimmed when Plain: a control that appears
              rearranges everything beside it (the user: "everything pops around") */}
          <span className={cx(!cathode && "opacity-40")}>Curve</span>
          <Segmented
            value={curve}
            options={[
              { value: "gentle", label: "Gentle", disabled: !cathode },
              { value: "deep", label: "Deep", disabled: !cathode },
            ]}
            onChange={(v) => void saveSettings({ displayCathodeCurve: v })}
          />
          <label className={cx("flex items-center gap-1.5", !cathode && "opacity-40")}>
            <Switch
              size="sm"
              checked={fill}
              disabled={!cathode}
              onChange={(v) => void saveSettings({ displayCathodeFill: v })}
            />
            Fill
          </label>
        </SettingLine>
      )}
      <SettingLine
        label="Drops"
        hint="How much of a lull a drop needs. Loose counts small ones, strict requires a real breakdown."
      >
        <Segmented
          value={drops}
          options={[
            { value: "loose", label: "Loose" },
            { value: "normal", label: "Normal" },
            { value: "strict", label: "Strict" },
          ]}
          onChange={(v) => void saveSettings({ displayDrops: v })}
        />
      </SettingLine>
      <SettingLine
        label="Sync"
        hint="Slide toward early if the flashes and lyrics land after the sound, toward late if before."
      >
        <RangeSlider
          value={sync}
          min={-1000}
          max={1000}
          step={10}
          ariaLabel="Sync"
          className="w-36"
          onChange={(v, final) => nudge(v, final)}
        />
        <span className="w-24 text-right font-mono tabular-nums text-faint">
          {sync === 0 ? "in step" : sync > 0 ? `${sync} ms early` : `${-sync} ms late`}
        </span>
        <HeaderChip
          type="button"
          onClick={() => nudge(0, true)}
          disabled={sync === 0}
          className="px-2 py-0.5 text-[11.5px] motion-safe:active:scale-90 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-panel/70 disabled:hover:text-dim disabled:hover:ring-edge"
        >
          Reset
        </HeaderChip>
      </SettingLine>
    </div>
  );
}

/** One of the All scenes rows, in the Settings idiom: the plain noun, the control, and a faint
 *  sentence saying what it does, in view rather than in a tooltip (the user, 2026-09-12: the
 *  words alone "don't read as clear enough"). The sentence takes the rest of the row and
 *  wraps under the control in a narrow panel. */
function SettingLine({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="w-11 shrink-0">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
      <span className="min-w-0 flex-1 basis-40 leading-snug text-faint">{hint}</span>
    </div>
  );
}

/** The chosen scene's key: what you see, what it means, and what it does not claim. */
function SceneReading({ def, shuffle }: { def: SceneDef; shuffle: boolean }): React.JSX.Element {
  const key = def.key;
  return (
    <div data-display-scene-reading={def.id}>
      {key ? (
        <div className="min-w-0 text-[11.5px] leading-snug">
          <div className="microlabel mb-0.5">
            {shuffle
              ? `Now showing the ${def.label.toLowerCase()}`
              : `Reading the ${def.label.toLowerCase()}`}
          </div>
          {/* entries share a row when they fit and an entry wraps within its own words when
              it does not, the measure being the panel's width: at full width every entry is
              one line, in a narrow panel the long ones fold rather than run off the edge.
              What never breaks is the name from its dot */}
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            {key.reads.map((r) => (
              <span key={r.shows}>
                <span className="whitespace-nowrap">
                  <span className="text-ink">{r.shows}</span>
                  <span className="text-faint">{" · "}</span>
                </span>
                <span className="text-dim">{r.means}</span>
              </span>
            ))}
          </div>
          {key.honesty?.map((h) => (
            <div key={h} className="mt-0.5 text-faint italic">
              {h}
            </div>
          ))}
        </div>
      ) : (
        <SectionQuiet>This scene has nothing to read.</SectionQuiet>
      )}
    </div>
  );
}

/** Shuffle's controls: the order, how many tracks a scene stays for, and which scenes are in. */
function ShuffleRow(): React.JSX.Element {
  const order = useStore((s) => s.settings.displayShuffleOrder ?? "random");
  const every = useStore((s) => s.settings.displayShuffleEvery ?? 1);
  const exclude = useStore((s) => s.settings.displayShuffleExclude ?? ["sleeve"]);
  const saveSettings = useStore((s) => s.saveSettings);
  const dirty = order !== "random" || every !== 1 || exclude.join() !== "sleeve";
  const toggle = (id: Shuffleable): void => {
    const next = exclude.includes(id) ? exclude.filter((x) => x !== id) : [...exclude, id];
    // one scene at least stays in the rotation
    if (SHUFFLE_POOL.every((x) => next.includes(x))) return;
    void saveSettings({ displayShuffleExclude: next });
  };
  return (
    <div
      data-display-shuffle-settings
      className="flex min-h-8 flex-wrap items-center justify-end gap-x-5 gap-y-1.5 text-[11.5px] text-dim"
    >
      <label
        className="flex items-center gap-1.5"
        title="Sequential steps through the scenes in the picker's order. Random picks any other scene."
      >
        Order
        <Segmented
          value={order}
          options={[
            { value: "sequential", label: "Sequential" },
            { value: "random", label: "Random" },
          ]}
          onChange={(v) => void saveSettings({ displayShuffleOrder: v })}
        />
      </label>
      <label
        className="flex items-center gap-1.5"
        title="How many tracks a scene stays for. Album changes the scene when the album changes."
      >
        Change every
        <Segmented
          value={every}
          options={[
            { value: 1, label: "Track" },
            { value: 2, label: "2" },
            { value: 3, label: "3" },
            { value: "album", label: "Album" },
          ]}
          onChange={(v) => void saveSettings({ displayShuffleEvery: v })}
        />
      </label>
      <div
        className="flex items-center gap-1.5"
        title="The scenes in the rotation. Click one to leave it out or bring it back."
      >
        Include
        <div className="no-drag flex h-8 items-center gap-0.5 rounded-lg bg-panel/70 p-0.5 ring-1 ring-edge">
          {SCENES_ORDERED.filter((sc) => sc.id !== "shuffle").map((sc) => {
            const In = sc.icon;
            const included = !exclude.includes(sc.id);
            return (
              <button
                key={sc.id}
                type="button"
                data-tip={sc.label}
                aria-label={sc.label}
                aria-pressed={included}
                onClick={() => toggle(sc.id as Shuffleable)}
                className={cx(
                  "tip-top flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                  included ? "text-gold hover:bg-veil" : "text-faint opacity-50 hover:opacity-80",
                )}
              >
                <In size={13} />
              </button>
            );
          })}
        </div>
      </div>
      <HeaderChip
        type="button"
        onClick={() =>
          void saveSettings({
            displayShuffleOrder: "random",
            displayShuffleEvery: 1,
            displayShuffleExclude: ["sleeve"],
          })
        }
        disabled={!dirty}
        className="px-2 py-0.5 text-[11.5px] motion-safe:active:scale-90 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-panel/70 disabled:hover:text-dim disabled:hover:ring-edge"
      >
        Reset
      </HeaderChip>
    </div>
  );
}

function SceneSettingsRow({ def, host }: { def: SceneDef; host: PickerHost }): React.JSX.Element {
  const shown = settingsFor(def, host);
  const { values, set, reset, dirty } = useSceneSettings(
    def,
    shown.map((s) => s.key),
  );
  // a slider's live value while the pointer moves, saved 150 ms after the last move (or on
  // release); the saved values arriving clears it
  const [live, setLive] = useState<Record<string, number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => setLive({}), [values]);
  return (
    <div
      data-display-scene-settings
      className="flex min-h-8 flex-wrap items-center justify-end gap-x-5 gap-y-1.5 text-[11.5px] text-dim"
    >
      {shown.map((s) => {
        if (s.kind === "toggle")
          return (
            <label key={s.key} className="flex items-center gap-1.5">
              <Switch size="sm" checked={values[s.key] === true} onChange={(v) => set(s.key, v)} />
              {s.label}
            </label>
          );
        if (s.kind === "slider")
          return (
            <label key={s.key} className="flex items-center gap-1.5">
              {s.label}
              <RangeSlider
                value={live[s.key] ?? Number(values[s.key])}
                min={s.min}
                max={s.max}
                step={s.step ?? 0.1}
                ariaLabel={s.label}
                className="w-24"
                onChange={(v, final) => {
                  setLive((l) => ({ ...l, [s.key]: v }));
                  const t = timers.current[s.key];
                  if (t) clearTimeout(t);
                  if (final) set(s.key, v);
                  else timers.current[s.key] = setTimeout(() => set(s.key, v), 150);
                }}
              />
              <span className="font-mono tabular-nums text-faint">
                {(live[s.key] ?? Number(values[s.key])).toFixed(s.step && s.step < 1 ? 1 : 0)}
                {s.unit ?? ""}
              </span>
            </label>
          );
        return (
          <span key={s.key} className="flex items-center gap-1.5">
            {s.label}
            <Segmented
              value={String(values[s.key])}
              options={s.options.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(v) => set(s.key, v)}
            />
          </span>
        );
      })}
      <HeaderChip
        type="button"
        onClick={reset}
        disabled={!dirty}
        className="px-2 py-0.5 text-[11.5px] motion-safe:active:scale-90 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-panel/70 disabled:hover:text-dim disabled:hover:ring-edge"
      >
        Reset
      </HeaderChip>
    </div>
  );
}
