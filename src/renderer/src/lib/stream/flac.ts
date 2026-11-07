/**
 * A FLAC FILE IN FRAMES, AS ITS BYTES ARRIVE (0.14.0, analysis with no size limit). WebCodecs'
 * AudioDecoder decodes FLAC a frame at a time (every rate to 384 kHz, 16 and 24 bit, stereo and
 * 5.1, with today's values: ops decoder-probe), but it wants the frames handed to it one by one,
 * and a FLAC file marks them only by a sync code that may also occur inside one. So: the stream
 * marker and the metadata blocks first (STREAMINFO is the decoder's description and says the
 * track's length), then each frame from its header to the next header whose frame number follows
 * its own, the header's CRC-8 checked, which no chance run of bytes inside a frame passes too.
 * The bytes held are about a frame and a network read, a damaged file included (0.15.0).
 */

/** What STREAMINFO says, and the description AudioDecoder takes. */
export interface FlacInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Frames in the track, 0 when the encoder didn't know. */
  totalFrames: number;
  /** The largest block (frames per frame), for each frame's timestamp. */
  maxBlock: number;
  /** "fLaC" and the STREAMINFO block, marked last: AudioDecoderConfig's description. */
  description: Uint8Array;
}

/** One frame: its bytes (a copy) and the first sample it holds. */
export interface FlacFrame {
  data: Uint8Array;
  sample: number;
}

const CRC8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

interface Header {
  /** The frame number (fixed blocking) or the first sample's number (variable). */
  num: number;
  variable: boolean;
  /** Frames in this frame. */
  size: number;
}

/** A frame header at `p`: undefined when more bytes are needed, null when it is not one. */
function header(b: Uint8Array, p: number, len: number): Header | null | undefined {
  if (p + 16 > len) return undefined;
  if (b[p] !== 0xff || (b[p + 1] & 0xfe) !== 0xf8) return null;
  const variable = (b[p + 1] & 1) === 1;
  const bs = b[p + 2] >> 4;
  const sr = b[p + 2] & 0xf;
  const ch = b[p + 3] >> 4;
  const ss = (b[p + 3] >> 1) & 7;
  if (bs === 0 || sr === 15 || ch > 10 || ss === 3 || b[p + 3] & 1) return null;
  let q = p + 4;
  let v = b[q++];
  // FLAC's UTF-8-like frame number: the lead byte says how many continuation bytes follow
  const lead: Array<[mask: number, value: number, keep: number, more: number]> = [
    [0x80, 0x00, 0x7f, 0],
    [0xe0, 0xc0, 0x1f, 1],
    [0xf0, 0xe0, 0x0f, 2],
    [0xf8, 0xf0, 0x07, 3],
    [0xfc, 0xf8, 0x03, 4],
    [0xfe, 0xfc, 0x01, 5],
    [0xff, 0xfe, 0x00, 6],
  ];
  const form = lead.find(([mask, value]) => (v & mask) === value);
  if (!form) return null;
  v &= form[2];
  const n = form[3];
  let num = v;
  for (let i = 0; i < n; i++) {
    const c = b[q++];
    if ((c & 0xc0) !== 0x80) return null;
    num = num * 64 + (c & 0x3f);
  }
  let size: number;
  if (bs === 1) size = 192;
  else if (bs <= 5) size = 576 << (bs - 2);
  else if (bs === 6) size = b[q++] + 1;
  else if (bs === 7) {
    size = ((b[q] << 8) | b[q + 1]) + 1;
    q += 2;
  } else size = 256 << (bs - 8);
  if (sr === 12) q += 1;
  else if (sr === 13 || sr === 14) q += 2;
  let crc = 0;
  for (let i = p; i < q; i++) crc = CRC8[crc ^ b[i]];
  if (crc !== b[q]) return null;
  return { num, variable, size };
}

