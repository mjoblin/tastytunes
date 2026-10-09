import { IPC } from "@shared/ipc";
import { broadcastSettings } from "../app/broadcast";
import { streamerHost } from "../app/runtime";
import { getSettings, updateSettings } from "../data/persist";
import {
  albumDrMap,
  albumDrPut,
  audioAnalysisGet,
  audioAnalysisPut,
  audioDrMany,
  audioStatsMany,
} from "../lookups/audioAnalysis";
import { audioResUrl } from "../media/upnpBrowser";
import { loggedFetch } from "../netlog";
import { handle } from "../app/guard";

/** Audio analysis: a track's bytes for the decode, and the stored analyses and album DR. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */
export function registerAudioIpc(): void {
  // EXPERIMENT (0.7 exploration): fetch one track's audio bytes for the
  // renderer's waveform decode. Read-only ranged-capable GET against the
  // LOCAL media server; capped so a mistake can't balloon over IPC. 256MB
  // covers ~20 minutes of 24/44.1 or ~7 of 24/96 (the experiment's 64MB
  // silently dropped a 71MB five-minute track, 2026-09-01); the streaming
  // decoder retires the cap outright (ROADMAP).
  handle(IPC.expTrackAudio, async (_e, serverUdn: string, objectId: string) => {
    const host = streamerHost();
    if (!host || typeof serverUdn !== "string" || typeof objectId !== "string") return null;
    const url = await audioResUrl(host, serverUdn, objectId);
    if (!url) return null;
    try {
      const res = await loggedFetch("media-audio", url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > 256 * 1024 * 1024) return null;
      return buf;
    } catch {
      return null;
    }
  });
  // EXPERIMENT (0.7 exploration): the persisted analysis stores — content-
  // keyed track analyses and the album-DR map (lookups/audioAnalysis holds
  // the shape guards; the store is a cache, never truth).
  // The first analysis SERVED — stored or read back — is the evidence the
  // playback bar keys its taller geometry on (settings.waveformSeen); set
  // once, here, at the one seam every analysis crosses.
  const noteWaveformSeen = (): void => {
    if (getSettings().waveformSeen) return;
    broadcastSettings(updateSettings({ waveformSeen: true }));
  };
  handle(IPC.audioAnalysisGet, (_e, key: unknown) => {
    const hit = typeof key === "string" ? audioAnalysisGet(key) : null;
    if (hit) noteWaveformSeen();
    return hit;
  });
  handle(IPC.audioAnalysisPut, (_e, key: unknown, analysis: unknown) => {
    if (typeof key !== "string") return;
    audioAnalysisPut(key, analysis);
    noteWaveformSeen();
  });
  handle(IPC.albumDrMap, () => albumDrMap());
  handle(IPC.audioDrMany, (_e, keys: unknown) =>
    Array.isArray(keys) ? audioDrMany(keys.filter((k): k is string => typeof k === "string")) : {},
  );
  handle(IPC.audioStatsMany, (_e, keys: unknown) =>
    Array.isArray(keys)
      ? audioStatsMany(keys.filter((k): k is string => typeof k === "string"))
      : {},
  );
  handle(IPC.albumDrPut, (_e, key: unknown, entry: unknown) => {
    if (typeof key === "string") albumDrPut(key, entry);
  });
}
