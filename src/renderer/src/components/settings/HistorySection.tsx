import { useEffect, useState } from "react";
import { clearRecentsWithUndo } from "@/lib/recents";
import { LISTEN_FLOOR_SECS, type AppSettings, type ListeningRecordStats } from "@shared/model";
import { tt } from "@/api";
import { useConfirmPopover } from "@/components/chrome/Confirm";
import { useStore } from "@/store";
import { fmtCount } from "@/lib/format";
import { HeaderChip } from "@/components/chrome/Chrome";
import { SettingRow, Toggle, fmtBytes } from "@/components/settings/SettingsKit";

// The History section, split out of SettingsScreen.tsx 2026-09-13 (the Settings split: the screen had held every
// section and control at 2,142 lines); the shared rows and controls live in ./SettingsKit.

export function HistorySection({
  settings,
  save,
}: {
  settings: AppSettings;
  save(patch: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  const [fetched, setFetched] = useState<ListeningRecordStats | null>(null);
  useEffect(() => {
    void tt.listeningStats().then(setFetched);
  }, []);
  // Live: main pushes fresh stats after every append, so the row ticks at
  // the moment an event lands — the rule demonstrating itself.
  const pushed = useStore((s) => s.listeningStats);
  const stats = pushed ?? fetched;
  const recentsCount = useStore((s) => s.recents.length);
  const confirmClear = useConfirmPopover();
  const showToast = useStore((s) => s.showToast);
  const sinceLabel =
    stats?.since != null
      ? new Date(stats.since).toLocaleDateString(undefined, { month: "short", year: "numeric" })
      : null;

  return (
    <section className="space-y-3">
      <p className="text-[11.5px] text-faint px-1">
        The record is a local-only, long-term history of your listening. TastyTunes reads it for
        play counts and last-played facts in the Library and for the resume offer on Now Playing,
        and AI agents can read it (Settings › AI agents). More will build on it: a year-end review
        is the kind of thing it makes possible. The Recent list, below, is a shorter log, kept and
        switched separately.
      </p>
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
        <Toggle
          label="Listening record"
          hint={`Keeps a local log of what plays and for how long (local media, radio, AirPlay and other sources) in plain files. A play is recorded when its track changes or stops, if it played for at least ${LISTEN_FLOOR_SECS} seconds by then. The record stays on this computer.`}
          checked={settings.listeningRecord}
          onChange={(listeningRecord) => void save({ listeningRecord })}
        />

        <Toggle
          label="Show listening history in the app"
          hint="Last played in album headers, play counts and the Played filter in the Library, and the resume offer on Now Playing. The record itself keeps logging."
          checked={settings.showListeningHistory}
          onChange={(showListeningHistory) => void save({ showListeningHistory })}
        />

        <SettingRow
          label="The record"
          hint={
            stats == null
              ? "…"
              : stats.events === 0
                ? `Empty. Plays are recorded after ${LISTEN_FLOOR_SECS} seconds of real play time.`
                : `${fmtCount(stats.events)} events · ${fmtBytes(stats.bytes)}${sinceLabel ? ` · since ${sinceLabel}` : ""}`
          }
        >
          <div className="flex items-center gap-2">
            <HeaderChip
              onClick={() =>
                void tt.listeningExport().then((res) => {
                  if (res != null)
                    showToast({
                      kind: "success",
                      text: `Exported ${fmtCount(res.events)} events to ${res.file}`,
                    });
                })
              }
              disabled={stats == null || stats.events === 0}
              className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90 disabled:opacity-40 disabled:pointer-events-none"
            >
              Export…
            </HeaderChip>
            <button
              onClick={(e) =>
                confirmClear.ask(e, {
                  question: "Delete the whole listening record? There is no undo.",
                  verb: "Delete",
                  onConfirm: () => void tt.listeningClear().then(setFetched),
                })
              }
              disabled={stats == null || stats.events === 0}
              className="shrink-0 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all disabled:opacity-40 disabled:hover:text-dim disabled:hover:ring-edge disabled:hover:bg-panel/70"
            >
              Clear
            </button>
          </div>
        </SettingRow>

        {stats?.pending != null && (
          <div className="text-[11.5px] text-faint">
            {stats.pendingEligible ? (
              <>&ldquo;{stats.pending}&rdquo; will be added when it changes or stops.</>
            ) : (
              <>
                &ldquo;{stats.pending}&rdquo; will be added if it plays for at least{" "}
                {LISTEN_FLOOR_SECS} seconds.
              </>
            )}
          </div>
        )}

        {stats != null && stats.unreadableLines > 0 && (
          <div className="rounded-lg bg-bg ring-1 ring-edge px-3 py-2.5 text-[12px] text-dim">
            {stats.unreadableLines} unreadable line{stats.unreadableLines === 1 ? "" : "s"} skipped
            while reading the record (an interrupted write leaves a partial last line, and the rest
            of the record is unaffected).
          </div>
        )}
        {stats?.writeError != null && (
          <div className="rounded-lg bg-bg ring-1 ring-alert/40 px-3 py-2.5 text-[12px] text-alert">
            Couldn&apos;t write to the record: {stats.writeError}
          </div>
        )}
      </div>
      {/* THE RECENT LIST (moved here from Behavior, 2026-09-17): the other local log,
          named for the view it fills, beside the record so both switches are found together */}
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
        <Toggle
          label="Recent list"
          hint="The Recent view on the History screen (H) and the tray panel's Recent tab: the last tracks and stations played, kept only on this computer. Separate from the listening record above. Off stops adding to it."
          checked={settings.recents}
          onChange={(recents) => void save({ recents })}
        />
        <SettingRow
          label="The list"
          hint={
            recentsCount > 0
              ? `${fmtCount(recentsCount)} ${recentsCount === 1 ? "entry" : "entries"}.`
              : "Empty."
          }
        >
          <button
            data-recents-clear
            onClick={() => void clearRecentsWithUndo()}
            disabled={recentsCount === 0}
            className="shrink-0 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all disabled:opacity-40 disabled:hover:text-dim disabled:hover:ring-edge disabled:hover:bg-panel/70"
          >
            Clear
          </button>
        </SettingRow>
      </div>
      {confirmClear.popover}
    </section>
  );
}
