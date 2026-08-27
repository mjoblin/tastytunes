// Scheduled actions (alarms). A 15s tick matches enabled schedules against
// the local clock; each fires at most once per minute-instance. Honest scope:
// alarms fire only while the app is running — the UI says so. A schedule that
// matches while the streamer is disconnected retries on later ticks within
// its minute (device may reconnect mid-minute) but is never fired late.
//
// CATCH-UP ON RESUME (2026-07-26). Node timers stall while the machine sleeps,
// so a schedule whose minute passed during sleep used to be skipped in silence.
// It isn't any more — but the app still never fires late on its own, it ASKS.
// Three rules, all deliberate, all decided by the user:
//
//   · 10-MINUTE WINDOW. Catch-up is only ever reached when something ELSE woke
//     the machine shortly after a due time, and that is the only case worth
//     serving: asleep at 07:00, touched at 07:04, you wanted the music. Lid
//     opened at 08:40 must do NOTHING — an alarm going off 100 minutes late is
//     worse than the silence it replaces.
//   · TURN-OFFS ARE NEVER CAUGHT UP. Only `action: 'on'` is eligible. A late
//     standby has no upside (the streamer's own auto power-down already turns
//     an idle unit off) and a real downside: killing playback someone started
//     deliberately in the meantime.
//   · OFFER, DON'T FIRE — and only ONE. Music appearing unbidden on wake is
//     startling even at four minutes late, so the miss raises a notification
//     and the user decides. Exactly one offer per sleep: the latest missed
//     schedule, never a queue of them.
import { Notification } from "electron";
import { errorMessage } from "@shared/guards";
import type { Schedule } from "@shared/model";
import type { DeviceManager } from "../device/deviceManager";
import { getSettings } from "../data/persist";

const TICK_MS = 15_000;

/** How late a missed wake may be and still be worth offering. */
export const CATCH_UP_WINDOW_MS = 10 * 60_000;
/** Reconnect grace after a wake: the WS comes back dead and the offer's own
 *  action needs the device. Immaterial against a 10-minute window. */
const RECONNECT_POLL_MS = 2_000;
const RECONNECT_GRACE_MS = 20_000;

/**
 * Instances already acted on, keyed by schedule id. In-memory ON PURPOSE: a
 * resume doesn't restart the process, so this survives exactly as long as it
 * needs to and no persistence is required. (A restart is a different failure —
 * see the "schedules die with the app" thread in the ROADMAP.)
 */
const lastFired = new Map<string, string>();

/** When the machine went to sleep — only misses DURING that sleep qualify. */
let sleptAt: number | null = null;

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function fire(dm: DeviceManager, s: Schedule): Promise<void> {
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  if (s.action === "standby") {
    await dm.command({ type: "power", power: "NETWORK" });
    return;
  }
  // Wake: power first (a no-op re-send is guarded off in DeviceManager), then
  // give the device a beat before the preset, and the preset before volume.
  await dm.command({ type: "power", power: "ON" });
  // Fade-in (absent = on): start near silence and ramp to the schedule's
  // volume instead of opening the day at full target. Pre-amp mode only —
  // control-bus has no absolute level to ramp.
  const fade = s.volumePercent != null && s.fadeIn !== false && dm.preAmpVolume() != null;
  if (fade) await dm.command({ type: "setVolumePercent", percent: 1 });
  if (s.presetId != null) {
    await settle(2500);
    // A schedule with its own volume overrides the preset's saved one.
    await dm.command({
      type: "recallPreset",
      presetId: s.presetId,
      skipVolume: s.volumePercent != null,
    });
  }
  if (s.volumePercent != null) {
    await settle(1500);
    if (fade) await dm.fadeInTo(s.volumePercent);
    else await dm.command({ type: "setVolumePercent", percent: s.volumePercent });
  }
}

/** The identity the tick and the catch-up both use for "this firing". */
function instanceKey(d: Date, time: string): string {
  return `${d.toDateString()} ${time}`;
}

export interface CatchUpPick {
  schedule: Schedule;
  /** When it was due — the notification says so, and honesty matters here. */
  dueAt: number;
  instance: string;
}

/**
 * WHICH missed schedule, if any, to offer — pure, so the rules above can be
 * tested exhaustively without a clock, a device or a machine that sleeps.
 *
 * Returns the LATEST eligible miss or null. Latest rather than all: two
 * schedules minutes apart would otherwise recall one preset and then the other
 * seconds later, and the newer instruction is the one the user meant.
 */
export function pickCatchUp(
  schedules: readonly Schedule[],
  opts: { now: number; sleptAt: number | null; fired?: ReadonlyMap<string, string> },
): CatchUpPick | null {
  const { now, sleptAt: slept, fired } = opts;
  if (slept == null) return null;
  let best: CatchUpPick | null = null;
  for (const s of schedules) {
    if (!s.enabled || s.action !== "on" || s.days.length === 0) continue;
    const [hh, mm] = s.time.split(":").map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;
    // Today and yesterday: with a 10-minute window, yesterday can only matter
    // for a schedule that came due in the last minutes before midnight.
    for (const back of [0, 1]) {
      const d = new Date(now);
      d.setDate(d.getDate() - back);
      d.setHours(hh, mm, 0, 0);
      const dueAt = d.getTime();
      if (!s.days.includes(d.getDay())) continue;
      if (dueAt > now) continue;
      if (now - dueAt > CATCH_UP_WINDOW_MS) continue;
      // Missed DURING the sleep. A miss from before we slept has some other
      // cause (the app was quit, the streamer was offline) and its own fix.
      if (dueAt <= slept) continue;
      const instance = instanceKey(d, s.time);
      if (fired?.get(s.id) === instance) continue;
      if (!best || dueAt > best.dueAt) best = { schedule: s, dueAt, instance };
    }
  }
  return best;
}

