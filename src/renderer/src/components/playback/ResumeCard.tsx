import { tt } from "@/api";
import { useEffect, useMemo, useState } from "react";
import { Play } from "lucide-react";
import { type MediaNode, trackPosition } from "@shared/model";
import { useStore } from "@/store";
import { MediaArt } from "@/components/media/MediaArt";
import { usePlayStats, resumeRun, resumeTarget } from "@/lib/playStats";
import { fmtAgo } from "@/lib/format";

/**
 * "Pick up where you left off" (0.8.0, the listening record's first reading
 * surface on Now Playing). Shown only while nothing is playing: the most
 * recent run of plays from one album, within the last week, that stopped
 * before the album's end — resolved against the library for the track to
 * resume from. Resume = the album's Play from here, starting at that track.
 * "Not now" hides the offer for this run (session memory; a new run makes a
 * new offer).
 */
interface Offer {
  key: string;
  album: MediaNode;
  udn: string;
  next: MediaNode;
  position: number;
  total: number;
  lastAt: number;
}

let dismissedKey: string | null = null;
/** More tracks than any album has — a folder, a genre, a whole library. */
const RESUME_MAX_TRACKS = 100;

export function ResumeCard(): React.JSX.Element | null {
  const play = usePlayStats();
  const showToast = useStore((s) => s.showToast);
  const run = useMemo(() => resumeRun(play.recent), [play.recent]);
  const runKey = run ? `${run.album}|${run.last.at}` : null;
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setOffer(null);
    if (!run || !runKey || runKey === dismissedKey) return;
    void (async () => {
      const q = { kind: "album" as const, title: run.album, artist: run.artist };
      // the album's own artist first; a compilation's tracks carry performers,
      // so fall back to the title alone
      const info =
        (await tt.mediaNodeInfo(q).catch(() => null)) ??
        (run.artist ? await tt.mediaNodeInfo({ ...q, artist: null }).catch(() => null) : null);
      const node = info?.node;
      const udn = node?.serverUdn ?? info?.serverUdn ?? null;
      if (!node || !udn) return;
      // BROWSE the album's own container for the tracks, never the index's
      // pooled copies: on servers whose ids embed the browse path (Asset) a
      // pooled track's id and parentId belong to the search scope the index
      // was crawled from — the WHOLE LIBRARY — and Play from here on that
      // container queued 2,528 tracks (user, 2026-09-04). The container the
      // card resumes is the one whose listing the target came from.
      const kids = await tt.mediaBrowse(udn, node.id, []).catch(() => [] as MediaNode[]);
      const tracks = [...kids.filter((t) => !t.isContainer)].sort(
        (a, b) => (trackPosition(a) ?? 0) - (trackPosition(b) ?? 0),
      );
      // an "album" container the size of a library is not an album: no offer
      if (tracks.length === 0 || tracks.length > RESUME_MAX_TRACKS) return;
      const next = resumeTarget(run, tracks);
      if (!next || cancelled) return;
      setOffer({
        key: runKey,
        album: node,
        udn,
        next,
        position: tracks.indexOf(next) + 1,
        total: tracks.length,
        lastAt: run.last.at,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [run, runKey]);

  if (!offer) return null;
  const resume = async (): Promise<void> => {
    setBusy(true);
    try {
      // the container we browsed, and a track id FROM that browse
      await tt.mediaQueueAdd(offer.udn, offer.album.id, "PLAY_FROM_HERE", offer.next.id);
    } catch {
      showToast({ kind: "error", text: `Couldn't play “${offer.album.title}”` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-resume-card
      className="mt-4 flex items-center gap-4 rounded-xl bg-raised/50 ring-1 ring-edge px-4 py-3 text-left max-w-[520px]"
    >
      <MediaArt src={offer.album.artUrl} kind="album" />
      <div className="min-w-0 flex-1">
        <div className="microlabel text-gold">Pick up where you left off</div>
        <div className="truncate text-[13.5px] text-ink">
          {offer.album.title}
          {offer.album.artist ? <span className="text-dim"> · {offer.album.artist}</span> : null}
        </div>
        <div className="truncate text-[12px] text-dim" data-resume-track={offer.next.title}>
          Track {offer.position} of {offer.total}, {offer.next.title}
          <span className="text-faint"> · {fmtAgo(offer.lastAt)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            dismissedKey = offer.key;
            setOffer(null);
          }}
          className="rounded-full h-8 px-3 text-[12px] text-faint hover:text-ink hover:bg-veil2 transition-colors"
        >
          Not now
        </button>
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
      </div>
    </div>
  );
}
