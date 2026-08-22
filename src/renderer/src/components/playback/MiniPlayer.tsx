import {
  Disc3,
  Maximize2,
  Minus,
  Plus,
  RadioTower,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { isCbusMode, isPreAmpMode } from "@shared/smoip";
import { tt } from "@/api";
import { CloseButton } from "@/components/controls/CloseButton";
import { useStore } from "@/store";
import { usePlayhead } from "@/hooks/usePlayhead";
import { useArtAccent } from "@/hooks/useArtAccent";
import { useMotionPreference } from "@/hooks/useMotionPreference";
import { useTheme } from "@/hooks/useTheme";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useDisplayFont } from "@/hooks/useDisplayFont";
import { useVolumeSlider, useWheelVolume } from "@/components/playback/VolumeCluster";
import {
  PlayPauseButton,
  TransportIconButton,
  useTransport,
} from "@/components/playback/Transport";
import { VolumeArc } from "@/components/playback/VolumeDial";
import { useSeekScrub } from "@/hooks/useSeekScrub";
import { Slider } from "@/components/controls/Slider";
import { ArtImage } from "@/components/media/ArtImage";
import { AmbientArt } from "@/components/media/AmbientArt";
import { useDecodedArt } from "@/hooks/useDecodedArt";
import { cx, deriveNowPlaying, fmtTime } from "@/lib/format";

/**
 * The mini player window (?mini=1): a frameless always-on-top strip with art,
 * playhead, transport, and volume. Fed by the same pushes as the main window;
 * hover state arrives from the main process (CSS :hover can't fire over the
 * drag region).
 *
 * THE SLIDER IS THE PLAYHEAD, as on every other surface. It used to be a
 * hover-revealed VOLUME slider in the time cell, which read as a seek bar and
 * wasn't (user call, 2026-08-04) — volume is now the tray panel's arc at mini
 * scale, plus the wheel anywhere on the window and the arrow keys.
 */
