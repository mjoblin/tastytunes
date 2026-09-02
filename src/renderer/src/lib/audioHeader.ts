/**
 * The file's OWN sample rate, read from its header — so the analysis decode
 * can run at native rate and never resample (decodeAudioData resamples to
 * its context's rate; at the device's 48k a 44.1k FLAC came back with a
 * +0.5 dB "peak" and a DR computed on interpolated samples, 2026-09-01).
 * Pure and dependency-free; validated against ffprobe in dev/validate-dr.mjs.
 * Returns null for anything it doesn't recognise (the caller then decodes at
 * a default rate and WITHHOLDS the DR — a citation is never approximated).
 */
export function sniffSampleRate(u8: Uint8Array): number | null {
  return sniffFlac(u8) ?? sniffWav(u8) ?? sniffMp3(u8);
}

const ascii = (u8: Uint8Array, at: number, n: number): string =>
  String.fromCharCode(...u8.subarray(at, at + n));

/** "fLaC" then the mandatory first STREAMINFO block: 20 bits of rate at
 *  byte 18 (after min/max block size and min/max frame size). */
function sniffFlac(u8: Uint8Array): number | null {
  if (u8.length < 22 || ascii(u8, 0, 4) !== "fLaC") return null;
  if ((u8[4] & 0x7f) !== 0) return null; // STREAMINFO is required first
  const rate = (u8[18] << 12) | (u8[19] << 4) | (u8[20] >> 4);
  return rate > 0 ? rate : null;
}

/** RIFF/WAVE: walk the chunks to "fmt " and read its little-endian rate. */
function sniffWav(u8: Uint8Array): number | null {
  if (u8.length < 28 || ascii(u8, 0, 4) !== "RIFF" || ascii(u8, 8, 4) !== "WAVE") return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let at = 12;
  while (at + 8 <= u8.length) {
    const id = ascii(u8, at, 4);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 12 <= u8.length) {
      const rate = view.getUint32(at + 12, true);
      return rate > 0 ? rate : null;
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

const MP3_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

/** Skip an ID3v2 tag if present, then the first frame sync carries the
 *  MPEG version and a rate index. */
function sniffMp3(u8: Uint8Array): number | null {
  let at = 0;
  if (u8.length > 10 && ascii(u8, 0, 3) === "ID3") {
    const size =
      ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
    at = 10 + size;
  }
  const limit = Math.min(u8.length - 4, at + 65536);
  for (let i = at; i < limit; i++) {
    if (u8[i] !== 0xff || (u8[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (u8[i + 1] >> 3) & 0x03;
    const layer = (u8[i + 1] >> 1) & 0x03;
    const rateIndex = (u8[i + 2] >> 2) & 0x03;
    if (version === 1 || layer === 0 || rateIndex === 3) continue; // reserved values
    const rate = MP3_RATES[version]?.[rateIndex];
    if (rate) return rate;
  }
  return null;
}
