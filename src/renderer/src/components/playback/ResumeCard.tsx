import { useState } from "react";
import { Cable, Cast, Play, X } from "lucide-react";
import type { HeldState } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { MediaArt } from "@/components/media/MediaArt";
import { fmtRelative, fmtTime } from "@/lib/format";

/**
 * "Pick up where you left off" on the standby face (rebuilt in 0.10.0 from the user's ask,
 * 2026-10-06: "the state i was in when i put the streamer in standby is being resumed").
 * It offers what the streamer was doing when it went to sleep (HeldState, kept by main,
 * since the streamer says nothing while it sleeps), and Resume puts it back: the same queue
 * entry from the same point (a preset's or a playlist's track included, nothing added to the
 * queue), the station, or the source a streaming service or an input played on. It replaced
 * the listening record's album offer (0.8.0), which read history rather than the streamer
 * and offered an album the user had since moved on from when the plays after it were too
 * short to record; agents keep that reading (history_resume). The ✕ dismisses this standby's
 * offer for good (it survives a restart; the next standby brings a new one), and the face
 * then shows nothing in its place: the old "Not now" fell back to a Last played line naming
 * the same track (user, 2026-10-06). The Last played line is for a streamer with nothing
 * held at all.
 */

/** The line under the title: where the track came from and how far in, or what to expect. */
function detail(held: HeldState): string | null {
  if (held.kind === "queue") {
    const from =
      held.via?.kind === "preset"
        ? held.via.name && `Preset “${held.via.name}”`
        : held.via?.kind === "playlist"
          ? `Playlist “${held.via.name}”`
          : held.album;
    const at =
      held.position != null && held.position >= 5
        ? `${fmtTime(held.position)}${held.duration ? ` of ${fmtTime(held.duration)}` : ""}`
        : null;
    return [from, at].filter(Boolean).join(" · ") || null;
  }
  if (held.kind === "radio") return held.sourceName ?? "Internet Radio";
  if (held.kind === "service") return "Continue from your phone or computer";
  return null;
}

export function ResumeCard({
  fallback = null,
}: {
  /** Rendered when there is no offer — the standby face keeps its Last played line. */
  fallback?: React.ReactNode;
}): React.JSX.Element | null {
  const held = useStore((s) => s.held);
  const dismissedAt = useStore((s) => s.settings.resumeDismissedAt);
  const saveSettings = useStore((s) => s.saveSettings);
  const [busy, setBusy] = useState(false);
  if (!held) return <>{fallback}</>;
  if (held.at === dismissedAt) return null;

  const resume = async (): Promise<void> => {
    setBusy(true);
    try {
      // a failure toasts centrally (WRITE_FAILURES)
      await tt.command({ type: "resumeHeld" });
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };
  const title =
    held.kind === "queue" || held.kind === "radio" ? held.title : (held.sourceName ?? held.title);
  const line = detail(held);
  return (
    <div
      data-resume-card
      data-resume-kind={held.kind}
      className="mt-4 flex items-center gap-4 rounded-xl bg-raised/50 ring-1 ring-edge px-4 py-3 text-left max-w-[520px]"
    >
      <MediaArt
        src={held.kind === "queue" || held.kind === "radio" ? held.artUrl : null}
        kind={held.kind === "radio" ? "station" : "track"}
        icon={held.kind === "service" ? Cast : held.kind === "input" ? Cable : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="microlabel text-gold mb-[3px]">Pick up where you left off</div>
        <div className="truncate text-[13.5px] text-ink" data-resume-title>
          {title}
          {held.kind === "queue" && held.artist ? (
            <span className="text-dim"> · {held.artist}</span>
          ) : null}
        </div>
        <div className="truncate text-[12px] text-dim" data-resume-detail>
          {line}
          <span className="text-faint">
            {line ? " · " : ""}
            {fmtRelative(held.at)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          data-resume-play
          disabled={busy}
          onClick={() => void resume()}
          className="inline-flex items-center gap-1.5 rounded-full h-8 px-3 text-[12px] bg-gold text-[#0e0d0b] hover:brightness-110 motion-safe:active:scale-95 transition-all disabled:opacity-60"
        >
          <Play size={13} />
          Resume
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          data-resume-dismiss
          onClick={() => void saveSettings({ resumeDismissedAt: held.at })}
          className="shrink-0 rounded p-1 text-faint hover:text-ink transition-colors"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
