import { useCallback, useEffect, useMemo, useRef } from "react";
import { tt } from "@/api";
import { useStore } from "@/store";
import {
  albumDrKey,
  audioAnalysisKey,
  usbServer,
  type MediaNode,
  type MediaServerInfo,
} from "@shared/model";
import { albumQueue, type AlbumQueue } from "@/lib/albumQueue";
import { fromQueueItem } from "@/lib/mediaRef";
import { albumMatchesEntry } from "@/lib/playingEntry";
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
 * is passed over; main records the album's DR and loudness once every track is measured, as it does
 * for an album measured track by track. A new queue stops it, keeping what finished. Nothing for a playlist or
 * a mixed queue, the streamer's own USB drive (out of reach), or with waveforms off. It says so
 * only where the album's DR will land (useAlbumAnalyzing: the album's page and its row in the
 * Albums view), never in the Library's header, nobody having asked for it; each track's DR arrives
 * in the rows that list it, the Queue's among them, as it is measured. Mounted once, in App.
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

let passIds = 0;

async function measureAlbum(plan: AlbumQueue, run: { stopped: boolean }): Promise<void> {
  const servers = await tt.mediaServers().catch(() => []);
  const files: (Found | null)[] = [];
  for (const item of plan.order) {
    const file = await fileOf(item, servers);
    if (run.stopped || file === "usb") return;
    files.push(file);
  }
  const current = await Promise.all(
    files.map((f) => (f ? storedIsCurrent(f.key) : Promise.resolve(true))),
  );
  if (run.stopped || current.every(Boolean)) return;
  // how far it has got, where the album's DR will land (useAlbumAnalyzing): the track being
  // measured counted from 1, of the tracks that can be read
  const of = files.filter((f) => f != null).length;
  let done = files.filter((f, i) => f != null && current[i]).length;
  const playingMd = plan.order[plan.order.length - 1].metadata;
  const id = ++passIds;
  const entry = {
    title: playingMd?.title ?? null,
    artist: playingMd?.artist ?? null,
    album: playingMd?.album ?? null,
    duration: playingMd?.duration ?? null,
  };
  const measured = (): void => {
    done++;
    // each track's DR shows in the rows that list it (the Queue's among them) as it is measured
    useStore.setState((s) => ({
      analysisStatsEpoch: s.analysisStatsEpoch + 1,
      albumPass: run.stopped ? s.albumPass : { id, entry, at: Math.min(done + 1, of), of },
    }));
  };
  useStore.setState({ albumPass: { id, entry, at: Math.min(done + 1, of), of } });
  try {
    // the playing track (the order's last) is measured as it plays, first: its measuring is waited
    // for while it runs, or for a moment before it starts
    const last = files.length - 1;
    const playing = files[last];
    if (playing && !current[last]) {
      const since = Date.now();
      while (
        !run.stopped &&
        !(await storedIsCurrent(playing.key)) &&
        (measuringNow() || Date.now() - since < FIRST_MS)
      )
        await pause(WAIT_MS);
      if (!run.stopped && (await storedIsCurrent(playing.key))) {
        current[last] = true;
        measured();
      }
    }
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (run.stopped) return;
      if (!file || current[i]) continue;
      // measured meanwhile (played, or by Info): counted, not read again
      if (await storedIsCurrent(file.key)) {
        current[i] = true;
        measured();
        continue;
      }
      while (!run.stopped && measuringNow()) await pause(WAIT_MS);
      if (run.stopped || !useStore.getState().settings.waveforms) return;
      if (await analyzeInTurn(file.udn, file.id, file.key)) {
        current[i] = true;
        measured();
      }
    }
  } finally {
    // the pass ends, its place left to the album's DR, unless a newer pass has taken it
    useStore.setState((s) => (s.albumPass?.id === id ? { albumPass: null } : {}));
  }
}

/**
 * How far an album's analysis has got, by an Analyze audio sweep (keyed by the album) or the pass
 * while it plays (told as the playing album is): the track being measured counted from 1 and how
 * many (0 while a sweep is still counting); null when the album isn't being analyzed. What the
 * album's page and its row in the Albums view show where its DR will land.
 */
export function useAlbumAnalyzing(): (node: MediaNode) => { at: number; of: number } | null {
  const sweep = useStore((s) => s.analysisProgress);
  const pass = useStore((s) => s.albumPass);
  return useCallback(
    (node: MediaNode) => {
      if (sweep && sweep.key === albumDrKey(node)) return { at: sweep.at, of: sweep.total };
      if (pass && albumMatchesEntry(node, pass.entry)) return { at: pass.at, of: pass.of };
      return null;
    },
    [sweep, pass],
  );
}
