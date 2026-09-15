import { useEffect, useRef, useState } from "react";
import type { ZonePlayState } from "@shared/smoip";
import { useStore } from "@/store";

/**
 * The WAKE WINDOW, held until the streamer has actually ARRIVED — the one
 * derivation of "wake finishing is not arrival", shared by every surface with
 * a standby face (the main window's StandbyGate, the tray panel's TrayStandby).
 *
 * WHY A HOLD EXISTS AT ALL. Power flips to ON the moment the wake verb lands,
 * but the device then RE-ANNOUNCES what it held through standby before
 * anything newly asked-for has had time to arrive. Dropping the sleeping face
 * at power-ON therefore presents the PREVIOUS content as though it were the
 * answer, then crossfades to the truth: the reported art flash.
 *
 * WHAT THE DEVICE ACTUALLY SENDS (live-probed against the Evo 2026-09-15, the
 * user's own sequence; the mock and the demo streamer model it):
 *  - In standby, play_state reads `not_ready` with NO metadata at all — no
 *    queue id, no title, no art — and now_playing is an idle prompt. So the
 *    identity of what the device holds cannot be read while it sleeps; it
 *    has to be REMEMBERED from before.
 *  - Waking with a TRACK loaded: ~50 ms after ON a `stop` frame carrying the
 *    queue id and the position but no words, then ~60 ms later a `pause`
 *    frame with the title and the art. An honest pause of the old track —
 *    which is exactly what the user did NOT ask for when a preset key woke
 *    the device, and it lands inside the wake's 2.5 s settle, before the
 *    recall is even sent.
 *  - Waking with a STATION loaded: `ready` (a radio class, no station), then
 *    `connecting` with the station and its art, and the device reconnects
 *    on its own, reaching `play` ten seconds on. Radio never ticks a position.
 *  - A recall lands ~100 ms after it is sent: `connecting` with no words,
 *    then the station and its art 15 ms later.
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
 * WHY IT REGRESSED AGAIN (2026-09-15 report: a song playing, the streamer put
 * to sleep, "2" pressed for a station — "a flash of the album art I was
 * previously listening to"). The hold read standby's play_state for the
 * retained identity, which is empty on the real device, so the re-announced
 * track read as a CHANGE of identity; and it took the retained `pause` as an
 * honest idle. Both released the face the instant the settle ended, which is
 * the instant the recall goes out, and Now Playing mounted on the old track
 * with its cover for the hundred milliseconds until the station landed. The
 * mock kept the title through standby and re-announced a `play` claim, so
 * the suite never saw either.
 *
 * THE RULES, in firmware terms:
 *  - ARM when a wake starts: the `waking` flag rising (wake-on-intent), or
 *    power leaving a definite standby value for ON (the lamp press). The
 *    RETAINED identity is the last one KNOWN — the frame at hand when it
 *    says what is loaded, else the last frame that did (standby's says
 *    nothing) — captured HERE, before the re-announcement can land. A wake
 *    on intent also keeps the NAME of what was asked for when the verb
 *    carried one (a preset's, a station's; main resolves it).
 *  - An identity is the queue entry, else the station or the title; a frame
 *    with none (standby, the first frame after a wake, a recall's first) is
 *    UNKNOWN and never counts as a change. A frame is DESCRIBED when it
 *    carries a title or a station.
 *  - RELEASE on arrival. For a LAMP wake, whatever the device settles on is
 *    the truth: a described frame that is not a `play` claim (an honest
 *    pause of the old track, a station connecting), a `play` reached from
 *    another state or with the playhead advancing, the device's honest empty
 *    (`ready` with no queue and no words), or a described frame of another
 *    identity. For a wake ON INTENT, the retained state settling is NOT the
 *    arrival of what was asked for: release only on the asked name arriving,
 *    a described frame of ANOTHER identity than the retained one, a `play`
 *    reached from another state or advancing (the verb resumed the same
 *    content), or the honest empty. A same-identity `play` claim with no
 *    movement is the re-announcement's fingerprint and never releases.
 *    With no retained identity to compare against (the app came up while
 *    the device slept), an intent wake falls back to the lamp's rules.
 *  - BOUNDED at 8s past the wake's end, so a recall that never lands (a
 *    dead preset) or a station that connects slowly cannot strand the
 *    screen on a sleeping face. The bound is absolute, not re-armed by the
 *    device's pushes.
 *  - A drop back out of ON clears the hold — the plain asleep rules own
 *    that state again.
 */
