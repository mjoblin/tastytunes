// EXPERIMENT (0.7 exploration): the Analyze-audio sweep and the album-DR
// map's renderer face. The sweep is SEQUENTIAL by design — media servers
// dislike concurrent fetches (the range sweep's Asset lesson) — and an
// album's DR is recorded only when EVERY track measured: the TT album
// value is the mean of all its tracks, so a partial read has no honest
// number (per-track results still persist, so a retry only reads what's
// missing).
import { useEffect } from "react";
import { tt } from "@/api";
import { useStore } from "@/store";
import { albumDrKey, audioAnalysisKey, type AlbumDr, type MediaNode } from "@shared/model";
import { albumDr14 } from "@/lib/dr14";
import { analyzeTrack } from "@/components/media/Waveform";

const inFlight = new Set<string>();

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
  if (inFlight.has(key)) return "busy";
  inFlight.add(key);
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
    for (const t of tracks) {
      const a = await analyzeTrack(t.serverUdn ?? serverUdn, t.id, audioAnalysisKey(t));
      if (a) drs.push(a.dr);
    }
    if (drs.length !== tracks.length)
      return { tracks: tracks.length, analyzed: drs.length, dr: null };
    const entry: AlbumDr = { dr: albumDr14(drs), tracks: tracks.length, analyzedAt: Date.now() };
    void tt.albumDrPut(key, entry);
    useStore.getState().setAlbumDrEntry(key, entry);
    return { tracks: tracks.length, analyzed: drs.length, dr: entry.dr };
  } finally {
    inFlight.delete(key);
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
