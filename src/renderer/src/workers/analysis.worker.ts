import { measureTrack, type MeasureJob, type MeasureReply } from "@/lib/measure";

/**
 * THE ANALYSIS WORKER: one job at a time, in message order. The page decodes
 * (an OfflineAudioContext has no worker form), hands the channel buffers over
 * (transferred, not copied: a four-minute stereo track is ninety megabytes),
 * and gets the measurement back. Any throw comes back as a reply, never as a
 * lost job.
 */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<MeasureJob>) => void) | null;
  postMessage(reply: MeasureReply): void;
};

scope.onmessage = (e: MessageEvent<MeasureJob>): void => {
  const { id, chans, sampleRate, native, buckets } = e.data;
  try {
    const t0 = performance.now();
    const measured = measureTrack(chans, sampleRate, native, buckets);
    scope.postMessage({ id, ok: true, measured, ms: performance.now() - t0 });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: String(err) });
  }
};
