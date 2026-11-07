import { describe, expect, it } from "vitest";
import { PcmFrames } from "./pcm";

// WAV and AIFF files made here: a header, an unrelated chunk before the samples, and integer
// samples at 16 and 24 bits, read in pieces as a download would hand them over

const ints = [0, 1, -1, 32767, -32768, 12345, -23456, 7];

function wav(bits: 16 | 24, channels: number, samples: number[]): Uint8Array {
  const width = bits / 8;
  const data = new Uint8Array(samples.length * width);
  samples.forEach((s, i) => {
    const v = bits === 24 ? s * 256 : s;
    for (let k = 0; k < width; k++) data[i * width + k] = (v >> (8 * k)) & 0xff;
  });
  const out: number[] = [];
  const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
  const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
  const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
  const fmt = [
    ...u16(1),
    ...u16(channels),
    ...u32(48000),
    ...u32(48000 * channels * width),
    ...u16(channels * width),
    ...u16(bits),
  ];
  const list = str("INFOxx");
  out.push(
    ...str("RIFF"),
    ...u32(4 + 8 + fmt.length + 8 + list.length + 8 + data.length),
    ...str("WAVE"),
  );
  out.push(...str("LIST"), ...u32(list.length), ...list);
  out.push(...str("fmt "), ...u32(fmt.length), ...fmt);
  out.push(...str("data"), ...u32(data.length), ...data);
  return Uint8Array.from(out);
}

function aiff(channels: number, samples: number[]): Uint8Array {
  const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
  const u32 = (n: number): number[] => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
  // 48000 as an 80-bit extended: exponent 16383 + 15, mantissa 48000 << 48
  const rate = [0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0];
  const frames = samples.length / channels;
  const comm = [...u16(channels), ...u32(frames), ...u16(24), ...rate];
  const data: number[] = [];
  for (const s of samples) {
    const v = s * 256;
    data.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  const ssnd = [...u32(0), ...u32(0), ...data];
  const body = [
    ...str("AIFF"),
    ...str("COMM"),
    ...u32(comm.length),
    ...comm,
    ...str("SSND"),
    ...u32(ssnd.length),
    ...ssnd,
  ];
  return Uint8Array.from([...str("FORM"), ...u32(body.length), ...body]);
}

function read(bytes: Uint8Array, piece: number): { info: unknown; chans: number[][] } {
  const p = new PcmFrames();
  let info = null;
  const chans: number[][] = [];
  for (let at = 0; at < bytes.length; at += piece) {
    const got = p.push(bytes.subarray(at, at + piece));
    info ??= got.info;
    got.frames?.forEach((f, c) => (chans[c] = [...(chans[c] ?? []), ...f]));
  }
  return { info, chans };
}

describe("a WAV or AIFF file in pieces", () => {
  it("reads a 16-bit WAV's samples as Chromium's decode does, in any pieces", () => {
    const bytes = wav(16, 2, ints);
    for (const piece of [1, 3, 17, bytes.length]) {
      const { info, chans } = read(bytes, piece);
      expect(info).toMatchObject({
        container: "wav",
        sampleRate: 48000,
        channels: 2,
        bits: 16,
        totalFrames: 4,
      });
      // a negative sample over 32768, a positive one in single precision over 32767
      const want = (s: number): number =>
        s < 0 ? s / 32768 : Math.fround(s * Math.fround(1 / 32767));
      expect(chans[0]).toEqual(ints.filter((_, i) => i % 2 === 0).map((s) => Math.fround(want(s))));
      expect(chans[1]).toEqual(ints.filter((_, i) => i % 2 === 1).map((s) => Math.fround(want(s))));
    }
  });

  it("reads a 24-bit AIFF to the same floats as the same samples in a 24-bit WAV", () => {
    const fromWav = read(wav(24, 2, ints), 5);
    const fromAiff = read(aiff(2, ints), 5);
    expect(fromAiff.info).toMatchObject({
      container: "aiff",
      sampleRate: 48000,
      channels: 2,
      bits: 24,
      totalFrames: 4,
    });
    expect(fromAiff.chans).toEqual(fromWav.chans);
    // the 24-bit -32768 * 256 sample, moved into 32 bits, is full scale
    expect(fromWav.chans[0][2]).toBe(-1);
  });

  it("refuses what is neither", () => {
    expect(() =>
      new PcmFrames().push(new TextEncoder().encode("fLaC and then some bytes")),
    ).toThrow();
  });
});
