// EXPERIMENT (0.7 exploration): persisted audio analysis. Two stores that
// join the Settings cache row and its Clear button: per-track analyses under
// CONTENT identity — the trackInfo key precedent; server object ids churn on
// rescans — and the tiny album-DR map, written only for albums whose every
// track measured. The track analyses keep ONE FILE PER ENTRY since 0.11.0
// (EntryStore): their single file had reached 14 MB, parsed whole on the
// first read and rewritten whole two seconds after every read; the many-key
// reads (the rows' DR and loudness) answer from the store's index alone.
import { join } from "node:path";
import { app } from "electron";
import type { AlbumDr, AudioAnalysis, KnownStats, MediaIndexPools } from "@shared/model";
import { currentFeatures, FEATURES_VERSION, keyName, tempoBpm } from "@shared/model";
import { isRecord } from "@shared/guards";
import { DiskCache, registerCache } from "./diskCache";
import { EntryStore } from "./entryStore";
import { albumDrsFromTracks } from "./albumDrFromTracks";

const TRACK_CAP = 2000;
const ALBUM_CAP = 2000;

// What the rows read without opening an entry: its DR and loudness, and since 0.12.0 its tempo
// and key as Info says them (above their floors, and only from the current version's features,
// shared/model). `sv` is the features version the summary was made under: a summary made
// before tempo and key joined has none, and one made under an older version may hold a tempo
// since corrected, so refreshAnalysisSummaries remakes both.
interface Summary {
  dr: number;
  lufs: number | null;
  bpm?: number | null;
  key?: string | null;
  sv?: number;
}
const tracks = new EntryStore<AudioAnalysis, Summary>({
  dir: () => join(app.getPath("userData"), "cache"),
  name: "analysis",
  cap: TRACK_CAP,
  summarize: (a) => {
    const f = currentFeatures(a.features);
    return {
      dr: a.dr,
      lufs: a.lufs ?? null,
      bpm: tempoBpm(f?.beats),
      key: keyName(f?.key),
      sv: FEATURES_VERSION,
    };
  },
  // the single-file cache before 0.11.0, read once into entry files and left in place
  legacyFile: "analysis.json",
  isValue: (v): v is AudioAnalysis => isAnalysisShape(v),
});
registerCache(tracks);
const albums = new DiskCache<AlbumDr>("albumdr", ALBUM_CAP);

// The IPC layer hands these unknowns from our own renderer; the guards keep
// the cache from swallowing a malformed shape (S38 — a seam gets a guard).
function isAnalysisShape(v: unknown): v is AudioAnalysis {
  return isRecord(v) && typeof v.dr === "number" && Array.isArray(v.peakQ) && Array.isArray(v.rmsQ);
}

function isAlbumDrShape(v: unknown): v is AlbumDr {
  return (
    isRecord(v) &&
    typeof v.dr === "number" &&
    typeof v.tracks === "number" &&
    typeof v.analyzedAt === "number"
  );
}

export function audioAnalysisGet(key: string): AudioAnalysis | null {
  return tracks.get(key);
}

export function audioAnalysisPut(key: string, analysis: unknown): void {
  if (isAnalysisShape(analysis)) tracks.set(key, analysis);
}

/** The known DR per key — cache-only, for the album modal's coverage line. */
export function audioDrMany(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    const a = tracks.summary(k);
    if (a && a.dr > 0) out[k] = a.dr;
  }
  return out;
}

/** Cache-only DR, loudness, tempo and key per key (the rows' cells, the Tracks view's sorts and
 *  facets, the DR tooltip). */
export function audioStatsMany(keys: string[]): Record<string, KnownStats> {
  const out: Record<string, KnownStats> = {};
  for (const k of keys) {
    const a = tracks.summary(k);
    if (!a) continue;
    const dr = a.dr > 0 ? a.dr : null;
    const lufs = a.lufs;
    const bpm = a.bpm ?? null;
    const key = a.key ?? null;
    if (dr != null || lufs != null || bpm != null || key != null) out[k] = { dr, lufs, bpm, key };
  }
  return out;
}

/** Remakes the summaries made before tempo and key were in them, or under another features
 *  version, in the background; resolves to how many changed (the rows then read again: main's
 *  analysisStats push). */
export function refreshAnalysisSummaries(): Promise<number> {
  return tracks.refreshSummaries((s) => s.sv !== FEATURES_VERSION);
}

export function albumDrPut(key: string, entry: unknown): void {
  if (isAlbumDrShape(entry)) albums.set(key, entry);
}

/** Albums whose every track is now measured get their DR recorded (albumDrsFromTracks): after
 *  a track's analysis is stored (its album only), and before the map is handed out (all). */
export function recordAlbumDrsFromTracks(
  pools: readonly MediaIndexPools[],
  onlyTrackKey?: string,
): { key: string; entry: AlbumDr }[] {
  const found = albumDrsFromTracks(
    pools,
    {
      recorded: new Map(albums.snapshot()),
      dr: (k) => tracks.peekSummary(k)?.dr,
      hist: (k) => tracks.get(k)?.loudHist,
    },
    onlyTrackKey,
  );
  for (const { key, entry } of found) albums.set(key, entry);
  return found;
}

export function albumDrMap(): Record<string, AlbumDr> {
  return Object.fromEntries(albums.snapshot());
}
