import { measureTrack, MeasureStream, type MeasureJob, type MeasureReply } from "@/lib/measure";
import { FlacFrames } from "@/lib/stream/flac";
import { PcmFrames } from "@/lib/stream/pcm";
import { Tape } from "@/lib/stream/tape";
import {
  type StreamFromWorker,
  type StreamToWorker,
  streamKind,
  withoutId3,
} from "@/lib/stream/protocol";

/**
 * THE ANALYSIS WORKER: one job at a time, in message order. The page decodes
 * (an OfflineAudioContext has no worker form), hands the channel buffers over
 * (transferred, not copied: a four-minute stereo track is ninety megabytes),
 * and gets the measurement back. Any throw comes back as a reply, never as a
 * lost job.
 *
 * AND A FILE IN PIECES (0.14.0, analysis with no size limit): the page hands over the file's
 * bytes as they arrive; FLAC is split into frames and decoded here with WebCodecs, WAV and AIFF
 * read as they are, and every measure reads one tape (lib/stream) that keeps only what a measure
 * may still read. The worker asks for the next piece once it has decoded the last, so neither
 * side ever holds the file; it says how far the waveform has got about four times a second.
 */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<MeasureJob | StreamToWorker>) => void) | null;
  postMessage(reply: MeasureReply | StreamFromWorker, transfer?: Transferable[]): void;
};

interface StreamJob {
  id: number;
  buckets: number;
  t0: number;
  kind: "flac" | "pcm" | null;
  flac: FlacFrames | null;
  pcm: PcmFrames | null;
  decoder: AudioDecoder | null;
  tape: Tape | null;
  m: MeasureStream | null;
  /** The bytes before the format is known (an ID3 tag can run long). */
  head: Uint8Array | null;
  failed: string | null;
  sent: number;
  sampleRate: number;
}

const jobs = new Map<number, StreamJob>();
const PROGRESS_MS = 250;

function fail(job: StreamJob, error: string): void {
  if (job.failed) return;
  job.failed = error;
  try {
    job.decoder?.close();
  } catch {
    // already closed
  }
  jobs.delete(job.id);
  scope.postMessage({ id: job.id, ok: false, error });
}

/** The tape and the measures, once the file's header has said its rate, channels and length. */
function begin(job: StreamJob, sampleRate: number, channels: number, frames: number): void {
  job.sampleRate = sampleRate;
  job.tape = new Tape(channels, frames);
  job.m = new MeasureStream(sampleRate, channels, frames, true, job.buckets);
  scope.postMessage({ id: job.id, type: "info", sampleRate, channels, frames });
}

/** New frames onto the tape, every measure reads them, and the tape lets go of what none needs. */
function feed(job: StreamJob, planes: Float32Array[]): void {
  const { tape, m } = job;
  if (!tape || !m) return;
  tape.push(planes);
  for (const s of m.sinks) s.take(tape);
  tape.drop(Math.min(...m.sinks.map((s) => s.needs)));
  const now = performance.now();
  if (now - job.sent >= PROGRESS_MS) {
    job.sent = now;
    const e = m.envelopes();
    scope.postMessage({
      id: job.id,
      type: "progress",
      ready: e.ready,
      peak: e.peak.slice(),
      rms: e.rms.slice(),
    });
  }
}

function startFlac(job: StreamJob, bytes: Uint8Array): void {
  const { info, frames } = job.flac!.push(bytes);
  if (!info) return;
  if (!job.decoder) {
    // a stream that doesn't say its length can't place the waveform's buckets: the whole-file
    // way measures it
    if (info.totalFrames <= 0) return fail(job, "unknown-length");
    begin(job, info.sampleRate, info.channels, info.totalFrames);
    const planes = (ad: AudioData): Float32Array[] => {
      const out: Float32Array[] = [];
      for (let c = 0; c < ad.numberOfChannels; c++) {
        const p = new Float32Array(ad.numberOfFrames);
        ad.copyTo(p, { planeIndex: c, format: "f32-planar" });
        out.push(p);
      }
      return out;
    };
    job.decoder = new AudioDecoder({
      output: (ad) => {
        try {
          feed(job, planes(ad));
        } finally {
          ad.close();
        }
      },
      error: (e) => fail(job, `decode: ${String(e)}`),
    });
    job.decoder.configure({
      codec: "flac",
      sampleRate: info.sampleRate,
      numberOfChannels: info.channels,
      description: info.description,
    });
  }
  decodeFrames(job, frames);
}

