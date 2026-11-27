import { useEffect, useState } from "react";
import { Moon } from "lucide-react";
import {
  canSleepAtTrackEnd,
  SLEEP_DURATIONS,
  sleepActionOf,
  sleepTimerFor,
  type SleepAction,
} from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { cx, fmtTime } from "@/lib/format";
import { PopoverChrome } from "@/hooks/usePopover";
import { POPOVER_CARD } from "@/components/chrome/Overlay";
import { Switch } from "@/components/controls/Switch";

const ACTION_VERB: Record<SleepAction, string> = { pause: "Pause", standby: "Standby" };

/** Plexamp/Sonos-style sleep timer: pause or standby after a countdown, or at end of track. */
export function SleepTimer(): React.JSX.Element {
  const sleep = useStore((s) => s.sleep);
  const saveSettings = useStore((s) => s.saveSettings);
  const stored = useStore((s) => s.settings.sleepAction);
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // the stored value, never trusted blindly (shared/model sleepActionOf)
  const action = sleepActionOf(stored);
  const sleepFade = useStore((s) => s.settings.sleepFade);
  const preAmp = useStore((s) => s.zoneState?.volume_percent != null);
  const endOfTrack = sleep != null && sleep.minutes == null;

  // Tick once a second while a countdown is live so the popover / tooltip stay fresh.
  useEffect(() => {
    if (sleep?.firesAt == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sleep?.firesAt]);

  const remainingSecs =
    sleep?.firesAt != null ? Math.max(0, Math.round((sleep.firesAt - now) / 1000)) : null;

  const canEndOfTrack = canSleepAtTrackEnd(playState, nowPlaying);

  // The timer itself lives in the main process (it must survive this window
  // closing); these calls arm/adjust it and the store mirrors its pushes.
  const arm = (minutes: number): void => {
    void tt.setSleep(sleepTimerFor(minutes, action, playState, Date.now()));
  };
  const armEndOfTrack = (): void => {
    void tt.setSleep(sleepTimerFor("track", action, playState, Date.now()));
  };
  const chooseAction = (next: SleepAction): void => {
    void saveSettings({ sleepAction: next });
    if (sleep) void tt.setSleep({ ...sleep, action: next });
  };

  const statusLine = sleep
    ? sleep.minutes == null
      ? `${ACTION_VERB[sleep.action]} at end of track`
      : `${ACTION_VERB[sleep.action]} in ${fmtTime(remainingSecs)}`
    : null;

  return (
    <div className="relative">
      <button
        data-tip={open ? undefined : (statusLine ?? "Sleep timer")}
        aria-label={statusLine ?? "Sleep timer"}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "tip-top p-2 rounded-md transition-colors",
          open || sleep ? "text-accent bg-accentdim" : "text-dim hover:text-ink hover:bg-veil",
        )}
      >
        <Moon size={16} strokeWidth={1.9} fill={sleep ? "currentColor" : "none"} />
      </button>

      {open && (
        <>
          <PopoverChrome onClose={() => setOpen(false)} />
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className={cx("absolute bottom-11 right-0 z-40 w-64 p-3", POPOVER_CARD)}>
            <div className="flex items-center justify-between mb-2.5">
              <span className="microlabel">sleep timer</span>
              <div className="flex rounded-md ring-1 ring-edge bg-bg p-0.5">
                {(["pause", "standby"] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => chooseAction(a)}
                    className={cx(
                      "px-2 py-0.5 rounded text-[11px] capitalize transition-colors",
                      action === a ? "bg-accentdim text-accent" : "text-dim hover:text-ink",
                    )}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              {SLEEP_DURATIONS.map(({ minutes, label }) => {
                const on = sleep?.minutes === minutes;
                return (
                  <button
                    key={minutes}
                    onClick={() => arm(minutes)}
                    className={cx(
                      "rounded-lg py-2 text-[12px] transition-colors",
                      on ? "bg-accent text-bg" : "bg-veil text-dim hover:text-ink hover:bg-veil2",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
              <button
                onClick={armEndOfTrack}
                disabled={!canEndOfTrack && !endOfTrack}
                className={cx(
                  "col-span-3 rounded-lg py-2 text-[12px] transition-colors",
                  endOfTrack
                    ? "bg-accent text-bg"
                    : canEndOfTrack
                      ? "bg-veil text-dim hover:text-ink hover:bg-veil2"
                      : "bg-veil text-faint/40 cursor-not-allowed",
                )}
              >
                End of track
              </button>
            </div>

            {/* Fade-out: countdown timers ramp the volume down over the last
                minute, then the level is restored after the action. Pre-amp
                mode only — control-bus has no absolute level to ramp. */}
            {preAmp && (
              <label
                className={cx(
                  "mt-2 flex items-center justify-between gap-2 text-[11.5px] text-dim",
                  endOfTrack ? "opacity-40" : "cursor-pointer",
                )}
                title={
                  endOfTrack
                    ? "An end-of-track timer fires without warning, so there is nothing to fade ahead of."
                    : undefined
                }
              >
                <span>Fade out at the end</span>
                <Switch
                  size="sm"
                  checked={sleepFade}
                  disabled={endOfTrack}
                  onChange={(sleepFade) => void saveSettings({ sleepFade })}
                />
              </label>
            )}

            {/* Always present so the popover height never jumps between states. */}
            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-edge pt-2.5">
              <span className={cx("text-[11.5px]", sleep ? "text-accent" : "text-faint")}>
                {statusLine ?? "Inactive"}
              </span>
              <button
                onClick={() => void tt.setSleep(null)}
                disabled={!sleep}
                className={cx(
                  "text-[11px] transition-colors",
                  sleep ? "text-dim hover:text-ink" : "text-faint/40 cursor-default",
                )}
              >
                Disable
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
