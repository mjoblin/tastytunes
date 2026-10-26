/**
 * The two registers for an album's facts: technical format tokens are chips,
 * collection facts are one dotted line of prose. One home for both, so the
 * Library header and the Info modal can never drift.
 */
import { describe, expect, it } from "vitest";
import type { MediaFormat, MediaNode } from "@shared/model";
import {
  albumFactsLine,
  albumFromTracks,
  albumFormatChips,
  FACT_SEP,
  trackFormatChips,
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

describe("trackFormatChips: a track's tokens in the album header's compact spelling", () => {
  it("is codec and depth/rate for a lossless file, codec and bitrate for a lossy one", () => {
    const f: MediaFormat = { codec: "FLAC", rate: 96_000, bits: 24, kbps: 2765, sizeBytes: 0 };
    expect(trackFormatChips(f)).toEqual(["FLAC", "24/96"]);
    expect(trackFormatChips({ codec: "FLAC", rate: 44_100, bits: 16 })).toEqual([
      "FLAC",
      "16/44.1",
    ]);
    expect(trackFormatChips({ codec: "MP3", rate: 44_100, kbps: 320 })).toEqual([
      "MP3",
      "320 kbps",
    ]);
    expect(trackFormatChips(null)).toEqual([]);
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

describe("albumFromTracks: what an album's tracks say when the album is silent", () => {
  const node = (over: Partial<MediaNode>): MediaNode => ({
    id: "x",
    parentId: null,
    title: "Only God Was Above Us",
    upnpClass: "object.container.album.musicAlbum",
    isContainer: true,
    artUrl: null,
    artist: null,
    album: null,
    year: null,
    trackNumber: null,
    durationSecs: null,
    ...over,
  });
  const track = (over: Partial<MediaNode>): MediaNode =>
    node({ upnpClass: "object.item.audioItem.musicTrack", isContainer: false, ...over });

  it("fills a bare album's cover, artist and year from its tracks", () => {
    const tracks = [
      track({ id: "1", artUrl: null, artist: "Vampire Weekend", year: "2024" }),
      track({ id: "2", artUrl: "http://s/cover.jpg", artist: "Vampire Weekend", year: "2024" }),
    ];
    const filled = albumFromTracks(node({}), tracks);
    expect(filled.artUrl).toBe("http://s/cover.jpg");
    expect(filled.artist).toBe("Vampire Weekend");
    expect(filled.year).toBe("2024");
  });

  it("names an artist or a year only when every track agrees, the album artist first", () => {
    const mixed = [
      track({ id: "1", artist: "A", albumArtist: "Various Artists", year: "1999" }),
      track({ id: "2", artist: "B", albumArtist: "Various Artists", year: "2001" }),
    ];
    const filled = albumFromTracks(node({}), mixed);
    expect(filled.artist).toBe("Various Artists");
    expect(filled.year).toBeNull();
    expect(
      albumFromTracks(node({}), [track({ artist: "A" }), track({ artist: "B" })]).artist,
    ).toBeNull();
  });

  it("keeps what the album says, and returns the album itself when the tracks add nothing", () => {
    const album = node({ artUrl: "http://s/a.jpg", artist: "Own", year: "1980" });
    expect(
      albumFromTracks(album, [track({ artUrl: "http://s/t.jpg", artist: "T", year: "1" })]),
    ).toBe(album);
    const bare = node({});
    expect(albumFromTracks(bare, [])).toBe(bare);
    expect(albumFromTracks(bare, [track({})])).toBe(bare);
  });
});
