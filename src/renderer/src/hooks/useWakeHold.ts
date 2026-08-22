import { useEffect, useRef, useState } from "react";
import { useStore } from "@/store";

/**
 * The WAKE WINDOW, held until the streamer has actually ARRIVED — the one
 * derivation of "wake finishing is not arrival", shared by every surface with
 * a standby face (the main window's StandbyGate, the tray panel's TrayStandby).
 *
 * WHY A HOLD EXISTS AT ALL. Power flips to ON the moment the wake verb lands,
 * but the device then RE-ANNOUNCES its retained pre-standby play_state —
 * same track, same station, often still claiming `state: 'play'` — before
 * anything newly asked-for has had time to arrive (live-probed; the mock
 * models it as a re-announce ~200ms after the power push). Dropping the
 * sleeping face at power-ON therefore presents the PREVIOUS content as
 * though it were playing, then crossfades to the truth: the reported art
 * flash.
 *
 * WHY THE OLD HOLD REGRESSED (2026-08-03 report). The first fix captured the
 * state signature at the END of the wake and released on any signature
 * change — so a re-announcement landing after that capture WAS the release,
 * and the face dropped straight onto the stale state it existed to cover.
 * It also only armed on the `waking` flag, which the wake-on-intent path
 * sets — a plain press of the wake lamp (a bare `power: 'ON'`) never held
 * at all. And the hold was invisible to the faces, whose copy fell back to
 * the idle "asleep" text mid-hold: the reported asleep → Waking… → asleep
 * flip-flop.
 *
 * THE RULES, in firmware terms:
 *  - ARM when a wake starts: the `waking` flag rising (wake-on-intent), or
 *    power leaving a definite standby value for ON (the lamp press). The
 *    retained identity is captured HERE, before the re-announcement can
 *    land, so the re-announcement — same identity — can never look like
 *    arrival.
 *  - RELEASE on arrival, which is any of: the content identity CHANGING
 *    (a recall of something else landed); the state settling to stop/pause
 *    (the device is honestly idle — a retained pause is real, resumable
 *    state, not a lie); or `play` WITH a position tick (the tick is what
 *    separates actual playback from the re-announcement's claim of it).
 *    A bare same-identity jump to 'play' with no ticks is the
 *    re-announcement's exact fingerprint, and is the one thing that must
 *    not release.
 *  - BOUNDED at 8s past the wake's end, so a recall that never lands (a
 *    dead preset) cannot strand the screen on a sleeping face.
 *  - A drop back out of ON clears the hold — the plain asleep rules own
 *    that state again.
 */
export function useWakeHold(): boolean {
  const waking = useStore((s) => s.waking);
  const power = useStore((s) => s.systemPower?.power);
  const playState = useStore((s) => s.playState);
  const [hold, setHold] = useState<{ sig: string } | null>(null);
  // The playhead matters only while a hold is armed — the selector collapses
  // to a constant otherwise, so nothing re-renders per-second in normal play.
  const playhead = useStore((s) => (hold != null ? s.playhead : null));

  const sig = `${playState?.queue_id ?? ""}|${playState?.metadata?.title ?? ""}`;
  const state = playState?.state;
  const wasWaking = useRef(false);
  // The VALUE, not a boolean: arming on the OFF→ON edge must require a
  // definite standby value first, or the boot-time power push (undefined→ON)
  // arms a hold and flashes the sleeping face over a perfectly awake app.
  const lastPower = useRef<string | null>(null);
  // The playhead's last observed SECONDS, ratcheted DOWN on any restart. A
  // timestamp is useless as a liveness signal — the store stamps `at` on
  // EVERY play_state push, so the re-announcement itself "ticks" by that
  // measure (found by the S8 wake-window checks failing against it). Only
  // secs moving FORWARD from the last observed value means real playback;
  // ratcheting down on a decrease means a recall that restarts at 0 releases
  // on its first genuine tick rather than waiting to pass the stale count.
  const lastSecs = useRef<number | null>(null);

  useEffect(() => {
    const wokeByIntent = !wasWaking.current && waking;
    const wokeByLamp =
      (lastPower.current === "NETWORK" || lastPower.current === "ECO_MODE") && power === "ON";
    if ((wokeByIntent || wokeByLamp) && hold == null) {
      setHold({ sig });
      lastSecs.current = useStore.getState().playhead?.secs ?? null;
    }
    wasWaking.current = waking;
    lastPower.current = power ?? null;
    if (hold != null && !waking && power != null && power !== "ON") setHold(null);
  }, [waking, power, hold, sig]);

  useEffect(() => {
    if (hold == null || waking) return;
    const identityChanged = sig !== hold.sig;
    const settledIdle = state === "stop" || state === "pause";
    const secs = playhead?.secs ?? null;
    const advancing = secs != null && lastSecs.current != null && secs > lastSecs.current;
    if (secs != null && (lastSecs.current == null || secs < lastSecs.current)) {
      lastSecs.current = secs;
    }
    const genuinelyPlaying = state === "play" && advancing;
    if (identityChanged || settledIdle || genuinelyPlaying) {
      setHold(null);
      return;
    }
    const t = setTimeout(() => setHold(null), 8000);
    return () => clearTimeout(t);
  }, [hold, waking, sig, state, playhead]);

  return hold != null;
}
