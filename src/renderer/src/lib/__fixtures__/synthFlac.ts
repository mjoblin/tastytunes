/**
 * A REAL FLAC FILE, MADE IN A TEST (0.14.0, the decoder in pieces): STREAMINFO, then frames of
 * 16-bit VERBATIM subframes (the samples as they are, no prediction), each frame header with its
 * CRC-8 and each frame with its CRC-16, as the format specifies, so any FLAC decoder reads it. A
 * test of the frame splitter needs no binary fixture, and can pick the block size and a short
 * last frame.
 */

const CRC8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

function crc16(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let j = 0; j < 8; j++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** FLAC's UTF-8-like coding of a frame number. */
function utf8(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x800) return [0xc0 | (n >> 6), 0x80 | (n & 0x3f)];
  if (n < 0x10000) return [0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
  return [0xf0 | (n >> 18), 0x80 | ((n >> 12) & 0x3f), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
}

/** A 16-bit FLAC of the given channels (values -1..1), `block` frames to a FLAC frame. */
export function synthFlac(
  chans: readonly Float32Array[],
  sampleRate: number,
  block = 4096,
): Uint8Array {
  const channels = chans.length;
  const total = chans[0].length;
  const out: number[] = [0x66, 0x4c, 0x61, 0x43];
  // STREAMINFO, the last metadata block
  const si: number[] = [];
  si.push(block >> 8, block & 0xff, block >> 8, block & 0xff); // min and max block
  si.push(0, 0, 0, 0, 0, 0); // frame sizes unknown
  si.push((sampleRate >> 12) & 0xff, (sampleRate >> 4) & 0xff);
  si.push(((sampleRate & 0xf) << 4) | ((channels - 1) << 1) | ((16 - 1) >> 4));
  si.push((((16 - 1) & 0xf) << 4) | Math.floor(total / 2 ** 32));
  si.push((total >>> 24) & 0xff, (total >>> 16) & 0xff, (total >>> 8) & 0xff, total & 0xff);
  for (let i = 0; i < 16; i++) si.push(0); // no MD5
  out.push(0x80, 0, 0, 34, ...si);
  for (let f = 0, at = 0; at < total; f++, at += block) {
    const n = Math.min(block, total - at);
    // block size from the header's end (code 7), rate from STREAMINFO (code 0), 16 bit (4)
    const head = [
      0xff,
      0xf8,
      0x70,
      ((channels - 1) << 4) | (4 << 1),
      ...utf8(f),
      (n - 1) >> 8,
      (n - 1) & 0xff,
    ];
    let crc = 0;
    for (const b of head) crc = CRC8[crc ^ b];
    const frame = [...head, crc];
    for (let c = 0; c < channels; c++) {
      frame.push(0x02); // a VERBATIM subframe, no wasted bits
      for (let i = 0; i < n; i++) {
        const v = Math.max(-32768, Math.min(32767, Math.round(chans[c][at + i] * 32767)));
        frame.push((v >> 8) & 0xff, v & 0xff);
      }
    }
    const foot = crc16(frame);
    out.push(...frame, foot >> 8, foot & 0xff);
  }
  return Uint8Array.from(out);
}