/** Splits a FLAC byte stream into its info and frames as the bytes arrive. */
export class FlacFrames {
  private buf = new Uint8Array(1 << 20);
  /** Where the unread bytes begin and end in `buf`. A read offset (0.15.0): the buffer is
   *  compacted only once the offset passes half of it, where every frame used to copy the rest
   *  down (63 times a file's bytes, the 0.14 re-score measured). */
  private base = 0;
  private len = 0;
  private info: FlacInfo | null = null;
  /** Where the current frame starts in the unread bytes, once its header is found. */
  private start = -1;
  private cur: Header | null = null;
  /** Where to look next for the following frame's header. */
  private scan = 0;
  /** The first sample of the current frame. */
  private sample = 0;
  private minFrame = 1;
  /** The most a frame can take: STREAMINFO's largest frame, else an uncompressed block's size. */
  private maxFrame = 1 << 21;

  /** Add bytes; returns the info once known (with the frames it completed). */
  push(bytes: Uint8Array): { info: FlacInfo | null; frames: FlacFrame[] } {
    this.append(bytes);
    const frames: FlacFrame[] = [];
    if (!this.info && !this.readInfo()) return { info: null, frames };
    this.readFrames(frames);
    return { info: this.info, frames };
  }

  /** The stream has ended: the last frame runs to its end, unless it is longer than a frame can
   *  be (a damaged tail, which the decoder would refuse whole). */
  end(): FlacFrame[] {
    const frames: FlacFrame[] = [];
    if (!this.info) return frames;
    this.readFrames(frames);
    const b = this.unread();
    if (
      this.start >= 0 &&
      this.cur &&
      b.length > this.start &&
      b.length - this.start <= this.maxFrame
    )
      frames.push({ data: b.slice(this.start), sample: this.sample });
    this.start = -1;
    this.cur = null;
    return frames;
  }

  /** The bytes held, read or not yet framed: about a frame and a network read. */
  get held(): number {
    return this.len - this.base;
  }

  /** The unread bytes, as a view (no copy). */
  private unread(): Uint8Array {
    return this.buf.subarray(this.base, this.len);
  }

