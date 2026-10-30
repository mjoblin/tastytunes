/**
 * The page and the analysis worker, for a file measured in pieces (0.14.0): what each side sends
 * the other, and how a file's first bytes say whether it can be measured that way.
 */

export type StreamToWorker =
  | { type: "open"; id: number; buckets: number }
  /** The next piece of the file (transferred). */
  | { type: "bytes"; id: number; bytes: Uint8Array }
  | { type: "end"; id: number }
  | { type: "cancel"; id: number };

export type StreamFromWorker =
  /** Ready for the next piece. */
  | { type: "want"; id: number }
  /** The header has said the track's shape. */
  | { type: "info"; id: number; sampleRate: number; channels: number; frames: number }
  /** The waveform's buckets so far: those before `ready` hold their values. */
  | { type: "progress"; id: number; ready: number; peak: Float32Array; rms: Float32Array };

/** What a file's first bytes say it is, for the in-pieces way: FLAC, WAV or AIFF, else null
 *  (MP3, AAC, Ogg and the rest are measured whole). */
export function streamKind(head: Uint8Array): "flac" | "pcm" | null {
  const tag = String.fromCharCode(...head.subarray(0, 4));
  if (tag === "fLaC") return "flac";
  const form = String.fromCharCode(...head.subarray(8, 12));
  if (tag === "RIFF" && form === "WAVE") return "pcm";
  if (tag === "FORM" && (form === "AIFF" || form === "AIFC")) return "pcm";
  return null;
}

/** The bytes after an ID3v2 tag (some taggers put one in front of a FLAC), the bytes as they are
 *  without one, or undefined while the tag has not all arrived. */
export function withoutId3(head: Uint8Array): Uint8Array | undefined {
  if (head.length < 10) return head.length >= 4 ? (isId3(head) ? undefined : head) : undefined;
  if (!isId3(head)) return head;
  const size =
    ((head[6] & 0x7f) << 21) |
    ((head[7] & 0x7f) << 14) |
    ((head[8] & 0x7f) << 7) |
    (head[9] & 0x7f);
  const footer = head[5] & 0x10 ? 10 : 0;
  const end = 10 + size + footer;
  return head.length >= end + 12 ? head.subarray(end) : undefined;
}

const isId3 = (b: Uint8Array): boolean => b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;
