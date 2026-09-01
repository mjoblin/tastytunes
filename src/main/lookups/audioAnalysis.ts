// EXPERIMENT (0.7 exploration): persisted audio analysis. Two stores on the
// DiskCache chassis (so they join the Settings cache row and its Clear
// button): per-track analyses under CONTENT identity — the trackInfo key
// precedent; server object ids churn on rescans — and the tiny album-DR
// map, written only for albums whose every track measured. Envelope
// quantization keeps a full track cache around 25MB; the 0.7 analysis pass
// may re-home envelopes if the library-scale sweep wants more headroom.
import type { AlbumDr, AudioAnalysis } from "@shared/model";
import { isRecord } from "@shared/guards";
import { DiskCache } from "./diskCache";

const TRACK_CAP = 2000;
const ALBUM_CAP = 2000;

const tracks = new DiskCache<AudioAnalysis>("analysis", TRACK_CAP);
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
  return tracks.get(key) ?? null;
}

export function audioAnalysisPut(key: string, analysis: unknown): void {
  if (isAnalysisShape(analysis)) tracks.set(key, analysis);
}

export function albumDrPut(key: string, entry: unknown): void {
  if (isAlbumDrShape(entry)) albums.set(key, entry);
}

export function albumDrMap(): Record<string, AlbumDr> {
  return Object.fromEntries(albums.snapshot());
}
