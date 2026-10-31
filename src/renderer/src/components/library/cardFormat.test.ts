/**
 * An album card's format line: the format most tracks share with the lamp's quality for it, the
 * tip in words, surround only when an album has it, and "mixed formats" naming each.
 */
import { describe, expect, it } from "vitest";
import type { MediaFormat } from "@shared/model";
import { cardFormat } from "./cardFormat";

const tracks = (...formats: (MediaFormat | undefined)[]): { format?: MediaFormat }[] =>
  formats.map((format) => ({ format }));
const cd: MediaFormat = { codec: "FLAC", bits: 16, rate: 44100 };
const hires: MediaFormat = { codec: "FLAC", bits: 24, rate: 96000 };
const mp3: MediaFormat = { codec: "MP3", kbps: 320, rate: 44100 };

describe("cardFormat", () => {
  it("says the shared format, tight around the dot, with the lamp's quality", () => {
    expect(cardFormat(tracks(hires, hires))).toEqual({
      quality: "hires",
      label: "FLAC · 24/96",
      tip: "FLAC, 24-bit, 96 kHz, hi-res",
    });
    expect(cardFormat(tracks(cd, cd, hires))).toMatchObject({
      quality: "lossless",
      tip: "FLAC, 16-bit, 44.1 kHz",
    });
    expect(cardFormat(tracks(mp3))).toMatchObject({ quality: "lossy", tip: "MP3, 320 kbps" });
  });
  it("adds surround only when the album has it", () => {
    const surround = { ...hires, channels: 6 };
    expect(cardFormat(tracks(surround))).toMatchObject({
      label: "FLAC · 24/96 · 5.1",
      tip: "FLAC, 24-bit, 96 kHz, 6 channels, hi-res",
    });
    expect(cardFormat(tracks({ ...cd, channels: 2 })).label).toBe("FLAC · 16/44.1");
  });
  it("says mixed formats when none holds half the tracks, the tip naming each", () => {
    expect(cardFormat(tracks(cd, mp3, hires, mp3, cd, hires))).toMatchObject({
      quality: null,
      label: "mixed formats",
    });
    expect(cardFormat(tracks(mp3, mp3, cd, hires, cd)).tip).toBe(
      "Mixed formats: MP3 320 kbps, FLAC 16/44.1 and FLAC 24/96",
    );
  });
  it("says nothing when no track has a format", () => {
    expect(cardFormat(tracks(undefined, undefined))).toEqual({
      quality: null,
      label: null,
      tip: null,
    });
  });
});
