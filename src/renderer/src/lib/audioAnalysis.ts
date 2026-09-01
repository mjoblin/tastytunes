// EXPERIMENT (0.7 exploration): the Analyze-audio sweep and the album-DR
// map's renderer face. Sweeps are SEQUENTIAL and GLOBALLY SERIALIZED —
// media servers dislike concurrent fetches (the range sweep's Asset
// lesson), and one queue gives the progress affordance a single honest
// position. An album's DR is recorded only when EVERY track measured: the
// TT album value is the mean of all its tracks, so a partial read has no
// honest number (per-track results still persist, so a retry only reads
// what's missing).
import { useEffect } from "react";
import { tt } from "@/api";
import { useStore } from "@/store";
import { albumDrKey, audioAnalysisKey, type AlbumDr, type MediaNode } from "@shared/model";
import { albumDr14 } from "@/lib/dr14";
import { analyzeTrack } from "@/components/media/Waveform";

const pending = new Set<string>();
let queueTail: Promise<unknown> = Promise.resolve();
let waiting = 0;

export interface AnalyzeAlbumResult {
  tracks: number;
  analyzed: number;
  /** The recorded album DR; null when any track failed to read. */
  dr: number | null;
}

export async function analyzeAlbum(
  album: MediaNode,
  serverUdn: string,
  pathTitles: string[],
): Promise<AnalyzeAlbumResult | "busy" | null> {
  const key = albumDrKey(album);
  if (pending.has(key)) return "busy";
  pending.add(key);
  waiting++;
  const run = queueTail.then(() => {
    waiting--;
    return sweep(key, album, serverUdn, pathTitles);
  });
  queueTail = run.catch(() => undefined);
  try {
    return await run;
  } finally {
    pending.delete(key);
  }
}

async function sweep(
  key: string,
  album: MediaNode,
  serverUdn: string,
  pathTitles: string[],
): Promise<AnalyzeAlbumResult | null> {
  const progress = (done: number, total: number): void =>
    useStore.getState().setAnalysisProgress({
      key,
      album: album.title,
      done,
      total,
      queued: waiting,
    });
  // Visible from the first breath — the browse and the first fetch are
  // exactly the silent seconds the affordance exists for (total 0 = "still
  // counting"; the indicator withholds numbers until they're real).
  progress(0, 0);
  try {
    let nodes: MediaNode[];
    try {
      nodes = await tt.mediaBrowse(serverUdn, album.id, [...pathTitles, album.title]);
    } catch {
      return null;
    }
    const tracks: MediaNode[] = nodes.filter((n) => !n.isContainer);
    if (tracks.length === 0) {
      // A box set browses as volumes — descend one level for their tracks.
      for (const c of nodes.filter((n) => n.isContainer)) {
        try {
          const kids = await tt.mediaBrowse(serverUdn, c.id, [...pathTitles, album.title, c.title]);
          tracks.push(...kids.filter((n) => !n.isContainer));
        } catch {
          // an unreadable volume leaves the album incomplete below
        }
      }
    }
    if (tracks.length === 0) return null;
    const drs: number[] = [];
    for (let i = 0; i < tracks.length; i++) {
      progress(i, tracks.length);
      const t = tracks[i];
      const a = await analyzeTrack(t.serverUdn ?? serverUdn, t.id, audioAnalysisKey(t));
      if (a) drs.push(a.dr);
    }
    progress(tracks.length, tracks.length);
    if (drs.length !== tracks.length)
      return { tracks: tracks.length, analyzed: drs.length, dr: null };
    const entry: AlbumDr = { dr: albumDr14(drs), tracks: tracks.length, analyzedAt: Date.now() };
    void tt.albumDrPut(key, entry);
    useStore.getState().setAlbumDrEntry(key, entry);
    return { tracks: tracks.length, analyzed: drs.length, dr: entry.dr };
  } finally {
    // a queued sweep repaints the affordance immediately; otherwise go quiet
    if (waiting === 0) useStore.getState().setAnalysisProgress(null);
  }
}

let loaded = false;

/** The album-DR map, loaded once per session into the store; surfaces read
 *  it live (the sweep updates it in place). The load flag is module scope
 *  and never cleared in a cleanup — the StrictMode seed rule. */
export function useAlbumDr(): Record<string, AlbumDr> {
  const map = useStore((s) => s.albumDr);
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    void tt
      .albumDrMap()
      .then((m) => useStore.getState().setAlbumDr(m))
      .catch(() => {});
  }, []);
  return map;
}
