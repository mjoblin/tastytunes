// A PRESET'S VOLUME POPOVER, the row's and the card's. Moved out of PresetsScreen.tsx as it was
// (0.15.0, the hygiene pass: the screen had grown from 1,006 lines to 1,341).
import { useState } from "react";
import { useStore } from "@/store";
import { Slider } from "@/components/controls/Slider";
import { PopoverCard } from "@/components/chrome/Overlay";
import { ConfirmActions } from "@/components/chrome/Confirm";

export interface PresetVolumeProps {
  /** Saved override, or null. */
  volume: number | null;
  /** Pre-amp mode only — control-bus devices can't set an absolute level. */
  canSetVolume: boolean;
  onVolume(level: number | null): void;
}

/**
 * Feature 10's popover, shared by rows and cards: the app's anchored popover (PopoverCard), so it
 * opens where it was asked for, under the speaker or where the ⋯ menu stood, and is clamped
 * on screen (it opened right-aligned and upward before 0.12.0, landing over the next card). Saving
 * is EXPLICIT: the slider only stages a draft and the Set button commits, so clicking away
 * always means "never mind".
 */
export function usePresetVolumePopover(
  volume: number | null,
  onVolume: (level: number | null) => void,
): {
  open: boolean;
  /** Opens under an element (the speaker). */
  openFrom(e: { currentTarget: Element; stopPropagation(): void }): void;
  /** Opens at a point (where the ⋯ menu that offered "Preset volume…" stood). */
  openAt(at: { x: number; y: number }): void;
  popover: React.ReactNode;
} {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const zoneVolume = useStore((s) => s.zoneState?.volume_percent);
  const open = at != null;

  const level = draft ?? volume ?? zoneVolume ?? 25;

  const openAt = (point: { x: number; y: number }): void => {
    setDraft(null);
    setAt(point);
  };
  const openFrom = (e: { currentTarget: Element; stopPropagation(): void }): void => {
    e.stopPropagation();
    if (open) {
      setAt(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    openAt({ x: r.left, y: r.bottom + 6 });
  };

  const popover = at && (
    // the card or row underneath recalls on click: the popover's clicks (and its click-away)
    // stop here, never reaching it through React's tree
    <PopoverStop>
      <PopoverCard
        at={at}
        width="w-60"
        onClose={() => setAt(null)}
        className="p-3"
        data-preset-volume-popover
      >
        <span className="flex items-center justify-between mb-2">
          <span className="microlabel text-dim">preset volume</span>
          <span className="font-mono text-[11px] text-accent tabular-nums">{level}%</span>
        </span>
        <Slider
          value={level / 100}
          onScrub={(v) => setDraft(Math.round(v * 100))}
          onCancel={() => setDraft(null)}
          onCommit={(v) => setDraft(Math.round(v * 100))}
          ariaLabel="Preset volume"
          thumb="always"
          // a preset starts at this level, so it carries the volume slider's guard
          raiseBy={0.05}
        />
        <span className="block text-[11px] text-faint leading-relaxed mt-2.5">
          TastyTunes sets this volume whenever it starts this preset. Recalls from the official app
          or the streamer itself aren't affected.
        </span>
        {/* the app's action row (Confirm): Cancel and Set right-aligned; Clear, which removes
            the preset's volume rather than setting one, apart on the left */}
        <ConfirmActions
          tone="accent"
          verb={`Set ${level}%`}
          onCancel={() => setAt(null)}
          onConfirm={() => {
            onVolume(level);
            setAt(null);
          }}
          start={
            volume != null && (
              <button
                onClick={() => {
                  onVolume(null);
                  setAt(null);
                }}
                className="px-2.5 py-1 rounded-lg text-[12px] ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70 transition-colors"
              >
                Clear
              </button>
            )
          }
        />
      </PopoverCard>
    </PopoverStop>
  );

  return { open, openFrom, openAt, popover };
}

/** Holds a popover's clicks: a preset's row recalls on click, and React carries a portal's events
 *  up its component tree, so a click inside a popover (or on its click-away backdrop) would
 *  otherwise recall the preset underneath; pointer-downs would start a card's drag, a right-click
 *  would reopen the menu. */
export function PopoverStop({ children }: { children: React.ReactNode }): React.JSX.Element {
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation();
  return (
    <span className="contents" onClick={stop} onPointerDown={stop} onContextMenu={stop}>
      {children}
    </span>
  );
}
