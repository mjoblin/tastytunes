import { IPC } from "@shared/ipc";
import { broadcastAlbumDrs, broadcastAnalysisStats, broadcastSettings } from "../app/broadcast";
import { streamerHost } from "../app/runtime";
import { getSettings, updateSettings } from "../data/persist";
import {
  albumDrMap,
  albumDrPut,
  audioAnalysisGet,
  audioAnalysisPut,
  audioDrMany,
  audioStatsMany,
  refreshAnalysisSummaries,
  recordAlbumDrsFromTracks,
} from "../lookups/audioAnalysis";
import { pools } from "../media/mediaIndex";
import { audioResUrl } from "../media/upnpBrowser";
import { loggedFetch } from "../netlog";
import { handle } from "../app/guard";

/**
 * THE LARGEST FILE THE ANALYSIS READS (0.12.0, from Malcolm's email: 24/192 FLACs past about
 * 5:40 had no waveform). The renderer decodes the whole file at its native rate, so a file costs
 * its own size again as samples (a 6-minute 24/192 track is about 525 MB of them); the cap is a
 * memory bound. It was 256 MiB, with the renderer holding three copies of the file and main two.
 * With those copies gone, 512 MiB (about 11 minutes of 24/192 music, 22 of 24/96) costs about
 * what 256 MiB did, measured 2026-10-17 on 24/192 FLACs: a 507 MB file raised the window's
 * process by 2.2 GB and main's by 0.6 GB, where the old code took 2.0 GB and 0.7 GB for a 249 MB
 * one (journal/0.12.0.md). The streaming decoder (0.14.0) retires the cap.
 * TASTYTUNES_ANALYSIS_MAX_BYTES lets a harness set it small.
 */
const ANALYSIS_MAX_BYTES =
  Number(process.env["TASTYTUNES_ANALYSIS_MAX_BYTES"]) || 512 * 1024 * 1024;

// whether this session has asked for the summaries made before tempo and key to be remade
let summariesRefreshed = false;

/** Audio analysis: a track's bytes for the decode, and the stored analyses and album DR. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */
export function registerAudioIpc(): void {
  // One track's audio bytes for the renderer's analysis decode: a read-only GET against the
  // LOCAL media server, capped (ANALYSIS_MAX_BYTES), refused by its length before a byte of it
  // is downloaded and by a running count when the server sends none, so a file past the cap
  // costs nothing and the renderer can say why it has no waveform.
  handle(IPC.expTrackAudio, async (_e, serverUdn: string, objectId: string) => {
    const host = streamerHost();
    if (!host || typeof serverUdn !== "string" || typeof objectId !== "string") return null;
    const url = await audioResUrl(host, serverUdn, objectId);
    if (!url) return null;
    try {
      const res = await loggedFetch("media-audio", url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) return null;
      const declared = Number(res.headers.get("content-length") ?? 0);
      const tooLarge = (bytes: number) => ({ tooLarge: { bytes, maxBytes: ANALYSIS_MAX_BYTES } });
      if (declared > ANALYSIS_MAX_BYTES) {
        void res.body.cancel();
        return tooLarge(declared);
      }
      // one buffer the size the server declared (no second copy on the way to the renderer);
      // chunks gathered only when it declared none, or more arrived than it said
      const reader = res.body.getReader();
      let out: Buffer | null = declared > 0 ? Buffer.allocUnsafe(declared) : null;
      let chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        // a fetch body's chunks are bytes; node's typings leave the stream's element untyped
        const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
        if (done || !value) break;
        if (total + value.byteLength > ANALYSIS_MAX_BYTES) {
          await reader.cancel();
          return tooLarge(total + value.byteLength);
        }
        if (out && total + value.byteLength > out.byteLength) {
          chunks = [out.subarray(0, total)];
          out = null;
        }
        if (out) out.set(value, total);
        else chunks.push(value);
        total += value.byteLength;
      }
      return out ? out.subarray(0, total) : Buffer.concat(chunks, total);
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
    // the album this track completes, if it does, gets its DR (as the sweep would give it),
    // and every window hears it
    broadcastAlbumDrs(recordAlbumDrsFromTracks(pools(), key));
  });
  // albums completed track by track before 2026-10-12 (or while the app was elsewhere)
  handle(IPC.albumDrMap, () => {
    broadcastAlbumDrs(recordAlbumDrsFromTracks(pools()));
    return albumDrMap();
  });
  handle(IPC.audioDrMany, (_e, keys: unknown) =>
    Array.isArray(keys) ? audioDrMany(keys.filter((k): k is string => typeof k === "string")) : {},
  );
  handle(IPC.audioStatsMany, (_e, keys: unknown) => {
    // the first read of a session remakes, in the background, the summaries made before tempo
    // and key were in them, and the rows read again once it has (0.12.0)
    if (!summariesRefreshed) {
      summariesRefreshed = true;
      void refreshAnalysisSummaries().then((n) => {
        if (n > 0) broadcastAnalysisStats();
      });
    }
    return Array.isArray(keys)
      ? audioStatsMany(keys.filter((k): k is string => typeof k === "string"))
      : {};
  });
  handle(IPC.albumDrPut, (_e, key: unknown, entry: unknown) => {
    if (typeof key === "string") albumDrPut(key, entry);
  });
}
