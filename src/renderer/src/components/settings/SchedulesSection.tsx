import { AlarmClock, Plus, Trash2, X } from "lucide-react";
import { type AppSettings, type Schedule } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { cx } from "@/lib/format";
import { Switch } from "@/components/controls/Switch";
import { HeaderChip, PrimaryButton } from "@/components/chrome/Chrome";
import { NumberField } from "@/components/settings/SettingsKit";
import { Segmented } from "@/components/controls/Segmented";

// The Schedules section, split out of SettingsScreen.tsx 2026-09-13 (the Settings split: the screen had held every
// section and control at 2,142 lines); the shared rows and controls live in ./SettingsKit.

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * A wake this schedule missed while the computer was asleep, offered in place.
 *
 * The SECOND surface for the same offer — the OS notification is the loud one,
 * but it is silenced by Do Not Disturb, by a Focus mode, or simply by being
 * swiped away, and a missed alarm that leaves no trace anywhere is the failure
 * this whole feature exists to fix. This one sits with the schedule it belongs
 * to, where you would look to ask "did that run?", and stays until answered.
 *
 * Deliberately NOT a toast: toasts are a single slot that any later one evicts,
 * and they self-dismiss in seconds — both wrong for an offer that has to
 * survive you looking away.
 */
function MissedRow({ dueAt }: { dueAt: number }): React.JSX.Element {
  const due = new Date(dueAt);
  const time = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
  return (
    <div
      data-missed-schedule
      className="flex items-center gap-3 rounded-lg ring-1 ring-gold/40 bg-golddim px-3 py-2"
    >
      <AlarmClock size={14} strokeWidth={1.9} className="shrink-0 text-gold" />
      <span className="flex-1 min-w-0 text-[12.5px] text-gold">
        Missed {time} while your computer was asleep.
      </span>
      <PrimaryButton
        onClick={() => void tt.scheduleRunMissed()}
        className="shrink-0 text-[12px] px-3 py-1"
      >
        Start now
      </PrimaryButton>
      <button
        onClick={() => void tt.scheduleDismissMissed()}
        data-tip="Dismiss"
        aria-label="Dismiss the missed schedule"
        className="tip-top tip-end shrink-0 flex items-center justify-center h-7 w-7 rounded-md text-gold/70 hover:text-gold hover:bg-gold/10 motion-safe:active:scale-90 transition-all"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

/** Plain-English one-liner of exactly what a schedule will (or won't) do. */
function describeSchedule(s: Schedule): string {
  if (!s.enabled) return "Off. Flip the switch to enable it.";
  if (s.days.length === 0) return "Never fires: no days selected.";
  const days =
    s.days.length === 7
      ? "every day"
      : s.days.join(",") === "1,2,3,4,5"
        ? "on weekdays"
        : s.days.join(",") === "0,6"
          ? "on weekends"
          : `on ${s.days.map((d) => DAY_NAMES[d]).join(", ")}`;
  if (s.action === "standby") return `Puts the streamer in standby at ${s.time} ${days}.`;
  const extras = [
    s.presetId != null ? `recalls preset ${s.presetId}` : null,
    s.volumePercent != null ? `sets volume to ${s.volumePercent}%` : null,
  ].filter(Boolean);
  return `Wakes the streamer${extras.length ? `, ${extras.join(", ")},` : ""} at ${s.time} ${days}.`;
}

/**
 * Scheduled actions: BluOS-style alarms. Each schedule is a card — time,
 * day-of-week chips, wake/standby, and (for wake) optional preset + volume.
 * Executed by the main process; honest caveat up top about app-must-be-running.
 */
export function SchedulesSection({
  settings,
  save,
}: {
  settings: AppSettings;
  save(patch: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  const presets = useStore((s) => s.presets?.presets ?? null);
  const showToast = useStore((s) => s.showToast);
  const missed = useStore((s) => s.missedSchedule);
  const schedules = settings.schedules;

  const update = (id: string, patch: Partial<Schedule>): void => {
    void save({ schedules: schedules.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  };
  /**
   * Deleting a schedule was instant with nothing behind it — one click and a
   * standing instruction to your hi-fi was gone, with no way to see what it
   * had been. Still instant (it's one small item, and a confirm on every
   * delete is the trade we've decided against), now with the offer behind it.
   */
  const remove = (id: string): void => {
    const index = schedules.findIndex((s) => s.id === id);
    const removed = schedules[index];
    if (!removed) return;
    void save({ schedules: schedules.filter((s) => s.id !== id) });
    const undoId = useStore
      .getState()
      .pushUndo(
        `Delete the ${removed.time} ${removed.action === "on" ? "Wake" : "Standby"} Schedule`,
        () => restore(index, removed),
      );
    showToast({
      kind: "success",
      text: `Deleted the ${removed.time} ${removed.action === "on" ? "wake" : "standby"} schedule`,
      action: { label: "Undo", undo: () => useStore.getState().runUndo(undoId) },
    });
  };

  /** Splice it back where it was, into the list AS IT IS NOW — undoing must not
   *  discard a schedule added or edited while the offer was up. */
  const restore = (index: number, sched: Schedule): void => {
    const live = useStore.getState().settings.schedules;
    if (live.some((s) => s.id === sched.id)) return;
    const next = [...live];
    next.splice(Math.min(index, next.length), 0, sched);
    void save({ schedules: next });
  };
  const add = (): void => {
    const sched: Schedule = {
      id: Math.random().toString(36).slice(2, 10),
      // Off until armed — adding a card must never schedule anything by itself.
      enabled: false,
      time: "07:30",
      days: [1, 2, 3, 4, 5],
      action: "on",
      presetId: null,
      volumePercent: null,
    };
    void save({ schedules: [...schedules, sched] });
  };

  return (
    <section className="space-y-3">
      <p className="text-[11.5px] text-faint px-1">
        Wake the streamer (optionally recalling a preset and setting a volume) or send it to standby
        at set times. Schedules fire only while TastyTunes is running and connected.
      </p>

      {schedules.map((s) => (
        <div key={s.id} className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-4">
          {missed?.scheduleId === s.id && <MissedRow dueAt={missed.dueAt} />}
          <div className="flex items-center gap-3">
            {/* UNCONTROLLED while editing (defaultValue, not value): Chrome's
                time input emits "" mid-edit — after the first minute digit —
                and a controlled value would snap the field back between the
                two keystrokes (user, 2026-08-24: "it only changes the second
                of the two digits"). Complete values commit on change. */}
            <input
              type="time"
              key={s.id}
              defaultValue={s.time}
              onChange={(e) => {
                if (e.target.value) update(s.id, { time: e.target.value });
              }}
              className="bg-bg rounded-lg ring-1 ring-edge px-2.5 py-1.5 text-[13px] font-mono outline-none focus:ring-edge2"
            />
            <Segmented<Schedule["action"]>
              value={s.action}
              onChange={(action) => update(s.id, { action })}
              options={[
                { value: "on", label: "Wake" },
                { value: "standby", label: "Standby" },
              ]}
            />
            <div className="flex-1" />
            <Switch checked={s.enabled} onChange={(enabled) => update(s.id, { enabled })} />
            <button
              onClick={() => remove(s.id)}
              aria-label="Delete schedule"
              className="p-1.5 rounded-md text-faint hover:text-alert transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {DAY_LABELS.map((label, day) => (
              <button
                key={day}
                onClick={() =>
                  update(s.id, {
                    days: s.days.includes(day)
                      ? s.days.filter((d) => d !== day)
                      : [...s.days, day].sort(),
                  })
                }
                aria-label={`Day ${day}`}
                className={cx(
                  "w-7 h-7 rounded-full text-[11px] font-mono transition-colors",
                  s.days.includes(day)
                    ? "bg-amberdim text-amber ring-1 ring-amber/40"
                    : "text-faint hover:text-dim ring-1 ring-edge",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div
            className={cx(
              "text-[11.5px]",
              s.enabled && s.days.length > 0 ? "text-dim" : "text-faint",
            )}
          >
            {describeSchedule(s)}
          </div>

          {s.action === "on" && (
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2.5 text-[12.5px] text-dim">
                Preset
                <select
                  value={s.presetId ?? ""}
                  onChange={(e) =>
                    update(s.id, {
                      presetId: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  className="bg-bg rounded-lg ring-1 ring-edge px-2 py-1.5 text-[12.5px] outline-none focus:ring-edge2 max-w-56"
                >
                  <option value="">—</option>
                  {(presets ?? [])
                    .filter((p) => p.id != null)
                    .map((p) => (
                      <option key={p.id} value={p.id!}>
                        {p.id} · {p.name ?? "Preset"}
                      </option>
                    ))}
                  {/* a saved preset that isn't in the current list stays selectable */}
                  {s.presetId != null && !(presets ?? []).some((p) => p.id === s.presetId) && (
                    <option value={s.presetId}>{s.presetId}</option>
                  )}
                </select>
              </label>
              <label
                className="flex items-center gap-2.5 text-[12.5px] text-dim"
                title="Overrides the preset's own saved volume, if it has one."
              >
                Volume
                <NumberField
                  value={s.volumePercent}
                  min={0}
                  max={100}
                  allowEmpty
                  placeholder="—"
                  widthClass="w-16"
                  onCommit={(volumePercent) => update(s.id, { volumePercent })}
                />
              </label>
              {/* Always visible; disabled until the schedule has a volume to
                  fade up to (the end-of-track pattern: a greyed switch
                  teaches the rule, a hidden one buries it). */}
              <label
                className={cx(
                  "flex items-center gap-2 text-[12.5px] text-dim",
                  s.volumePercent == null ? "opacity-40" : "cursor-pointer",
                )}
                title={
                  s.volumePercent == null
                    ? "Set a volume for this schedule to fade up to."
                    : "Ramp up to the volume instead of jumping to it."
                }
              >
                Fade in
                <Switch
                  size="sm"
                  checked={s.fadeIn !== false}
                  disabled={s.volumePercent == null}
                  onChange={(fadeIn) => update(s.id, { fadeIn })}
                />
              </label>
            </div>
          )}
        </div>
      ))}

      <HeaderChip
        onClick={add}
        className="flex items-center gap-2 text-[12.5px] px-3 py-2 motion-safe:active:scale-95"
      >
        <Plus size={14} />
        Add schedule
      </HeaderChip>
    </section>
  );
}

/**
 * ListenBrainz scrobbling: token field + enable toggle + live token status.
 * The token is validated against listenbrainz.org whenever it changes (and on
 * mount if present) so the row always says whether scrobbling actually works.
 */
