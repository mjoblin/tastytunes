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
