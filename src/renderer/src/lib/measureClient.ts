import { measureTrack, type MeasureJob, type MeasureReply, type Measured } from "./measure";
import type { StreamFromWorker, StreamToWorker } from "./stream/protocol";

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
/** A file being measured in pieces: what to do when the worker asks for more or says how far. */
const streaming = new Map<number, (msg: StreamFromWorker) => void>();

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
  worker.onmessage = (e: MessageEvent<MeasureReply | StreamFromWorker>): void => {
    const reply = e.data;
    if ("type" in reply) {
      streaming.get(reply.id)?.(reply);
      return;
    }
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
    streaming.clear();
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

/** How a file measured in pieces ended: measured; not a file that way can measure (the
 *  whole-file way takes it); or failed, and why ("stalled": the server stopped sending). */
export type StreamOutcome =
  | { measured: Measured }
  | { whole: "unsupported" | "unknown-length" | "no-worker" }
  | { failed: string };

/**
 * A FILE MEASURED IN PIECES (0.14.0, analysis with no size limit): the next piece is read
 * (`read`, main's audioStreamRead) only once the worker asks for it, so neither the page nor the
 * worker ever holds the file; `onProgress` hears how far the waveform has got, for a waveform that
 * fills in as the file arrives (his A1); `signal` stops it (his A3: a skipped track's measuring
 * stops with its download).
 */
export function measureStreamOffThread(
  read: () => Promise<Uint8Array | null | { error: string }>,
  buckets: number,
  onProgress?: (p: { ready: number; peak: Float32Array; rms: Float32Array }) => void,
  signal?: AbortSignal,
): Promise<StreamOutcome> {
  const w = getWorker();
  if (!w) return Promise.resolve({ whole: "no-worker" });
  const id = nextId++;
  const post = (msg: StreamToWorker, transfer?: Transferable[]): void =>
    w.postMessage(msg, transfer ?? []);
  return new Promise<StreamOutcome>((resolve) => {
    let over = false;
    const finish = (out: StreamOutcome): void => {
      if (over) return;
      over = true;
      streaming.delete(id);
      pending.delete(id);
      signal?.removeEventListener("abort", stop);
      resolve(out);
    };
    const stop = (): void => {
      post({ type: "cancel", id });
      finish({ failed: "cancelled" });
    };
    signal?.addEventListener("abort", stop, { once: true });
    pending.set(id, {
      resolve: (measured) => finish({ measured }),
      reject: (err) => {
        const why = err instanceof Error ? err.message : String(err);
        finish(
          why === "unsupported" || why === "unknown-length" ? { whole: why } : { failed: why },
        );
      },
    });
    streaming.set(id, (msg) => {
      if (msg.type === "progress") onProgress?.(msg);
      if (msg.type !== "want" || over) return;
      void read().then(
        (got) => {
          if (over) return;
          if (got === null) return post({ type: "end", id });
          if (!(got instanceof Uint8Array)) {
            post({ type: "cancel", id });
            return finish({ failed: got.error });
          }
          // its own buffer, handed over rather than copied
          const bytes =
            got.byteOffset === 0 && got.byteLength === got.buffer.byteLength ? got : got.slice();
          post({ type: "bytes", id, bytes }, [bytes.buffer]);
        },
        () => {
          post({ type: "cancel", id });
          finish({ failed: "failed" });
        },
      );
    });
    if (signal?.aborted) return stop();
    post({ type: "open", id, buckets });
  });
}