  private append(bytes: Uint8Array): void {
    if (this.len + bytes.length > this.buf.length) {
      this.compact();
      if (this.len + bytes.length > this.buf.length) {
        const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + bytes.length));
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
      }
    }
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** The marker and the metadata blocks; false until they have all arrived. */
  private readInfo(): boolean {
    const b = this.unread();
    if (b.length < 8) return false;
    if (b[0] !== 0x66 || b[1] !== 0x4c || b[2] !== 0x61 || b[3] !== 0x43)
      throw new Error("not a FLAC stream");
    let p = 4;
    let streamInfo: Uint8Array | null = null;
    for (;;) {
      if (b.length < p + 4) return false;
      const last = (b[p] & 0x80) !== 0;
      const type = b[p] & 0x7f;
      const size = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
      if (b.length < p + 4 + size) return false;
      if (type === 0 && size >= 34) streamInfo = b.slice(p + 4, p + 4 + 34);
      p += 4 + size;
      if (last) break;
    }
    if (!streamInfo) throw new Error("no STREAMINFO");
    const s = streamInfo;
    const maxBlock = (s[2] << 8) | s[3];
    this.minFrame = Math.max(1, (s[4] << 16) | (s[5] << 8) | s[6]);
    const sampleRate = (s[10] << 12) | (s[11] << 4) | (s[12] >> 4);
    const channels = ((s[12] >> 1) & 7) + 1;
    const bitsPerSample = (((s[12] & 1) << 4) | (s[13] >> 4)) + 1;
    // an encoder that didn't record its largest frame: a frame stored uncompressed (each channel's
    // samples, a side channel's extra bit, the headers) is as large as one can be
    const maxFrame = (s[7] << 16) | (s[8] << 8) | s[9];
    this.maxFrame =
      maxFrame > 0
        ? maxFrame
        : Math.ceil((maxBlock * channels * (bitsPerSample + 1)) / 8) + 32 + 8 * channels;
    const totalFrames =
      (s[13] & 0xf) * 2 ** 32 + ((s[14] << 24) >>> 0) + ((s[15] << 16) | (s[16] << 8) | s[17]);
    const description = new Uint8Array(42);
    description.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
    description.set(s, 8);
    this.info = { sampleRate, channels, bitsPerSample, totalFrames, maxBlock, description };
    this.drop(p);
    return true;
  }

  private readFrames(out: FlacFrame[]): void {
    let b = this.unread();
    if (this.start < 0) {
      // the first frame starts where the metadata ended
      const h = header(b, 0, b.length);
      if (h === undefined) return;
      if (h === null) throw new Error("no frame after the metadata");
      this.start = 0;
      this.cur = h;
      this.sample = 0;
      this.scan = this.minFrame;
    }
    for (;;) {
      const cur = this.cur;
      if (!cur) return;
      let q = this.scan;
      let found = -1;
      let next: Header | null = null;
      const expected = cur.variable ? cur.num + cur.size : cur.num + 1;
      for (; q + 16 <= b.length; q++) {
        if (b[q] !== 0xff) continue;
        const h = header(b, q, b.length);
        if (h && h.num === expected) {
          found = q;
          next = h;
          break;
        }
      }
      if (found >= 0 && next) {
        out.push({ data: b.slice(this.start, found), sample: this.sample });
        this.sample += cur.size;
        this.cur = next;
        this.drop(found);
        b = this.unread();
        this.start = 0;
        this.scan = this.minFrame;
        continue;
      }
      // A FRAME LONGER THAN ONE CAN BE (0.15.0, the 0.14 re-score): the header that should follow
      // was lost (a missing frame, a flipped bit). The next header that passes its CRC with a
      // later number is taken, and the damaged stretch before it is dropped: the decoder, which
      // refuses a bad frame and the whole decode with it, never sees it, and the bytes held stay
      // near a frame. Normal reading stays as strict as it was: only past a frame's largest size
      // is a later number believed. With none within a few frames' worth, the stream is damaged.
      if (b.length - this.start > this.maxFrame + 16) {
        const r = this.resync(b, cur, expected);
        if (r) {
          this.sample = cur.variable ? r.h.num : r.h.num * cur.size;
          this.cur = r.h;
          this.drop(r.at);
          b = this.unread();
          this.start = 0;
          this.scan = this.minFrame;
          continue;
        }
        if (b.length - this.start > 4 * this.maxFrame + 16)
          throw new Error("a damaged FLAC stream: no frame where one should be");
      }
      // wait for more bytes; at the stream's end, end() takes the rest as the last frame
      this.scan = Math.max(this.minFrame, q);
      return;
    }
  }

  /** The first header after the current frame's start whose number comes after `expected`, within
   *  a plausible reach (a few thousand frames), its CRC checked by header(). */
  private resync(b: Uint8Array, cur: Header, expected: number): { at: number; h: Header } | null {
    const reach = cur.variable ? 4096 * cur.size : 4096;
    for (let q = this.start + this.minFrame; q + 16 <= b.length; q++) {
      if (b[q] !== 0xff) continue;
      const h = header(b, q, b.length);
      if (h && h.variable === cur.variable && h.num > expected && h.num <= expected + reach)
        return { at: q, h };
    }
    return null;
  }

  /** Forget the unread bytes before `p`. */
  private drop(p: number): void {
    this.base += p;
    if (this.scan >= p) this.scan -= p;
    if (this.base > this.buf.length / 2) this.compact();
  }

  /** Move the unread bytes to the buffer's start. */
  private compact(): void {
    if (this.base === 0) return;
    this.buf.copyWithin(0, this.base, this.len);
    this.len -= this.base;
    this.base = 0;
  }
}
