import { useEffect, useRef, useState } from "react";
import { Disc3 } from "lucide-react";
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
import { useSceneSettings } from "./useSceneSettings";

/**
 * The scene picker: a strip of live tiles, each running its scene small on
 * the playing track, so a scene is chosen by looking rather than by name.
 * Under the tiles, the chosen scene's READING KEY (what you see, what it
 * means) and its settings, auto-rendered from the definition. Lives in
 * display mode's own chrome (its options are in-mode, never Settings rows);
 * the Shuffle tile shows the scene the shuffle drew.
 */
export function ScenePicker({
  feed,
  current,
  shuffled,
  art,
  onPick,
}: {
  feed: SceneFeed;
  current: DisplayScene;
  shuffled: Shuffleable;
  art: string | null;
  onPick(id: DisplayScene): void;
}): React.JSX.Element {
  const shownDef = sceneDef(current === "shuffle" ? shuffled : current);
  return (
    <div
      data-display-scenes
      onClick={(e) => e.stopPropagation()}
      // the panel is as wide as seven tiles and no wider, whatever the chosen scene's reading and
      // settings need: sized to its content, it widened for a wordy scene and the tile grid's
      // fractional columns spread with it (the user: "the width of all the screen thumbnails
      // changes"). The reading wraps inside; the settings row wraps inside
      className="absolute top-16 right-4 z-30 w-[1080px] max-w-[96vw] rounded-2xl bg-panel/90 p-2.5 shadow-2xl ring-1 ring-edge backdrop-blur-md"
    >
      {/* the tiles alphabetical, Shuffle last, seven to a row (the user's word) */}
      <div className="grid grid-cols-[repeat(7,auto)] justify-center justify-items-center gap-1.5">
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
                  "relative h-[76px] w-[134px] overflow-hidden rounded-lg bg-bg ring-1",
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
      {/* the display-wide controls sit right under the tiles (the user's word); the chosen
          scene's reading and its own settings follow */}
      <SyncRow />
      <SceneReading def={shownDef} shuffle={current === "shuffle"} />
    </div>
  );
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

function SyncRow(): React.JSX.Element {
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
    <div
      data-display-sync
      className="mt-2 flex items-center justify-end gap-2 border-t border-edge px-1.5 pt-2 text-[11.5px] text-dim"
    >
      <span title="A cathode finish over every scene: scanlines, a slight curve to the glass, phosphor glow and a vignette">
        Finish
      </span>
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
      <span
        className={cx(!cathode && "opacity-40")}
        title="How much the glass bows the picture: deep is about twice a real tube, gentle about life"
      >
        Curve
      </span>
      <Segmented
        value={curve}
        options={[
          { value: "gentle", label: "Gentle", disabled: !cathode },
          { value: "deep", label: "Deep", disabled: !cathode },
        ]}
        onChange={(v) => void saveSettings({ displayCathodeCurve: v })}
      />
      <label
        className={cx("flex items-center gap-1.5", !cathode && "opacity-40")}
        title="Overscan: the picture meets the frame at the edges and only the corners fall behind the glass, as a real tube's raster did"
      >
        <Switch
          size="sm"
          checked={fill}
          disabled={!cathode}
          onChange={(v) => void saveSettings({ displayCathodeFill: v })}
        />
        Fill
      </label>
      <span className="mx-1 text-faint">·</span>
      <span title="A drop is a sudden return after a lull: normal needs three seconds of chill or one of near silence; loose and strict need less and more">
        Drops
      </span>
      <Segmented
        value={drops}
        options={[
          { value: "loose", label: "Loose" },
          { value: "normal", label: "Normal" },
          { value: "strict", label: "Strict" },
        ]}
        onChange={(v) => void saveSettings({ displayDrops: v })}
      />
      <span className="mx-1 text-faint">·</span>
      <label
        className="flex items-center gap-1"
        title="The streamer reports its position about once a second and the pipeline has its own latency, so the scenes can sit a constant offset from what you hear. Slide toward early if the flashes and words arrive after the sound, toward late if they arrive before it"
      >
        Sync
        <RangeSlider
          value={sync}
          min={-1000}
          max={1000}
          step={10}
          ariaLabel="Sync"
          className="w-36"
          onChange={(v, final) => nudge(v, final)}
        />
      </label>
      <span className="w-24 text-right font-mono tabular-nums text-faint">
        {sync === 0 ? "in step" : sync > 0 ? `${sync} ms early` : `${-sync} ms late`}
      </span>
      <span className="mx-1 text-faint">·</span>
      <HeaderChip
        type="button"
        onClick={() => nudge(0, true)}
        disabled={sync === 0}
        className="px-2 py-0.5 text-[11.5px] motion-safe:active:scale-90 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-panel/70 disabled:hover:text-dim disabled:hover:ring-edge"
      >
        Reset
      </HeaderChip>
    </div>
  );
}

/** The chosen scene's key and settings, one row under the tiles. */
function SceneReading({
  def,
  shuffle,
}: {
  def: SceneDef;
  shuffle: boolean;
}): React.JSX.Element | null {
  const key = def.key;
  const hasSettings = (def.settings?.length ?? 0) > 0;
  // always rendered, at a reserved height that fits the tallest scene's reading and settings,
  // so the panel's bottom edge never moves as scenes are chosen (the user's word); a scene
  // with nothing to say (Sleeve) leaves the space quiet
  return (
    <div
      data-display-scene-reading={def.id}
      className="mt-2 flex min-h-[18rem] flex-col gap-y-3 border-t border-edge px-1.5 pt-2"
    >
      {key && (
        <div className="min-w-0 max-w-[62ch] text-[11.5px] leading-snug">
          <div className="microlabel mb-0.5">
            {shuffle
              ? `Now showing the ${def.label.toLowerCase()}`
              : `Reading the ${def.label.toLowerCase()}`}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            {key.reads.map((r) => (
              <span key={r.shows} className="whitespace-nowrap">
                <span className="text-ink">{r.shows}</span>
                <span className="text-faint">{" · "}</span>
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
      )}
      {/* the scene's own controls sit at the bottom right for every scene, wrapping when they
          need to (the user: "either lock them to the bottom, or lock them to the right") */}
      {/* under Shuffle the controls are Shuffle's own; the shown scene is a reading only, its
          controls reachable by picking it (the user: seeing the shown scene's controls under
          Shuffle felt like editing the wrong thing) */}
      {shuffle ? (
        <div className="mt-auto flex justify-end">
          <ShuffleRow />
        </div>
      ) : (
        hasSettings && (
          <div className="mt-auto flex justify-end">
            <SceneSettingsRow def={def} />
          </div>
        )
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
        title="Sequential walks the scenes in the picker's order; random picks any other scene"
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
        title="How many tracks a scene stays for; Album changes the scene when the album changes"
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
        title="The scenes in the rotation; click one to leave it out or bring it back"
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

function SceneSettingsRow({ def }: { def: SceneDef }): React.JSX.Element {
  const { values, set, reset, dirty } = useSceneSettings(def);
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
      {def.settings?.map((s) => {
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
