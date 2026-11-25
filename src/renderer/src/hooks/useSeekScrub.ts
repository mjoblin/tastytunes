import { useEffect, useState } from "react";

/**
 * Scrub-and-hold state for a seek slider, shared by the playback bar and the
 * tray panel.
 *
 * Two problems, one hook. While DRAGGING, the thumb must track the pointer
 * rather than the streamer's ~1s-late pushes (`scrub`). And after RELEASE, the
 * thumb must hold the seek target until the device's playhead catches up
 * (`seekHold`) — otherwise it snaps back to the stale position, then jumps
 * forward when the seek lands. The bar solved the snap-back long ago; the
 * panel shipped without it and had the visible snap until this was extracted.
 *
 * The hold clears when the playhead arrives within 2s of the target, or after
 * 3s regardless — a seek the device ignored must not pin the display forever —
 * or at once when the track changes (a seek into a track's last second goes to
 * the next one: main/device/commandFrames).
 */
export function useSeekScrub(
  position: number,
  duration: number | null,
  seek: (positionSecs: number) => void,
): {
  /** What the readout and slider should show right now. */
  shownPosition: number;
  /** Wire these straight onto the Slider. */
  slider: {
    onScrub(v: number): void;
    onCancel(): void;
    onCommit(v: number): void;
  };
} {
  const [scrub, setScrub] = useState<number | null>(null);
  /** The seek's target, and the length of the track it was made in. */
  const [seekHold, setSeekHold] = useState<{ at: number; of: number | null } | null>(null);

  useEffect(() => {
    if (seekHold == null) return;
    if (Math.abs(position - seekHold.at) < 2 || duration !== seekHold.of) {
      setSeekHold(null);
      return;
    }
    const t = setTimeout(() => setSeekHold(null), 3000);
    return () => clearTimeout(t);
  }, [seekHold, position, duration]);
  const held = seekHold != null && duration === seekHold.of ? seekHold.at : null;

  return {
    shownPosition: scrub != null && duration ? scrub * duration : (held ?? position),
    slider: {
      onScrub: setScrub,
      onCancel: () => setScrub(null),
      onCommit: (v: number) => {
        setScrub(null);
        if (duration) {
          setSeekHold({ at: v * duration, of: duration });
          seek(v * duration);
        }
      },
    },
  };
}
