import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { type AppSettings } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { fmtCount } from "@/lib/format";
import { HeaderChip } from "@/components/chrome/Chrome";
import { useConfirmPopover } from "@/components/chrome/Confirm";
import { SettingRow, Toggle, fmtBytes } from "@/components/settings/SettingsKit";

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
          hint="Automatically index each searchable media server when the streamer connects, and rebuild when the server reports changes. Off means indexes only build from the buttons below."
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
          <div key={st.udn} className="flex items-center gap-3">
            <span className="flex-1 min-w-0 text-[12.5px] truncate">
              {st.serverName}
              <span className="block font-mono text-[10.5px] text-faint">
                {st.state === "building"
                  ? "building…"
                  : st.state === "failed"
                    ? `couldn't index · ${st.failure ?? "no index"}`
                    : st.state === "none"
                      ? "not indexed · search asks the server live"
                      : `${fmtCount(st.tracks)} tracks · ${fmtCount(st.albums)} albums · updated ${age(st.builtAt)}`}
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
        ))}

        <ArtThumbsRow />
      </div>
    </section>
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
            : `Clear (${fmtCount(stats.entries)} · ${fmtBytes(stats.bytes)})`}
      </button>
    </SettingRow>
  );
}
