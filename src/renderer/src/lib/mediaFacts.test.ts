/**
 * The two registers for an album's facts: technical format tokens are chips,
 * collection facts are one dotted line of prose. One home for both, so the
 * Library header and the Info modal can never drift.
 */
import { describe, expect, it } from "vitest";
import type { MediaFormat } from "@shared/model";
import {
  albumFactsLine,
  albumFormatChips,
  FACT_SEP,
  formatChips,
  trackFactsLine,
} from "./mediaFacts";

const MiB = 1024 ** 2;

describe("FACT_SEP", () => {
  it("is a middle dot between EN spaces, which HTML does not collapse", () => {
    expect([...FACT_SEP].map((c) => c.codePointAt(0))).toEqual([0x2002, 0xb7, 0x2002]);
  });
});

describe("albumFactsLine: collection facts only", () => {
  it("is year, track count, runtime and size, in that order", () => {
    // ten tracks, 26:53 and 200 MB between them
    const tracks = Array.from({ length: 10 }, (_, i) => ({
      year: null,
      durationSecs: i < 3 ? 162 : 161,
      format: { codec: "FLAC", sizeBytes: 20 * MiB },
    }));
    expect(albumFactsLine({ year: "2023" }, tracks)).toBe(
      ["2023", "10 tracks", "26:53", "200 MB"].join(FACT_SEP),
    );
  });

  it("leaves out what it does not know, and takes the year from a track when the album has none", () => {
    const tracks = [
      { year: "1999", durationSecs: null, format: undefined },
      { year: null, durationSecs: null, format: undefined },
    ];
    expect(albumFactsLine({ year: null }, tracks)).toBe(["1999", "2 tracks"].join(FACT_SEP));
    expect(albumFactsLine({ year: null }, [])).toBe("");
  });

  it("carries no format: that rides beside it as chips", () => {
    const tracks = [{ year: null, durationSecs: 60, format: { codec: "FLAC", bits: 24 } }];
    expect(albumFactsLine({ year: null }, tracks)).not.toContain("FLAC");
  });
});

describe("trackFactsLine", () => {
  it("is the track's duration, or nothing", () => {
    expect(trackFactsLine({ durationSecs: 275 })).toBe("4:35");
    expect(trackFactsLine({ durationSecs: null })).toBe("");
  });
});

describe("formatChips: a track's format tokens, as Now Playing spells them", () => {
  it("is codec, kHz, bit depth, kbps, then lossless", () => {
    const f: MediaFormat = { codec: "FLAC", rate: 96_000, bits: 24, kbps: 2765 };
    expect(formatChips(f)).toEqual(["FLAC", "96 kHz", "24-bit", "2765 kbps", "lossless"]);
  });

  it("says lossless only for lossless codecs, whatever the codec's case", () => {
    expect(formatChips({ codec: "MP3", rate: 44_100, kbps: 320 })).toEqual([
      "MP3",
      "44.1 kHz",
      "320 kbps",
    ]);
    expect(formatChips({ codec: "alac" })).toEqual(["alac", "lossless"]);
    expect(formatChips(null)).toEqual([]);
  });
});

describe("albumFormatChips: the album's headline, split into chips", () => {
  const cd: MediaFormat = { codec: "FLAC", bits: 16, rate: 44_100 };

  it("splits the shared label, or is the one honest mixed formats chip", () => {
    expect(albumFormatChips([{ format: cd }, { format: cd }])).toEqual(["FLAC", "16/44.1"]);
    const mixed = [
      { format: cd },
      { format: { codec: "MP3", kbps: 320 } },
      { format: { codec: "WAV" } },
    ];
    expect(albumFormatChips(mixed)).toEqual(["mixed formats"]);
    expect(albumFormatChips([{}, {}])).toEqual([]);
  });
});