export function MiniPlayer(): React.JSX.Element {
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const zoneState = useStore((s) => s.zoneState);
  const queue = useStore((s) => s.queue);
  const settings = useStore((s) => s.settings);
  const hovered = useStore((s) => s.miniHover);
  const { position, duration } = usePlayhead();
  const onWheel = useWheelVolume();
  // Unconditional — feeds the arc's level (hold-aware, percent-vs-step). Stays
  // above the (currently absent) early returns so the hook count never shifts
  // (React #310 guard).
  const vol = useVolumeSlider();
  // transport keys only — this window has no screens, palette or overlays
  useShortcuts({ transportOnly: true });
  const theme = useTheme(settings.theme);
  useDisplayFont(settings.displayFont);

  // Shared with the bar and the tray panel — playing/busy arrive already
  // gated on `active` (see Transport.tsx for the drift this closed).
  const t = useTransport(duration);
  // Shared scrub-and-hold: thumb tracks the pointer while dragging, holds the
  // target after release until the device's playhead catches up.
  const { shownPosition, slider } = useSeekScrub(position, duration, t.seek);
  const { connected, active } = t;
  const meta = deriveNowPlaying(playState, nowPlaying);
  useArtAccent(settings.accentFollowsArt && active ? meta.artUrl : null, theme);
  // Wash and tile both render the last DECODED cover (see useDecodedArt).
  const { art: miniArt } = useDecodedArt(meta.artUrl);
  useMotionPreference(settings.motion);

  const muted = zoneState?.mute === true;
  const preAmp = isPreAmpMode(zoneState);
  const cbus = isCbusMode(zoneState);
  const hasVolume = zoneState != null && (preAmp || cbus);

  const timeText = active
    ? duration != null
      ? `${fmtTime(shownPosition)} / ${fmtTime(duration)}`
      : fmtTime(shownPosition)
    : "";

  // what's next in the queue
  const items = queue?.items ?? [];
  const currentIdx = items.findIndex((i) => i.id === (queue?.play_id ?? playState?.queue_id));
  const next = currentIdx >= 0 ? (items[currentIdx + 1] ?? null) : null;

  // Shared mute toggle: same as before (gold when muted). Tooltip also teaches
  // the invisible wheel-anywhere volume.
  const muteBtn = (
    <button
      data-tip={muted ? "Unmute — scroll for volume" : "Mute — scroll for volume"}
      aria-label={muted ? "Unmute" : "Mute"}
      onClick={() => void tt.command({ type: "setMute", mute: !muted })}
      className={cx(
        // matches MiniButton (the ± nudges) and the main transport's mute —
        // one consistent secondary-control treatment across the mini.
        // tip-end: the mute sits by the right edge now, and a centred tip
        // clips against the window (the shell is overflow-hidden).
        "no-drag tip-top tip-end p-1 ml-0.5 rounded transition-colors",
        muted ? "text-gold" : "text-dim hover:text-ink",
      )}
    >
      {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
    </button>
  );

  return (
    <div className="h-screen w-screen drag-region" onWheel={onWheel}>
      <div className="relative h-full w-full rounded-2xl bg-panel ring-1 ring-edge2 overflow-hidden flex shadow-[0_12px_40px_rgb(0_0_0_/_0.5)]">
        {/* Ambient album-art wash behind the strip — same treatment as the main
            window, off the same decoded-art value so it crossfades between
            covers instead of blanking mid-download.
            GATING (user intent, 2026-07-24): 'off' means OFF EVERYWHERE — turn
            ambient art off and the mini has none either, which is the whole
            point of the setting. 'now-playing' DOES show it here: that mode
            scopes the wash to the now-playing surface rather than disabling it,
            and the mini is nothing but a now-playing surface. So the one live
            check is !== 'off' — deliberately, not incidentally. (Arrives live
            in this window via the settings broadcast.) */}
        <AmbientArt
          src={active && settings.ambientArt !== "off" ? (miniArt ?? null) : null}
          vignette={settings.vignette}
        />
        {/* art */}
        <div className="relative h-full aspect-square shrink-0 bg-raised flex items-center justify-center">
          <ArtImage
            src={active ? miniArt : null}
            fallback={
              meta.isRadio && active ? (
                <RadioTower size={30} className="text-faint" />
              ) : (
                <Disc3 size={30} className="text-faint" />
              )
            }
          />
        </div>

        {/* current track pinned top, next track pinned bottom */}
        <div className="relative flex-1 min-w-0 flex flex-col justify-between px-4 py-3.5">
          {/* title row + window controls (revealed while the cursor is over the window) */}
          <div className="relative flex items-start">
            <div className="flex-1 min-w-0">
              {/* min-heights + nbsp keep both lines occupying space during the
                  brief metadata gap on track changes, so the layout never shifts */}
              <div
                className={cx(
                  "font-display no-optical font-bold tracking-tight text-[14px] text-ink truncate leading-tight min-h-[16px]",
                  hovered && "pr-12",
                )}
              >
                {active ? (meta.title ?? " ") : "Nothing playing"}
              </div>
              <div className="font-display no-optical tracking-tight text-[12px] text-dim truncate leading-tight mt-0.5 min-h-[14px]">
                {(active && meta.subtitle) || (connected ? " " : "not connected")}
              </div>
            </div>
            <div
              className={cx(
                "absolute -top-0.5 right-0 flex items-center gap-0.5 transition-opacity",
                hovered ? "opacity-100" : "opacity-0 pointer-events-none",
              )}
            >
              <button
                data-tip="Open TastyTunes"
                aria-label="Open TastyTunes"
                onClick={() => {
                  void tt.showMain();
                  void tt.toggleMini();
                }}
                className="no-drag tip-bottom tip-end p-1 rounded text-faint hover:text-ink transition-colors"
              >
                <Maximize2 size={12} />
              </button>
              <CloseButton
                onClick={() => void tt.toggleMini()}
                size={13}
                label="Close mini player"
                tip="Close mini player"
                className="no-drag tip-bottom tip-end"
              />
            </div>
          </div>

          {/* playhead: the same seek row the bar and panel carry, sized down.
              Radio has a position but no duration, and cast sources only seek
              when they offer it — canSeek (via useTransport) gates both. */}
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Slider
                value={duration ? shownPosition / duration : 0}
                disabled={!active || !t.canSeek}
                ariaLabel="Playhead"
                scrubLabel={duration ? (v) => fmtTime(v * duration) : undefined}
                {...slider}
              />
            </div>
            <span className="font-mono text-[9.5px] text-faint tabular-nums shrink-0">
              {timeText}
            </span>
          </div>

          {/* transport + volume */}
          <div className="flex items-center gap-1.5">
            <MiniButton enabled={active && t.canPrev} tip="Previous" onClick={t.prev}>
              <SkipBack size={14} />
            </MiniButton>
            <PlayPauseButton size="compact" className="no-drag" />
            <MiniButton enabled={active && t.canNext} tip="Next" onClick={t.next}>
              <SkipForward size={14} />
            </MiniButton>
            <div className="flex-1" />

            {active && hasVolume && preAmp ? (
              // Pre-Amp: mute, then the tray panel's arc at mini scale. The
              // arc is display; the wheel (anywhere on the window) and the
              // arrow keys are the control, as the mute tooltip teaches.
              <>
                {muteBtn}
                <VolumeArc size="mini" level={vol.levelNow} muted={muted} enabled={active} />
              </>
            ) : active && hasVolume && cbus ? (
              // Control Bus: no absolute level — mute then − / + nudges, same
              // order and treatment as the main transport's cbus cluster.
              <>
                {muteBtn}
                <MiniButton
                  enabled={active}
                  tip="Volume down"
                  onClick={() => void tt.command({ type: "volumeStepChange", delta: -1 })}
                >
                  <Minus size={13} />
                </MiniButton>
                <MiniButton
                  enabled={active}
                  tip="Volume up"
                  onClick={() => void tt.command({ type: "volumeStepChange", delta: 1 })}
                >
                  <Plus size={13} />
                </MiniButton>
              </>
            ) : null}
          </div>

          {/* next up. Thin spaces (U+2009) around the dot: a full space plus
              the 0.14em tracking read as a gulf at this size. mt-2 biases the
              column's justify-between so this row gets visibly more air above
              it than the evenly-split gaps would give (mt-1 was imperceptible
              against the line box's own descender space). */}
          <div className="microlabel microlabel-sm truncate min-h-[12px] mt-2">
            {active && next?.metadata
              ? `next · ${next.metadata.title ?? next.metadata.name ?? ""}`
              : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The shared secondary-control skin, plus the frameless window's no-drag. */
function MiniButton({
  children,
  tip,
  enabled,
  onClick,
}: {
  children: React.ReactNode;
  tip: string;
  enabled: boolean;
  onClick(): void;
}): React.JSX.Element {
  return (
    <TransportIconButton
      size="compact"
      tip={tip}
      enabled={enabled}
      className="no-drag"
      onClick={onClick}
    >
      {children}
    </TransportIconButton>
  );
}
