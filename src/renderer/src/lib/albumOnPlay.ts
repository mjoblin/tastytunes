import { useEffect, useMemo, useRef } from "react";
import { tt } from "@/api";
import { useStore } from "@/store";
import { audioAnalysisKey, usbServer, type MediaServerInfo } from "@shared/model";
import { albumQueue, type AlbumQueue } from "@/lib/albumQueue";
import { fromQueueItem } from "@/lib/mediaRef";
import { lookupRefInfo } from "@/lib/mediaInfo";
import { analyzeInTurn } from "@/lib/audioAnalysis";
import { measuringNow, storedIsCurrent } from "@/components/media/waveformAnalysis";

/**
 * THE ALBUM BEING PLAYED, MEASURED WHILE IT PLAYS (0.16.0). A track is measured as it plays, so
 * an album played through gets its DR at its last track and one skipped through never does. When
 * the queue is one album (lib/albumQueue), its other tracks are measured behind the playing one:
 * once the playing track's own measuring is done, and behind whatever else is being measured, one
 * file at a time on the sweeps' queue, from the next track round to the playing one, each read at
 * the unhurried pace beside the streamer's own read of the same server. A track already measured
 * is passed over;
 * main records the album's DR and loudness once every track is measured, as it does for an album
 * measured track by track. A new queue stops it, keeping what finished. Nothing for a playlist or
 * a mixed queue, the streamer's own USB drive (out of reach), or with waveforms off; no progress
 * is shown, nobody having asked for it, but each track's DR arrives in the rows that list it, the
 * Queue's among them, as it is measured. Mounted once, in App.
 */
export function useAnalyzeAlbumOnPlay(): void {
  const on = useStore((s) => s.settings.waveforms);
  const queue = useStore((s) => s.queue);
  const playState = useStore((s) => s.playState);
  const plan = useMemo(() => (on ? albumQueue(queue, playState) : null), [on, queue, playState]);
  const planRef = useRef(plan);
  planRef.current = plan;
  const sig = plan?.sig ?? null;
  useEffect(() => {
    const p = planRef.current;
    if (!sig || !p) return;
    const run = { stopped: false };
    void measureAlbum(p, run);
    return () => {
      run.stopped = true;
    };
  }, [sig]);
}

/** How often a waiting turn looks again. */
const WAIT_MS = 1500;
/** How long the playing track's own measuring is given to begin before the album goes on
 *  without it (a file that can't be read, a window that draws no waveform). */
const FIRST_MS = 10_000;

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Found = { udn: string; id: string; key: string };

/** A queue entry's file in the library: where to read it and its analysis key; null when it
 *  isn't in an index, "usb" when it sits on the streamer's own drive. */
async function fileOf(
  item: AlbumQueue["order"][number],
  servers: readonly MediaServerInfo[],
): Promise<Found | "usb" | null> {
  const ref = fromQueueItem(item);
  if (!ref) return null;
  const found = await lookupRefInfo(ref);
  const node = found.node;
  const udn = node.serverUdn ?? found.serverUdn ?? null;
  if (!udn || !node.id || node.isContainer) return null;
  const server = servers.find((s) => s.udn === udn);
  if (server && usbServer(server)) return "usb";
  return { udn, id: node.id, key: audioAnalysisKey(node) };
}

async function measureAlbum(plan: AlbumQueue, run: { stopped: boolean }): Promise<void> {
  const servers = await tt.mediaServers().catch(() => []);
  // the playing track (the order's last) is measured as it plays, first: its measuring is waited
  // for while it runs, or for a moment before it starts
  const playing = await fileOf(plan.order[plan.order.length - 1], servers);
  if (run.stopped || playing === "usb") return;
  if (playing) {
    const since = Date.now();
    while (
      !run.stopped &&
      !(await storedIsCurrent(playing.key)) &&
      (measuringNow() || Date.now() - since < FIRST_MS)
    )
      await pause(WAIT_MS);
  }
  for (const item of plan.order) {
    if (run.stopped) return;
    const file = await fileOf(item, servers);
    if (run.stopped || file === "usb") return;
    if (!file || (await storedIsCurrent(file.key))) continue;
    while (!run.stopped && measuringNow()) await pause(WAIT_MS);
    if (run.stopped || !useStore.getState().settings.waveforms) return;
    // each track's DR shows in the rows that list it (the Queue's among them) as it is measured
    if (await analyzeInTurn(file.udn, file.id, file.key))
      useStore.setState((s) => ({ analysisStatsEpoch: s.analysisStatsEpoch + 1 }));
  }
}
