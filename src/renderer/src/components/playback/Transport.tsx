import { Loader2, Pause, Play } from "lucide-react";
import { tt } from "@/api";
import { useStore } from "@/store";
import { controlSet, cx } from "@/lib/format";

/**
 * The shared transport layer: ONE derivation of "what can the transport do
 * right now", and the two buttons every playback surface assembles from it.
 *
 * Three surfaces carry a transport — the playback bar, the mini player and the
 * tray panel — and before this file each derived playing/busy/can* by hand.
 * The copies drifted exactly the way copies do: the `active` gate on
 * playing/busy was born into the tray panel, retrofitted onto the mini
 * (f127970), and the bar — the ORIGINAL — still lacked it the day this file
 * was extracted: disconnect mid-song and the bar's disabled button kept
 * showing PAUSE, claiming the streamer was playing while the rest of the app
 * said nothing was. A surface can't miss the gate when the gate lives in the
 * one derivation they all call.
 *
 * What stays at the call site: layout, sizes, which buttons a surface offers
 * (the mini has no shuffle; only the bar offers stop-for-radio), and POWER —
 * the bar's glowing lamp and the panel's quiet icon are deliberately different
 * statements of the same verb.
 */
export interface Transport {
  connected: boolean;
  powered: boolean;
  /** Connected AND powered — the gate every control checks first. */
  active: boolean;
  playing: boolean;
  busy: boolean;
  canToggle: boolean;
  canPrev: boolean;
  canNext: boolean;
  canSeek: boolean;
  canShuffle: boolean;
  canRepeat: boolean;
  canStop: boolean;
  shuffleOn: boolean;
  repeatOn: boolean;
  toggle(): void;
  prev(): void;
  next(): void;
  stop(): void;
  toggleShuffle(): void;
  toggleRepeat(): void;
  seek(positionSecs: number): void;
}

export function useTransport(
  /**
   * From the SURFACE's own usePlayhead, for canSeek. Passed in rather than
   * subscribed here because the playhead ticks — each window owns exactly one
   * subscription, and a surface that doesn't seek just omits it.
   */
  duration?: number | null,
): Transport {
  const connection = useStore((s) => s.connection);
  const systemPower = useStore((s) => s.systemPower);
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);

  const connected = connection.phase === "connected";
  const powered = systemPower?.power === "ON";
  const active = connected && powered;
  const controls = controlSet(nowPlaying);
  const state = playState?.state;
  // Gated on `active`: play_state SURVIVES a disconnect and a drop into
  // standby, so an ungated check shows a PAUSE button while the surface
  // around it says nothing is playing.
  const playing = active && state === "play";
  const busy = active && (state === "buffering" || state === "connecting");
  const shuffleOn = playState?.mode_shuffle === "all";
  const repeatOn = playState?.mode_repeat === "all";

  return {
    connected,
    powered,
    active,
    playing,
    busy,
    canToggle: controls.has("play_pause") || controls.has("play") || controls.has("pause"),
    canPrev: controls.has("track_previous"),
    canNext: controls.has("track_next"),
    canSeek: controls.has("seek") && duration != null && duration > 0,
    canShuffle: controls.has("toggle_shuffle"),
    canRepeat: controls.has("toggle_repeat"),
    canStop: controls.has("stop"),
    shuffleOn,
    repeatOn,
    toggle: () => void tt.command({ type: "togglePlayback" }),
    prev: () => void tt.command({ type: "previousTrack" }),
    next: () => void tt.command({ type: "nextTrack" }),
    stop: () => void tt.command({ type: "stop" }),
    toggleShuffle: () => void tt.command({ type: "setShuffle", mode: shuffleOn ? "off" : "all" }),
    toggleRepeat: () => void tt.command({ type: "setRepeat", mode: repeatOn ? "off" : "all" }),
    seek: (positionSecs: number) => void tt.command({ type: "seek", positionSecs }),
  };
}

/**
 * The gold circle. `bar` is the 44px glowing hero; `compact` is the 32px
 * version the mini player and tray panel share. Same icon logic everywhere:
 * spinner while buffering, pause while playing, play otherwise — with the
 * one-pixel optical nudge the triangle needs to look centred.
 */
export function PlayPauseButton({
  size,
  tipHint = "",
  className,
}: {
  size: "bar" | "compact";
  /** Keyboard hint appended to the tooltip on surfaces that have shortcuts. */
  tipHint?: string;
  className?: string;
}): React.JSX.Element {
  const t = useTransport();
  const icon = size === "bar" ? 20 : 14;
  const label = (t.playing ? "Pause" : "Play") + tipHint;
  return (
    <button
      data-tip={label}
      aria-label={label}
      disabled={!t.active || (!t.canToggle && !t.busy)}
      onClick={t.toggle}
      className={cx(
        "tip-top rounded-full flex items-center justify-center transition-all shrink-0",
        size === "bar" ? "h-11 w-11" : "h-8 w-8",
        t.active && (t.canToggle || t.busy)
          ? cx(
              "bg-gold text-bg motion-safe:hover:scale-105",
              size === "bar" && "shadow-[0_0_20px_rgb(var(--gold-rgb)_/_0.35)]",
            )
          : "bg-veil2 text-faint",
        className,
      )}
    >
      {t.busy ? (
        <Loader2 size={icon} className="spin" />
      ) : t.playing ? (
        <Pause size={icon} fill="currentColor" strokeWidth={0} />
      ) : (
        <Play size={icon} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />
      )}
    </button>
  );
}

/**
 * The quiet icon button flanking the circle — prev/next, the mode toggles,
 * and the mini's volume nudges, which deliberately wear the same
 * secondary-control skin. `accent` is an engaged mode toggle (shuffle/repeat
 * on): gold, like every engaged toggle in the app.
 */
export function TransportIconButton({
  children,
  tip,
  enabled,
  accent,
  size,
  className,
  onClick,
}: {
  children: React.ReactNode;
  tip: string;
  enabled: boolean;
  accent?: boolean;
  size: "bar" | "compact";
  className?: string;
  onClick(): void;
}): React.JSX.Element {
  return (
    <button
      data-tip={tip}
      aria-label={tip}
      disabled={!enabled}
      onClick={onClick}
      className={cx(
        "tip-top transition-colors shrink-0",
        size === "bar" ? "p-2 rounded-md" : "p-1 rounded",
        !enabled ? "text-faint/40" : accent ? "text-gold" : "text-dim hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}
