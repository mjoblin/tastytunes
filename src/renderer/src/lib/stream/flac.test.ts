import { describe, expect, it } from "vitest";
import { FlacFrames } from "./flac";
import { synthFlac } from "../__fixtures__/synthFlac";
import { drumTrack } from "../__fixtures__/synthAudio";

// real FLAC files made here (synthFlac): a block size, and a short last frame
const FILES: Record<string, () => Uint8Array> = {
  "44.1 kHz stereo, 4096 a frame": () => {
    const l = drumTrack(120, 3.3, 44100, { hats: true }).samples;
    return synthFlac([l, l.map((v) => v * 0.5)], 44100, 4096);
  },
  "192 kHz mono, 1152 a frame": () => synthFlac([drumTrack(96, 1.1, 192000).samples], 192000, 1152),
};

/** Split a file pushed in pieces of `piece` bytes. */
function split(
  bytes: Uint8Array,
  piece: number,
): ReturnType<FlacFrames["push"]>["frames"] & {
  info?: unknown;
} {
  const f = new FlacFrames();
  const frames = [];
  let info = null;
  for (let at = 0; at < bytes.length; at += piece) {
    const got = f.push(bytes.subarray(at, at + piece));
    info ??= got.info;
    frames.push(...got.frames);
  }
  frames.push(...f.end());
  return Object.assign(frames, { info });
}

describe("a FLAC file in frames", () => {
  for (const [name, make] of Object.entries(FILES))
    it(`splits a ${name} file into frames that rebuild its audio exactly, in any pieces`, () => {
      const bytes = make();
      const whole = split(bytes, bytes.length);
      const info = whole.info as { totalFrames: number; sampleRate: number; maxBlock: number };
      expect(info.sampleRate).toBeGreaterThan(0);
      const audio = Buffer.concat(whole.map((f) => Buffer.from(f.data)));
      // the frames are the file's tail after its metadata, byte for byte
      expect(audio.equals(Buffer.from(bytes.subarray(bytes.length - audio.length)))).toBe(true);
      expect(whole[0].sample).toBe(0);
      for (const piece of [1, 7, 1000, 65536]) {
        const parts = split(bytes, piece);
        expect(parts.map((f) => f.sample)).toEqual(whole.map((f) => f.sample));
        expect(Buffer.concat(parts.map((f) => Buffer.from(f.data))).equals(audio)).toBe(true);
      }
      // each frame starts where the last ended, and the last ends at the track's length
      const last = whole[whole.length - 1];
      expect(last.sample).toBeLessThan(info.totalFrames);
      expect(info.totalFrames - last.sample).toBeLessThanOrEqual(info.maxBlock);
    });
});

// A DAMAGED FILE (0.15.0, the 0.14 re-score: one missing frame made the splitter hold the rest of
// the file and hand the decoder a single frame of it)
describe("a damaged FLAC file", () => {
  const bytes = FILES["44.1 kHz stereo, 4096 a frame"]();
  const whole = split(bytes, bytes.length);
  const meta = bytes.length - whole.reduce((n, f) => n + f.data.length, 0);
  const at = (k: number): number => meta + whole.slice(0, k).reduce((n, f) => n + f.data.length, 0);
  const without = (k: number): Uint8Array =>
    Uint8Array.from([...bytes.subarray(0, at(k)), ...bytes.subarray(at(k + 1))]);
  const samples = (frames: { sample: number }[]): number[] => frames.map((f) => f.sample);

  it("loses only the frames around a missing one, and keeps every other frame as it was", () => {
    const got = split(without(10), 4096);
    const kept = new Set(samples(got));
    expect(kept.has(whole[9].sample) || kept.has(whole[11].sample)).toBe(true);
    for (const k of [0, 5, 8, 12, 20, whole.length - 1])
      expect(kept.has(whole[k].sample)).toBe(true);
    // every frame handed on is one of the file's own frames, byte for byte
    const own = new Map(whole.map((f) => [f.sample, Buffer.from(f.data)]));
    for (const f of got) expect(Buffer.from(f.data).equals(own.get(f.sample)!)).toBe(true);
  });

  it("skips a frame whose header took a flipped bit", () => {
    const flipped = Uint8Array.from(bytes);
    flipped[at(10) + 4] ^= 0x01;
    const got = split(flipped, 1000);
    const kept = new Set(samples(got));
    expect(kept.has(whole[10].sample)).toBe(false);
    for (const k of [0, 8, 12, whole.length - 1]) expect(kept.has(whole[k].sample)).toBe(true);
  });

  it("holds about a frame while it reads, damaged or not", () => {
    const largest = Math.max(...whole.map((f) => f.data.length));
    for (const file of [bytes, without(10)]) {
      const f = new FlacFrames();
      let most = 0;
      for (let p = 0; p < file.length; p += 4096) {
        f.push(file.subarray(p, p + 4096));
        most = Math.max(most, f.held);
      }
      expect(most).toBeLessThan(4 * largest + 8192);
    }
  });

  it("gives up early on a stream with no frames where frames should be", () => {
    const junk = Uint8Array.from([
      ...bytes.subarray(0, at(1)),
      ...new Uint8Array(400_000).fill(0x5a),
    ]);
    expect(() => split(junk, 8192)).toThrow(/damaged/);
  });
});
