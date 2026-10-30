/**
 * A WAV OR AIFF FILE IN PIECES (0.14.0, analysis with no size limit): their samples are stored as
 * they are, so they need no decoder, only their header and the arithmetic that turns an integer
 * sample into the float a decoder gives. AIFF is new to analysis with this: Chromium's whole-file
 * decode refuses it (ops decoder-probe), so AIFF files were never measured.
 *
 * THE SAME FLOATS AS CHROMIUM'S DECODE: an integer sample becomes a float the way Chromium's own
 * decode makes it (media's FixedSampleTypeTraits: a negative value over the type's magnitude, a
 * positive one over its maximum, so -1 and 1 both reach full scale), a 24-bit sample first moved
 * into 32 bits as FFmpeg hands it over; so a WAV measured here reads what today's whole-file
 * decode read, and the measures agree with the analyses already stored.
 */

export interface PcmInfo {
  container: "wav" | "aiff";
  sampleRate: number;
  channels: number;
  /** Bits per sample as stored. */
  bits: number;
  float: boolean;
  littleEndian: boolean;
  /** Frames in the track. */
  totalFrames: number;
}

const ascii = (b: Uint8Array, p: number, n = 4): string =>
  String.fromCharCode(...b.subarray(p, p + n));
const u16le = (b: Uint8Array, p: number): number => b[p] | (b[p + 1] << 8);
const u32le = (b: Uint8Array, p: number): number =>
  (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const u16be = (b: Uint8Array, p: number): number => (b[p] << 8) | b[p + 1];
const u32be = (b: Uint8Array, p: number): number =>
  ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

/** An AIFF sample rate: an 80-bit IEEE extended float. */
function extended(b: Uint8Array, p: number): number {
  const exp = ((b[p] & 0x7f) << 8) | b[p + 1];
  let mant = 0;
  for (let i = 0; i < 8; i++) mant = mant * 256 + b[p + 2 + i];
  return mant * 2 ** (exp - 16383 - 63);
}

/** Where the header says the samples start and how many bytes they are, or null until the
 *  header has arrived; throws when the file is no WAV or AIFF this can read. */
function parseHeader(
  b: Uint8Array,
  len: number,
): { info: PcmInfo; data: number; bytes: number } | null {
  if (len < 12) return null;
  const riff = ascii(b, 0);
  if (riff === "RIFF" && ascii(b, 8) === "WAVE") {
    let p = 12;
    let fmt: { tag: number; channels: number; rate: number; bits: number } | null = null;
    for (;;) {
      if (len < p + 8) return null;
      const id = ascii(b, p);
      const size = u32le(b, p + 4);
      if (id === "data") {
        if (!fmt) throw new Error("WAV data before its format");
        const float = fmt.tag === 3;
        if (!float && fmt.tag !== 1) throw new Error(`WAV format ${fmt.tag}`);
        const frameBytes = (fmt.bits / 8) * fmt.channels;
        return {
          info: {
            container: "wav",
            sampleRate: fmt.rate,
            channels: fmt.channels,
            bits: fmt.bits,
            float,
            littleEndian: true,
            totalFrames: Math.floor(size / frameBytes),
          },
          data: p + 8,
          bytes: size,
        };
      }
      if (len < p + 8 + size) return null;
      if (id === "fmt ") {
        let tag = u16le(b, p + 8);
        // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format GUID's first two bytes
        if (tag === 0xfffe && size >= 26) tag = u16le(b, p + 8 + 24);
        fmt = { tag, channels: u16le(b, p + 10), rate: u32le(b, p + 12), bits: u16le(b, p + 22) };
      }
      p += 8 + size + (size & 1);
    }
  }
  if (riff === "FORM" && (ascii(b, 8) === "AIFF" || ascii(b, 8) === "AIFC")) {
    const aifc = ascii(b, 8) === "AIFC";
    let p = 12;
    let comm: {
      channels: number;
      frames: number;
      bits: number;
      rate: number;
      kind: string;
    } | null = null;
    for (;;) {
      if (len < p + 8) return null;
      const id = ascii(b, p);
      const size = u32be(b, p + 4);
      if (id === "SSND") {
        if (len < p + 16) return null;
        if (!comm) throw new Error("AIFF sound before its format");
        const offset = u32be(b, p + 8);
        const kind = comm.kind;
        if (!["NONE", "sowt", "fl32", "FL32", "twos"].includes(kind))
          throw new Error(`AIFC compression ${kind}`);
        const float = kind === "fl32" || kind === "FL32";
        return {
          info: {
            container: "aiff",
            sampleRate: comm.rate,
            channels: comm.channels,
            bits: float ? 32 : comm.bits,
            float,
            littleEndian: kind === "sowt",
            totalFrames: comm.frames,
          },
          data: p + 16 + offset,
          bytes: size - 8 - offset,
        };
      }
      if (len < p + 8 + size) return null;
      if (id === "COMM") {
        comm = {
          channels: u16be(b, p + 8),
          frames: u32be(b, p + 10),
          bits: u16be(b, p + 14),
          rate: extended(b, p + 16),
          kind: aifc && size >= 22 ? ascii(b, p + 26) : "NONE",
        };
      }
      p += 8 + size + (size & 1);
    }
  }
  throw new Error("not a WAV or AIFF file");
}

/** Turns WAV or AIFF bytes into float frames, one array per channel, as they arrive. */
export class PcmFrames {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private header: { info: PcmInfo; data: number; bytes: number } | null = null;
  /** Sample bytes still to come. */
  private left = 0;

  push(bytes: Uint8Array): { info: PcmInfo | null; frames: Float32Array[] | null } {
    this.append(bytes);
    if (!this.header) {
      this.header = parseHeader(this.buf, this.len);
      if (!this.header) return { info: null, frames: null };
      this.left = this.header.bytes;
      this.drop(this.header.data);
    }
    return { info: this.header.info, frames: this.take() };
  }

  private take(): Float32Array[] | null {
    const info = this.header!.info;
    const width = info.bits / 8;
    const frameBytes = width * info.channels;
    const usable = Math.min(this.len, this.left);
    const n = Math.floor(usable / frameBytes);
    if (n === 0) return null;
    const out = Array.from({ length: info.channels }, () => new Float32Array(n));
    const b = this.buf;
    const view = new DataView(b.buffer, b.byteOffset, n * frameBytes);
    const le = info.littleEndian;
    for (let i = 0; i < n; i++)
      for (let c = 0; c < info.channels; c++) {
        const p = i * frameBytes + c * width;
        out[c][i] = sampleAt(b, view, p, info.bits, info.float, le);
      }
    this.left -= n * frameBytes;
    this.drop(n * frameBytes);
    return out;
  }

  private append(bytes: Uint8Array): void {
    if (this.len + bytes.length > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + bytes.length));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  private drop(n: number): void {
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
  }
}

const INV_127 = Math.fround(1 / 127);
const INV_32767 = Math.fround(1 / 32767);

/** One sample as Chromium's decode makes it (the file's comment). */
function sampleAt(
  b: Uint8Array,
  view: DataView,
  p: number,
  bits: number,
  float: boolean,
  le: boolean,
): number {
  if (float) return bits === 64 ? view.getFloat64(p, le) : view.getFloat32(p, le);
  // 8 and 16 bit: Chromium multiplies in single precision by the maximum's reciprocal (checked
  // sample for sample against its decode, 2026-10-29); 24 and 32 bit divide, as below
  if (bits === 8) {
    // WAV's 8-bit is unsigned
    const v = b[p] - 128;
    return v < 0 ? v / 128 : Math.fround(v * INV_127);
  }
  if (bits === 16) {
    const v = view.getInt16(p, le);
    return v < 0 ? v / 32768 : Math.fround(v * INV_32767);
  }
  if (bits === 24) {
    const v = le
      ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) << 8
      : ((b[p] << 16) | (b[p + 1] << 8) | b[p + 2]) << 8;
    return v < 0 ? v / 2147483648 : v / 2147483647;
  }
  const v = view.getInt32(p, le);
  return v < 0 ? v / 2147483648 : v / 2147483647;
}
