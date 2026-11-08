/**
 * THE TAPE (0.14.0, analysis with no size limit): the decoded audio a track's measures read, held
 * a little at a time. A file arrives in pieces (a FLAC frame, a run of WAV samples); each piece is
 * appended here, every measure (a Sink) reads what it can, and what no measure can still ask for
 * is dropped, so memory stays flat whatever the track's length: a 12-minute 24/192 file decoded
 * this way peaks near 270 MB where the whole file took 3.9 GB (measured).
 *
 * It holds each channel as it came (Float32, the decoder's own values) and THE MIX the windowed
 * measures read: the channels summed in channel order, at full precision (Float64), the sum each
 * of them made inline before (strip, onsets, chroma, timbre: `v += c[idx]` over the channels, then
 * `v * inv`), so a window read from here is the same numbers, bit for bit. Indices are the
 * track's own (absolute frames); a read before `base` or at or after `end` is outside what is
 * held, and a measure past the track's last frame reads the zero padding it always read.
 */
export class Tape {
  readonly channels: number;
  /** The track's length in frames, known from the file's header before any audio. */
  readonly total: number;
  /** The first frame held. */
  base = 0;
  /** One past the last frame held. */
  end = 0;
  /** Each channel's frames from `base`. */
  chan: Float32Array[];
  /** The channels' sum from `base`. */
  mix: Float64Array;

  constructor(channels: number, total: number, capacity = 1 << 16) {
    this.channels = channels;
    this.total = total;
    this.chan = Array.from({ length: channels }, () => new Float32Array(capacity));
    this.mix = new Float64Array(capacity);
  }

  /** Whether every frame of the track has arrived. */
  get done(): boolean {
    return this.end >= this.total;
  }

  /** Append the next frames, one array per channel, equal lengths. */
  push(frames: readonly Float32Array[]): void {
    const n = Math.min(frames[0]?.length ?? 0, this.total - this.end);
    if (n <= 0) return;
    this.room(this.end - this.base + n);
    const at = this.end - this.base;
    for (let c = 0; c < this.channels; c++) this.chan[c].set(frames[c].subarray(0, n), at);
    const mix = this.mix;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < this.channels; c++) v += frames[c][i];
      mix[at + i] = v;
    }
    this.end += n;
  }

  /** Drop the frames before `keep`: nothing will read them again. */
  drop(keep: number): void {
    const to = Math.min(Math.max(keep, this.base), this.end);
    const n = to - this.base;
    if (n <= 0) return;
    const held = this.end - to;
    for (const c of this.chan) c.copyWithin(0, n, n + held);
    this.mix.copyWithin(0, n, n + held);
    this.base = to;
  }

  /** The mix at a frame, 0 outside the track (the windows' padding); the frame must be held
   *  or outside the track. */
  mixAt(i: number): number {
    return i >= 0 && i < this.total ? this.mix[i - this.base] : 0;
  }

  private room(need: number): void {
    if (need <= this.mix.length) return;
    let size = this.mix.length;
    while (size < need) size *= 2;
    const held = this.end - this.base;
    this.chan = this.chan.map((c) => {
      const next = new Float32Array(size);
      next.set(c.subarray(0, held));
      return next;
    });
    const mix = new Float64Array(size);
    mix.set(this.mix.subarray(0, held));
    this.mix = mix;
  }
}

/** A measure that reads the tape as it fills. */
export interface Sink {
  /** Read every frame the tape now holds that this measure can use. */
  take(tape: Tape): void;
  /** The first frame this measure may still read: the tape drops what is before every sink's. */
  readonly needs: number;
}

/** Feed a whole track to measures a piece at a time, as a file arriving would: the one way the
 *  whole-track functions (computeStrip and the rest) and a streamed file are measured. */
export function feed(
  sinks: readonly Sink[],
  chans: readonly Float32Array[],
  piece = 1 << 15,
): void {
  const total = chans[0]?.length ?? 0;
  const tape = new Tape(chans.length, total);
  for (let at = 0; ; at += piece) {
    tape.push(chans.map((c) => c.subarray(at, Math.min(total, at + piece))));
    for (const s of sinks) s.take(tape);
    tape.drop(Math.min(...sinks.map((s) => s.needs)));
    if (at + piece >= total) break;
  }
}

/** One sink, fed the whole track. */
export function fed<S extends Sink>(sink: S, chans: readonly Float32Array[], piece?: number): S {
  feed([sink], chans, piece);
  return sink;
}