function decodeFrames(job: StreamJob, frames: { data: Uint8Array; sample: number }[]): void {
  const d = job.decoder;
  if (!d) return;
  for (const f of frames)
    d.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp: Math.round((f.sample * 1e6) / job.sampleRate),
        data: f.data,
      }),
    );
}

/** Ask for the next piece once the decoder has caught up. */
function want(job: StreamJob): void {
  const d = job.decoder;
  if (!d || d.decodeQueueSize <= 16) {
    scope.postMessage({ id: job.id, type: "want" });
    return;
  }
  d.addEventListener("dequeue", () => want(job), { once: true });
}

function onBytes(job: StreamJob, bytes: Uint8Array): void {
  if (!job.kind) {
    const head = job.head ? concat(job.head, bytes) : bytes;
    const body = withoutId3(head);
    if (body === undefined) {
      job.head = head;
      return want(job);
    }
    job.head = null;
    job.kind = streamKind(body);
    if (!job.kind) return fail(job, "unsupported");
    if (job.kind === "flac") job.flac = new FlacFrames();
    else job.pcm = new PcmFrames();
    bytes = body;
  }
  if (job.kind === "flac") startFlac(job, bytes);
  else {
    const { info, frames } = job.pcm!.push(bytes);
    if (info && !job.tape) {
      if (info.totalFrames <= 0) return fail(job, "unknown-length");
      begin(job, info.sampleRate, info.channels, info.totalFrames);
    }
    if (frames) feed(job, frames);
  }
  if (!job.failed) want(job);
}

async function onEnd(job: StreamJob): Promise<void> {
  if (job.kind === "flac" && job.decoder) {
    decodeFrames(job, job.flac!.end());
    await job.decoder.flush();
    job.decoder.close();
  }
  if (job.failed) return;
  const { tape, m } = job;
  // a file that ended before its header's length was cut short: nothing is measured from it
  if (!tape || !m || !tape.done) return fail(job, "short");
  jobs.delete(job.id);
  scope.postMessage({
    id: job.id,
    ok: true,
    measured: m.measured(),
    ms: performance.now() - job.t0,
  });
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

scope.onmessage = (e: MessageEvent<MeasureJob | StreamToWorker>): void => {
  const msg = e.data;
  if ("type" in msg) {
    if (msg.type === "open") {
      const job: StreamJob = {
        id: msg.id,
        buckets: msg.buckets,
        t0: performance.now(),
        kind: null,
        flac: null,
        pcm: null,
        decoder: null,
        tape: null,
        m: null,
        head: null,
        failed: null,
        sent: 0,
        sampleRate: 0,
      };
      jobs.set(msg.id, job);
      scope.postMessage({ id: msg.id, type: "want" });
      return;
    }
    const job = jobs.get(msg.id);
    if (!job) return;
    try {
      if (msg.type === "bytes") onBytes(job, msg.bytes);
      else if (msg.type === "end") void onEnd(job).catch((err) => fail(job, String(err)));
      else if (msg.type === "cancel") {
        job.failed = "cancelled";
        jobs.delete(job.id);
        try {
          job.decoder?.close();
        } catch {
          // already closed
        }
      }
    } catch (err) {
      fail(job, String(err));
    }
    return;
  }
  const { id, chans, sampleRate, native, buckets } = msg;
  try {
    const t0 = performance.now();
    const measured = measureTrack(chans, sampleRate, native, buckets);
    scope.postMessage({ id, ok: true, measured, ms: performance.now() - t0 });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: String(err) });
  }
};
