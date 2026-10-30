import { loggedFetch } from "../netlog";

/**
 * A TRACK'S FILE IN PIECES FOR THE ANALYSIS (0.14.0, analysis with no size limit). The window
 * asks for the file a few megabytes at a time and measures each piece as it comes (lib/stream),
 * so nothing the size of the file is held anywhere: here, the reader and one read's worth.
 *
 * A STALL IS A SILENCE, NOT A TIME LIMIT (his A3 on the design page, settled on the proposal):
 * the whole-file fetch gave a download 120 seconds to finish, which a 30-minute 24/192 file on
 * Wi-Fi can't always do; here a read fails only when no byte has arrived for STALL_MS, however
 * long the file takes, and says so ("stalled"), so the waveform can say the server stopped
 * sending. A stream nobody reads for IDLE_MS closes itself; a skipped track's closes when asked.
 */

const STALL_MS = Number(process.env["TASTYTUNES_ANALYSIS_STALL_MS"]) || 20_000;
const IDLE_MS = 60_000;
/** What one read hands the window at most. */
const READ_BYTES = 2 * 1024 * 1024;

export type StreamRead = Uint8Array | null | { error: "stalled" | "failed" | "closed" };

interface Open {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  abort: AbortController;
  idle: ReturnType<typeof setTimeout>;
  /** A read's leftover past READ_BYTES, handed over first next time. */
  left: Uint8Array | null;
  /** The file has all arrived: what is left is the last of it. */
  done: boolean;
}

const streams = new Map<number, Open>();
let nextId = 1;

/** Open a file for reading in pieces: its id and declared length, or null when the server
 *  wouldn't give it. */
export async function openAudioStream(
  url: string,
): Promise<{ id: number; bytes: number | null } | null> {
  const abort = new AbortController();
  // the answer's headers, at least, within a stall's time
  const headers = setTimeout(() => abort.abort(), STALL_MS);
  try {
    const res = await loggedFetch("media-audio", url, { signal: abort.signal });
    clearTimeout(headers);
    if (!res.ok || !res.body) return null;
    const id = nextId++;
    const declared = Number(res.headers.get("content-length") ?? 0);
    streams.set(id, {
      reader: res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>,
      abort,
      idle: setTimeout(() => closeAudioStream(id), IDLE_MS),
      left: null,
      done: false,
    });
    return { id, bytes: declared > 0 ? declared : null };
  } catch {
    clearTimeout(headers);
    return null;
  }
}

/** The next piece: bytes, null at the end, or why there are none. */
export async function readAudioStream(id: number): Promise<StreamRead> {
  const s = streams.get(id);
  if (!s) return { error: "closed" };
  clearTimeout(s.idle);
  const parts: Uint8Array[] = [];
  let total = 0;
  if (s.left) {
    parts.push(s.left);
    total = s.left.byteLength;
    s.left = null;
  }
  while (total < READ_BYTES && !s.done) {
    let stall: ReturnType<typeof setTimeout> | undefined;
    const silent = new Promise<"stalled">(
      (r) => (stall = setTimeout(() => r("stalled"), STALL_MS)),
    );
    let got: { done: boolean; value?: Uint8Array } | "stalled";
    try {
      got = await Promise.race([s.reader.read(), silent]);
    } catch {
      clearTimeout(stall);
      closeAudioStream(id);
      return { error: "failed" };
    }
    clearTimeout(stall);
    if (got === "stalled") {
      closeAudioStream(id);
      return { error: "stalled" };
    }
    if (got.done || !got.value) {
      s.done = true;
      break;
    }
    parts.push(got.value);
    total += got.value.byteLength;
  }
  if (total === 0) {
    closeAudioStream(id);
    return null;
  }
  const all = parts.length === 1 ? parts[0] : Buffer.concat(parts, total);
  let out = all;
  if (total > READ_BYTES) {
    out = all.subarray(0, READ_BYTES);
    s.left = all.subarray(READ_BYTES);
  }
  s.idle = setTimeout(() => closeAudioStream(id), IDLE_MS);
  return out;
}

/** Stop reading a file: its download ends here. */
export function closeAudioStream(id: number): void {
  const s = streams.get(id);
  if (!s) return;
  streams.delete(id);
  clearTimeout(s.idle);
  s.abort.abort();
  void s.reader.cancel().catch(() => {});
}

/** How many files are being read, for a harness. */
export function openAudioStreams(): number {
  return streams.size;
}
