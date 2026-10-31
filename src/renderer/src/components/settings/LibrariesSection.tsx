import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { type AppSettings, type MediaIndexStatus } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { fmtCount } from "@/lib/format";
import { HeaderChip } from "@/components/chrome/Chrome";
import { PickerPill } from "@/components/controls/PickerPill";
import { useConfirmPopover } from "@/components/chrome/Confirm";
import { SettingRow, Toggle, fmtBytes } from "@/components/settings/SettingsKit";
import { FACT_SEP } from "@/lib/mediaFacts";

// The Libraries section, split out of SettingsScreen.tsx 2026-09-13 (the Settings split: the screen had held every
// section and control at 2,142 lines); the shared rows and controls live in ./SettingsKit.

export function LibrariesSection({
  settings,
  save,
}: {
  settings: AppSettings;
  save(patch: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  const statuses = useStore((s) => s.mediaIndex);

  const age = (at: number | null): string => {
    if (at == null) return "";
    const mins = Math.round((Date.now() - at) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
  };

  return (
    <section className="space-y-3">
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
        <Toggle
          label="Build indexes automatically"
          hint="Automatically index each searchable media server when the streamer connects, and rebuild when the server reports changes. Off means indexes only build from the buttons below. Either way, a playlist or “Open in Library” rebuilds an index that has gone out of date, as the streamer's USB drive does after standby."
          checked={settings.mediaIndexAuto}
          onChange={(mediaIndexAuto) => void save({ mediaIndexAuto })}
        />

        <div>
          <div className="text-[13.5px]">Library index</div>
          <div className="text-[11.5px] text-faint max-w-sm">
            A local copy of each media server&apos;s track list for fast local searching. Rebuilds
            itself when the server reports changes, and everything here can be rebuilt at any time.
          </div>
        </div>

        {statuses.length === 0 && (
          <div className="rounded-lg bg-bg ring-1 ring-edge px-3 py-2.5 text-[12px] text-dim">
            No media servers seen yet. They appear here once the streamer finds them. Open the
            Library (I), or attach USB storage to the streamer.
          </div>
        )}
        {statuses.map((st) => (
          <div key={st.udn} className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="flex-1 min-w-0 text-[12.5px] truncate">
                {st.serverName}
                <span className="block font-mono text-[10.5px] text-faint">
                  {st.state === "building"
                    ? "building…"
                    : st.state === "failed"
                      ? `couldn't index${FACT_SEP}${st.failure ?? "no index"}`
                      : st.state === "none"
                        ? `not indexed${FACT_SEP}search asks the server live`
                        : `${fmtCount(st.tracks)} tracks${FACT_SEP}${fmtCount(st.albums)} albums${FACT_SEP}updated ${age(st.builtAt)}`}
                </span>
              </span>
              <HeaderChip
                onClick={() => void tt.mediaIndexRebuild(st.udn)}
                disabled={st.state === "building"}
                className="shrink-0 flex items-center gap-1.5 text-[12px] px-3 py-1.5 motion-safe:active:scale-90 disabled:opacity-40 disabled:pointer-events-none"
              >
                {st.state === "building" ? (
                  <Loader2 size={13} className="motion-safe:animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                {st.state === "ready" ? "Rebuild" : st.state === "failed" ? "Retry" : "Build"}
              </HeaderChip>
            </div>
            <RecentListRow st={st} chosen={settings.recentlyAddedLists[st.udn]} />
          </div>
        ))}

        <ArtThumbsRow />
      </div>
    </section>
  );
}

/**
 * A SERVER'S OWN RECENTLY ADDED LIST (0.13.0 round 9; shared/recentlyAdded), as a setting in the
 * screen's own idiom (his look, 2026-10-25: the first cut's status line and text links read as
 * status, "a little small/noodly", and it was not clear it could be changed): the label, a
 * sentence saying what it is for, and the app's dropdown (PickerPill as a choice, his ask: the
 * native select read out of place) of the server's folders (the top level and under
 * Music, Audio or Media Library: listRecentCandidates), the one found by its name first, then the
 * rest, then None. A folder chosen from a folder's ⋯ in the Library deeper down is offered too.
 * For a server the index searches, or one with a list chosen; never the streamer's USB drive.
 */
function RecentListRow({
  st,
  chosen,
}: {
  st: MediaIndexStatus;
  chosen: AppSettings["recentlyAddedLists"][string] | undefined;
}): React.JSX.Element | null {
  const shown = st.state === "ready" && (st.strategy === "search" || st.recentList != null);
  const [folders, setFolders] = useState<Awaited<ReturnType<typeof tt.recentListCandidates>>>([]);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    void tt
      .recentListCandidates(st.udn)
      .then((got) => {
        if (live) setFolders(got);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [shown, st.udn]);
  if (!shown) return null;
  const named = folders.find((f) => f.named) ?? null;
  // a folder chosen by hand that is the list found by its name is that list (no second entry)
  const picked = chosen && chosen !== "off" && !(named && chosen.id === named.id) ? chosen : null;
  // what the picker shows: the folder chosen, the list found by its name, or None
  const value =
    st.recentOff || chosen === "off"
      ? "off"
      : picked
        ? `id:${picked.id}`
        : st.recentList
          ? "auto"
          : "off";
  const label = (f: { titlePath: string[] }): string => f.titlePath.join(" › ");
  const others = folders.filter((f) => !f.named);
  // the found list first, a folder chosen deeper down (from a folder's ⋯), the rest, then None
  const options = [
    ...(named || (st.recentList && !st.recentList.chosen)
      ? [{ value: "auto", label: named ? label(named) : (st.recentList?.title ?? "") }]
      : []),
    ...(picked && !others.some((f) => f.id === picked.id)
      ? [{ value: `id:${picked.id}`, label: picked.titlePath.join(" › ") }]
      : []),
    ...others.map((f) => ({ value: `id:${f.id}`, label: label(f) })),
    { value: "off", label: "None" },
  ];
  const set = (v: string): void => {
    if (v === "off") void tt.setRecentlyAddedList(st.udn, "off");
    else if (v === "auto") void tt.setRecentlyAddedList(st.udn, null);
    else {
      const f = folders.find((x) => `id:${x.id}` === v);
      if (f)
        void tt.setRecentlyAddedList(
          st.udn,
          f.named ? null : { id: f.id, title: f.title, titlePath: f.titlePath },
        );
    }
  };
  return (
    <div data-recent-list={st.udn} className="flex items-start gap-3 pl-3 border-l border-edge">
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px]">Recently added</div>
        <div className="text-[11.5px] text-faint max-w-sm">
          Which of this server&apos;s lists fills the Library&apos;s Recently added shelf. Albums
          added from now on are dated by TastyTunes either way.
        </div>
      </div>
      <div className="shrink-0">
        <PickerPill
          id={`recent-${st.udn}`}
          choice
          neutral="None"
          options={options}
          value={value}
          onChange={(v) => set(v ?? "off")}
        />
      </div>
    </div>
  );
}

/**
 * The History tab: the listening record — a local, append-only play log as
 * durable user data (the streamer keeps no history of its own). Recording is
 * on by default because a diary can't be backfilled; there are deliberately
 * no retention knobs (a diary that silently deletes itself was rejected).
 * The truth row reads the files fresh; torn lines and write failures are
 * surfaced here, never hidden.
 */

/**
 * The album-art thumbnail cache's size and its Clear (main/lookups/artThumbs):
 * a row in the card like the others, its Clear the kit's cache button (the
 * Cached lookups row and History's record row wear the same one; a bare text
 * link read too weak — user, 2026-09-14).
 */
function ArtThumbsRow(): React.JSX.Element {
  const [stats, setStats] = useState<{ entries: number; bytes: number } | null>(null);
  useEffect(() => {
    void tt.artThumbsStats().then(setStats);
  }, []);
  const empty = stats != null && stats.entries === 0;
  // the record's confirm on a cache too (user, 2026-09-14): a USB drive's art takes a while to come back
  const confirmClear = useConfirmPopover();
  return (
    <SettingRow
      label="Album art thumbnails"
      hint="Art from servers that can't resize it on request (e.g. the streamer's USB drive) is cached by TastyTunes, up to 200 MB, with the least recently used being automatically removed first."
    >
      {confirmClear.popover}
      <button
        onClick={(e) =>
          confirmClear.ask(e, {
            question:
              "Clear the album art thumbnails? Art is fetched and cached again as it is browsed.",
            verb: "Clear",
            onConfirm: () => void tt.clearArtThumbs().then(setStats),
          })
        }
        disabled={empty}
        className="shrink-0 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all disabled:opacity-40 disabled:hover:text-dim disabled:hover:ring-edge disabled:hover:bg-panel/70"
      >
        {stats == null
          ? "…"
          : empty
            ? "Cache empty"
            : `Clear (${fmtCount(stats.entries)}${FACT_SEP}${fmtBytes(stats.bytes)})`}
      </button>
    </SettingRow>
  );
}