const BOUND_MS = 8000;

const named = (s: string | null | undefined): string | null =>
  s && s.trim() ? s.trim().toLowerCase() : null;

/** The content's identity when the frame says what is loaded: the queue entry, else the
 *  station or the title; null when it says nothing. */
export const wakeIdentityOf = (ps: ZonePlayState | null): string | null => {
  if (!ps) return null;
  if (ps.queue_id != null) return `q:${ps.queue_id}`;
  const name = named(ps.metadata?.station) ?? named(ps.metadata?.title);
  return name ? `n:${name}` : null;
};
/** Whether the frame carries words for what is loaded (a title or a station). */
const describedBy = (ps: ZonePlayState | null): boolean =>
  named(ps?.metadata?.station) != null || named(ps?.metadata?.title) != null;
/** The device's honest empty: ready with no queue and no words. */
const emptyIdle = (ps: ZonePlayState | null): boolean =>
  ps?.state === "ready" && ps.queue_id == null && !describedBy(ps);

interface Hold {
  /** The identity held through standby, as last known; null when never seen. */
  retained: string | null;
  /** A verb is in flight (wake-on-intent) rather than a bare lamp press. */
  intent: boolean;
  /** The name of what the verb asked for, when it carried one. */
  asked: string | null;
}

export function useWakeHold(): boolean {
  const waking = useStore((s) => s.waking);
  const wakingFor = useStore((s) => s.wakingFor);
  const power = useStore((s) => s.systemPower?.power);
  const playState = useStore((s) => s.playState);
  const [hold, setHold] = useState<Hold | null>(null);
  // The playhead matters only while a hold is armed — the selector collapses
  // to a constant otherwise, so nothing re-renders per-second in normal play.
  const playhead = useStore((s) => (hold != null ? s.playhead : null));

  const identity = wakeIdentityOf(playState);
  const described = describedBy(playState);
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
  /** The last identity any frame carried: standby's carries none, so the retained
   *  one is remembered from before it. */
  const lastKnown = useRef<string | null>(null);
  /** Whether a state other than `play` has shown since the wake ended: a `play`
   *  reached from one is real, a `play` claimed from the first frame is not. */
  const moved = useRef(false);
  /** When the wake ended (the first release pass), for the absolute bound. */
  const endedAt = useRef<number | null>(null);

  useEffect(() => {
    const wokeByIntent = !wasWaking.current && waking;
    const wokeByLamp =
      (lastPower.current === "NETWORK" || lastPower.current === "ECO_MODE") && power === "ON";
    if ((wokeByIntent || wokeByLamp) && hold == null) {
      setHold({
        retained: identity ?? lastKnown.current,
        intent: wokeByIntent,
        asked: wokeByIntent ? named(wakingFor) : null,
      });
      lastSecs.current = useStore.getState().playhead?.secs ?? null;
      moved.current = false;
      endedAt.current = null;
    }
    if (identity != null) lastKnown.current = identity;
    wasWaking.current = waking;
    lastPower.current = power ?? null;
    if (hold != null && !waking && power != null && power !== "ON") setHold(null);
  }, [waking, wakingFor, power, hold, identity]);

  useEffect(() => {
    if (hold == null || waking) return;
    if (endedAt.current == null) endedAt.current = Date.now();
    if (state !== "play") moved.current = true;
    const secs = playhead?.secs ?? null;
    const advancing = secs != null && lastSecs.current != null && secs > lastSecs.current;
    if (secs != null && (lastSecs.current == null || secs < lastSecs.current)) {
      lastSecs.current = secs;
    }
    const playing = state === "play" && described && (advancing || moved.current);
    const another =
      described && identity != null && hold.retained != null && identity !== hold.retained;
    const name = named(playState?.metadata?.station) ?? named(playState?.metadata?.title);
    const askedArrived = hold.asked != null && name != null && name === hold.asked;
    const lampRules = (described && state !== "play") || another || playing || emptyIdle(playState);
    const arrived =
      hold.intent && hold.retained != null
        ? askedArrived || another || playing || emptyIdle(playState)
        : lampRules;
    if (arrived) {
      setHold(null);
      return;
    }
    const t = setTimeout(() => setHold(null), Math.max(0, endedAt.current + BOUND_MS - Date.now()));
    return () => clearTimeout(t);
  }, [hold, waking, identity, described, state, playhead, playState]);

  return hold != null;
}
