import { measureTrack, type MeasureJob, type MeasureReply, type Measured } from "./measure";

/**
 * The page's side of the analysis worker: one worker for the session, made on
 * first use, jobs answered by id. The channel buffers are TRANSFERRED (the
 * AudioBuffer they came from is never read again). If the worker cannot be
 * made or dies mid-job, the measurement runs on the main thread instead, so
 * nothing is ever lost, only smooth.
 */
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (m: Measured) => void; reject: (e: unknown) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL("../workers/analysis.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch (err) {
    console.warn("[analysis] no worker, measuring on the main thread", err);
    return null;
  }
  worker.onmessage = (e: MessageEvent<MeasureReply>): void => {
    const reply = e.data;
    const job = pending.get(reply.id);
    if (!job) return;
    pending.delete(reply.id);
    if (reply.ok) {
      console.debug(`[analysis] measured in ${Math.round(reply.ms)} ms off the main thread`);
      job.resolve(reply.measured);
    } else job.reject(new Error(reply.error));
  };
  worker.onerror = (ev): void => {
    console.warn("[analysis] worker failed, measuring on the main thread", ev.message);
    const jobs = [...pending.values()];
    pending.clear();
    worker?.terminate();
    worker = null;
    for (const job of jobs) job.reject(new Error("worker failed"));
  };
  return worker;
}

export async function measureOffThread(
  chans: Float32Array[],
  sampleRate: number,
  native: boolean,
  buckets: number,
): Promise<Measured> {
  const w = getWorker();
  if (!w) return measureTrack(chans, sampleRate, native, buckets);
  // the buffers go with the job (transferred), so a worker that dies mid-track cannot be
  // retried on the main thread: that play sees a null analysis and the next play measures
  const id = nextId++;
  const job: MeasureJob = { id, chans, sampleRate, native, buckets };
  return new Promise<Measured>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage(
      job,
      chans.map((c) => c.buffer),
    );
  });
}