/** Record the moment the machine went to sleep (powerMonitor 'suspend'). */
export function noteSuspend(at: number = Date.now()): void {
  sleptAt = at;
}

/**
 * On wake: offer the latest wake-schedule missed during that sleep.
 *
 * NOT gated on settings.notifications — that switch is labelled "Track-change
 * notifications" and hints at exactly that. It means "don't narrate what's
 * playing", not "don't tell me an alarm was missed".
 */
export function catchUpOnResume(dm: DeviceManager): void {
  const slept = sleptAt;
  sleptAt = null; // one offer per sleep, whatever happens below
  if (slept == null) return;

  let waited = 0;
  const attempt = (): void => {
    if (dm.snapshot().connection.phase !== "connected") {
      waited += RECONNECT_POLL_MS;
      if (waited > RECONNECT_GRACE_MS) return;
      setTimeout(attempt, RECONNECT_POLL_MS);
      return;
    }
    // Already listening? Then the offer is noise, and recalling a preset over
    // it would be worse — the state-guard idiom wake-on-intent uses.
    if (dm.snapshot().playState?.state === "play") return;

    const pick = pickCatchUp(getSettings().schedules, {
      now: Date.now(),
      sleptAt: slept,
      fired: lastFired,
    });
    if (!pick) return;
    // Claim the instance even though we only OFFERED: the Map means "don't act
    // on this firing again", and a second resume must not re-ask.
    lastFired.set(pick.schedule.id, pick.instance);
    // TWO SURFACES, one state. The notification is the loud one; the Schedules
    // tab is the one that still shows up under Do Not Disturb, or when the
    // banner has been swiped away. Acting on either clears both.
    offered = pick;
    dm.setMissedSchedule({ scheduleId: pick.schedule.id, dueAt: pick.dueAt });
    offerCatchUp(dm, pick);
  };
  setTimeout(attempt, RECONNECT_POLL_MS);
}

/** The live offer, so the in-app surface and the notification act as one. */
let offered: CatchUpPick | null = null;

/** Take the offer — from the notification, or from the Schedules tab. */
export function runMissedSchedule(dm: DeviceManager): void {
  const pick = offered;
  offered = null;
  dm.setMissedSchedule(null);
  if (!pick) return;
  void fire(dm, pick.schedule).catch((e) =>
    console.warn(`catch-up ${pick.schedule.id} failed:`, errorMessage(e)),
  );
}

/** Let it go. The instance stays claimed, so nothing re-offers it. */
export function dismissMissedSchedule(dm: DeviceManager): void {
  offered = null;
  dm.setMissedSchedule(null);
}

/** The offer itself. Clicking it runs the schedule exactly as the tick would. */
function offerCatchUp(dm: DeviceManager, pick: CatchUpPick): void {
  if (!Notification.isSupported()) return;
  const { schedule: s } = pick;
  const preset = dm.snapshot().presets?.presets?.find((p) => p.id === s.presetId);
  const what = preset?.name ?? (s.presetId != null ? `preset ${s.presetId}` : null);

  const n = new Notification({
    title: what ? `Missed “${what}”` : "Missed a scheduled start",
    body: `Due at ${s.time}, while your computer was asleep. Start it now?`,
    // Audible on purpose: a silent banner for a missed alarm is a banner you
    // find later, which is the failure this whole feature exists to fix.
    silent: false,
    actions: [{ type: "button", text: "Start now" }],
  });
  // 'click' is the notification body (every platform); 'action' is the macOS
  // button. Either means yes; runMissedSchedule clears the shared offer, so a
  // double-tap — or a tap after the in-app row was used — does nothing twice.
  const run = (): void => runMissedSchedule(dm);
  n.on("click", run);
  n.on("action", run);
  n.show();
}

export function startScheduler(dm: DeviceManager): void {
  const check = (): void => {
    const now = new Date();
    const time = hhmm(now);
    const day = now.getDay();
    for (const s of getSettings().schedules) {
      if (!s.enabled || s.time !== time || !s.days.includes(day)) continue;
      const instance = instanceKey(now, time);
      if (lastFired.get(s.id) === instance) continue;
      if (dm.snapshot().connection.phase !== "connected") continue;
      lastFired.set(s.id, instance);
      // commands throw on a half-dead socket — a missed schedule is a log
      // line, never an unhandled rejection
      void fire(dm, s).catch((e) => console.warn(`schedule ${s.id} failed:`, errorMessage(e)));
    }
  };
  setInterval(check, TICK_MS);
  // Startup check shortly after launch — late enough for the reconnect.
  setTimeout(check, 3_000);
}
