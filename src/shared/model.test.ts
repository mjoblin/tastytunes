/**
 * The shared model's rules: the ones that were each learned the hard way and
 * now have ONE home here, read by main, the renderer and MCP alike.
 *
 * Grouped by the question each answers: who is on a track, what order an
 * album plays in, what format it is, whether a play was a listen, where to
 * pick up again, and how a title meets the library. The names in the
 * fixtures are placeholders chosen to show a shape.
 */
import { describe, expect, it } from "vitest";
import {
  albumFormat,
  albumTracksOf,
  albumVolume,
  compareTrackOrder,
  discGroups,
  editionless,
  emptyPlayStats,
  eventEnd,
  fmtBytes,
  foldPlayEvent,
  formatLabel,
  groupSessions,
  inLibraryIndex,
  integrateLoudnessHistograms,
  isCompilation,
  isHiRes,
  isListen,
  LISTEN_DEFINITION,
  listenThresholdSecs,
  LOUD_HIST_BINS,
  LOUD_HIST_MIN,
  LOUD_HIST_STEP,
  nameSortKey,
  orderTracks,
  performerLine,
  PLAY_STATS_RECENT,
  playKey,
  resumeRun,
  resumeTarget,
  sameArt,
  SESSION_GAP_MS,
  titleIndexOf,
  trackArtists,
  trackInAlbumOf,
  trackPosition,
  type ListeningExternalEvent,
  type ListeningPlayEvent,
  type ListeningRadioTrackEvent,
  type MediaFormat,
  type MediaNode,
  type ResumeRun,
} from "./model";

// ------------------------------------------------------------------ fixtures

const track = (id: string, title: string, f: Partial<MediaNode> = {}): MediaNode => ({
  id,
  parentId: null,
  title,
  upnpClass: "object.item.audioItem.musicTrack",
  isContainer: false,
  artUrl: null,
  artist: null,
  album: null,
  year: null,
  trackNumber: null,
  durationSecs: null,
  ...f,
});

/** A track that only carries a position, for the ordering rules. */
const at = (trackNumber: number | null, discNumber?: number) => ({
  trackNumber,
  ...(discNumber != null ? { discNumber } : {}),
});

const T0 = Date.UTC(2026, 0, 10, 20, 0, 0);
const MIN = 60_000;

function play(
  atMs: number,
  title: string,
  album: string | null,
  playedSeconds: number,
  duration: number | null = 240,
): ListeningPlayEvent {
  return {
    v: 1,
    at: atMs,
    tzOffsetMin: 0,
    kind: "play",
    title,
    artist: "Band",
    album,
    playedSeconds,
    duration,
    codec: null,
    sampleRate: null,
    bitDepth: null,
    lossless: null,
    source: null,
    sourceId: null,
  };
}

// ---------------------------------------------------------- who is on a track

describe("trackArtists: the only way to ask who is on a track", () => {
  it("is the split performers when the server packed several", () => {
    expect(trackArtists({ artist: "Lead; Guest", artists: ["Lead", "Guest"] })).toEqual([
      "Lead",
      "Guest",
    ]);
  });

  it("is the single artist otherwise, and nobody when there is none", () => {
    expect(trackArtists({ artist: "Solo" })).toEqual(["Solo"]);
    expect(trackArtists({ artist: "Solo", artists: [] })).toEqual(["Solo"]);
    expect(trackArtists({ artist: null })).toEqual([]);
  });
});

describe("trackInAlbumOf: does a track belong to an album credited to someone", () => {
  it("the album artist decides when the server sends one", () => {
    // a featured track: performers "Lead; Guest", album artist Lead
    const featured = { artist: "Lead; Guest", artists: ["Lead", "Guest"], albumArtist: "Lead" };
    expect(trackInAlbumOf(featured, "lead ")).toBe(true);
    // the guest performs on it, but it is not in the guest's album
    expect(trackInAlbumOf(featured, "Guest")).toBe(false);
  });

  it("without an album artist, any performer matching counts", () => {
    const duet = { artist: "Lead; Guest", artists: ["Lead", "Guest"] };
    expect(trackInAlbumOf(duet, "Guest")).toBe(true);
    expect(trackInAlbumOf(duet, "Other")).toBe(false);
  });

  it("a track with no artist, or an album with no credit, is not held against the match", () => {
    expect(trackInAlbumOf({ artist: null }, "Anyone")).toBe(true);
    expect(trackInAlbumOf({ artist: "Someone" }, null)).toBe(true);
  });
});

describe("performerLine: a row's performers inside an album under its artist", () => {
  const featured = { artist: "Lead; Guest", artists: ["Lead", "Guest"], albumArtist: "Lead" };

  it("names the album artist, then the guests as feat.", () => {
    expect(performerLine(featured, "Lead")).toBe("Lead feat. Guest");
    const two = { artist: "Lead; G1; G2", artists: ["Lead", "G1", "G2"] };
    expect(performerLine(two, "lead")).toBe("Lead feat. G1, G2");
  });

  it("returns the packed string unchanged anywhere else", () => {
    expect(performerLine(featured, null)).toBe("Lead; Guest");
    expect(performerLine(featured, "Someone Else")).toBe("Lead; Guest");
    expect(performerLine({ artist: "Solo" }, "Solo")).toBe("Solo");
  });
});

describe("isCompilation", () => {
  it("is named so by its album artist, in the spellings taggers use", () => {
    for (const name of ["Various Artists", "various", "VA", "V.A.", "Verschiedene Interpreten"])
      expect(isCompilation({ artist: name }), name).toBe(true);
  });

  it("is credited to an album artist none of its performers is", () => {
    const soundtrack = [{ artist: "Singer A" }, { artist: "Singer B" }];
    expect(isCompilation({ artist: "Film Label" }, soundtrack)).toBe(true);
  });

  it("is NOT an album whose guests join its own artist", () => {
    const tracks = [
      { artist: "Lead" },
      { artist: "Lead; Guest", artists: ["Lead", "Guest"], albumArtist: "Lead" },
    ];
    expect(isCompilation({ artist: "Lead" }, tracks)).toBe(false);
  });

  it("needs two tracks and two different performers before it can say from the tracks", () => {
    expect(isCompilation({ artist: "Label" }, [{ artist: "Singer" }])).toBe(false);
    // one performer under another name (an alias) is not a compilation
    expect(isCompilation({ artist: "Alias" }, [{ artist: "Real" }, { artist: "Real" }])).toBe(
      false,
    );
    expect(isCompilation({ artist: "Label" })).toBe(false);
  });
});

// --------------------------------------------------------------- album order

describe("trackPosition: the number a row shows", () => {
  it("decodes Asset's disc×100+track packing when the disc agrees with it", () => {
    expect(trackPosition(at(212, 2))).toBe(12);
    expect(trackPosition(at(113, 1))).toBe(13);
  });

  it("leaves a number whose hundreds are not the disc as it is", () => {
    expect(trackPosition(at(105, 2))).toBe(105);
    expect(trackPosition(at(12, 2))).toBe(12);
    expect(trackPosition(at(112))).toBe(112);
    expect(trackPosition(at(null, 1))).toBeNull();
  });
});

describe("compareTrackOrder", () => {
  it("sorts by disc, then position; a track with no disc is on disc 1", () => {
    const tracks = [at(1, 2), at(3), at(201, 2), at(2, 1), at(1)];
    // at(1, 2) and at(201, 2) are both disc 2 track 1: the sort is stable
    expect([...tracks].sort(compareTrackOrder)).toEqual([
      at(1),
      at(2, 1),
      at(3),
      at(1, 2),
      at(201, 2),
    ]);
  });

  it("puts unnumbered tracks after the numbered ones, keeping their order", () => {
    const tracks = [
      { ...at(null), id: "x" },
      { ...at(2), id: "b" },
      { ...at(null), id: "y" },
      { ...at(1), id: "a" },
    ];
    expect([...tracks].sort(compareTrackOrder).map((t) => t.id)).toEqual(["a", "b", "x", "y"]);
  });
});

describe("orderTracks: sort only when (disc, position) is unique", () => {
  it("sorts when every key is unique, decoding packed positions", () => {
    const listing = [at(202, 2), at(102, 1), at(201, 2), at(101, 1)];
    expect(orderTracks(listing)).toEqual([at(101, 1), at(102, 1), at(201, 2), at(202, 2)]);
  });

  it("keeps a listing that reads as discs: per-disc numbers with no disc (minidlna)", () => {
    // sorting 1, 2, 3, 1, 2, 3 by number alone would interleave the discs
    const listing = [1, 2, 3, 1, 2, 3].map((n, i) => ({ ...at(n), id: i }));
    expect(orderTracks(listing)).toEqual(listing);
  });

  it("sorts by position when a repeated listing does not read as discs (a search by title)", () => {
    // interleaved but ordered: the best a title-ordered listing allows
    const listing = [2, 1, 1, 2].map((n, i) => ({ ...at(n), id: i }));
    expect(orderTracks(listing).map((t) => t.id)).toEqual([1, 2, 0, 3]);
  });

  it("never reorders the caller's array", () => {
    const listing = [at(2), at(1)];
    orderTracks(listing);
    expect(listing).toEqual([at(2), at(1)]);
  });
});

describe("discGroups: the quiet Disc N dividers", () => {
  it("is one undivided group when the album is one disc", () => {
    const tracks = [at(1, 1), at(2, 1)];
    expect(discGroups(tracks)).toEqual([{ disc: null, tracks }]);
  });

  it("reads no disc as disc 1, so a partly tagged album is still one disc", () => {
    const tracks = [at(1, 1), at(2), at(3, 1)];
    expect(discGroups(tracks)).toEqual([{ disc: null, tracks }]);
  });

  it("groups consecutive runs of one disc when the list spans discs", () => {
    const tracks = [at(1), at(2, 1), at(1, 2), at(2, 2)];
    expect(discGroups(tracks)).toEqual([
      { disc: 1, tracks: [at(1), at(2, 1)] },
      { disc: 2, tracks: [at(1, 2), at(2, 2)] },
    ]);
  });
});

describe("albumVolume: a member of a multi-volume set", () => {
  it("reads a trailing disc, volume or part marker in digits, words or Roman numerals", () => {
    expect(albumVolume("Nature's Best 2 [Disc 1]")).toEqual({ base: "Nature's Best 2", volume: 1 });
    expect(albumVolume("Symphonies Vol. 3")).toEqual({ base: "Symphonies", volume: 3 });
    expect(albumVolume("Anthology, Part Two")).toEqual({ base: "Anthology", volume: 2 });
    expect(albumVolume("Greatest Hits Volume IV")).toEqual({ base: "Greatest Hits", volume: 4 });
    expect(albumVolume("Live (CD 2)")).toEqual({ base: "Live", volume: 2 });
  });

  it("needs the keyword and a real number, and a base before it", () => {
    for (const title of ["Rocky IV", "Formula One", "Part Time", "Disc 1", "Plain Album"])
      expect(albumVolume(title), title).toBeNull();
  });
});

describe("sameArt: telling twin editions apart", () => {
  it("compares art without its size query, and unknown on either side matches", () => {
    expect(sameArt("http://s/art/1.jpg?size=300", "http://s/art/1.jpg?size=600")).toBe(true);
    expect(sameArt("http://s/art/1.jpg", "http://s/art/2.jpg")).toBe(false);
    expect(sameArt(null, "http://s/art/2.jpg")).toBe(true);
  });
});

describe("albumTracksOf: an album's tracks from an index pool", () => {
  const lead = { artist: "Lead", albumArtist: "Lead" };

  it("takes the album's title and credit, featured tracks included, in album order", () => {
    const pool = {
      albums: [{ title: "Record", artist: "Lead" }],
      tracks: [
        track("t2", "Two", { album: "Record", trackNumber: 2, ...lead }),
        track("t1", "One", {
          album: "record",
          trackNumber: 1,
          artist: "Lead; Guest",
          artists: ["Lead", "Guest"],
          albumArtist: "Lead",
        }),
        track("x", "Elsewhere", { album: "Record", trackNumber: 1, artist: "Other Band" }),
      ],
    };
    const album = { title: "Record", artist: "Lead", artUrl: null };
    expect(albumTracksOf(album, pool).map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("splits twin editions (same title, same artist) by the art each track carries", () => {
    const pool = {
      albums: [
        { title: "Record", artist: "Lead" },
        { title: "Record", artist: "Lead" },
      ],
      tracks: [
        track("cd1", "One", { album: "Record", artUrl: "http://s/art/cd.jpg", ...lead }),
        track("hr1", "One", { album: "Record", artUrl: "http://s/art/hires.jpg", ...lead }),
      ],
    };
    const hires = { title: "Record", artist: "Lead", artUrl: "http://s/art/hires.jpg?size=600" };
    expect(albumTracksOf(hires, pool).map((t) => t.id)).toEqual(["hr1"]);
  });
});

// -------------------------------------------------------------------- format

describe("isHiRes: one definition", () => {
  it("is above CD-class: more than 16 bits or more than 48 kHz", () => {
    expect(isHiRes({ bits: 16, rate: 44_100 })).toBe(false);
    // 48 kHz counts as CD-class, not hi-res
    expect(isHiRes({ bits: 16, rate: 48_000 })).toBe(false);
    expect(isHiRes({ bits: 24, rate: 44_100 })).toBe(true);
    expect(isHiRes({ bits: 16, rate: 88_200 })).toBe(true);
    expect(isHiRes({})).toBe(false);
  });

  it("or MQA, whatever its bit depth and rate", () => {
    expect(isHiRes({ bits: 16, rate: 44_100, mqa: "studio" })).toBe(true);
    expect(isHiRes({ bits: 16, rate: 44_100, mqa: "none" })).toBe(false);
  });
});

describe("formatLabel", () => {
  it("says bits/kHz for lossless and kbps for lossy, degrading to what is known", () => {
    const cases: [MediaFormat, string][] = [
      [{ codec: "FLAC", bits: 16, rate: 44_100 }, "FLAC · 16/44.1"],
      [{ codec: "ALAC", bits: 24, rate: 96_000 }, "ALAC · 24/96"],
      [{ codec: "FLAC", rate: 48_000 }, "FLAC · 48 kHz"],
      [{ codec: "FLAC", bits: 24 }, "FLAC · 24-bit"],
      [{ codec: "WAV" }, "WAV"],
      [{ codec: "MP3", kbps: 320 }, "MP3 · 320 kbps"],
      // a lossy stream has a bitrate, not a word length
      [{ codec: "AAC", bits: 16, rate: 44_100, kbps: 256 }, "AAC · 256 kbps"],
      [{ codec: "MP3" }, "MP3"],
    ];
    for (const [f, label] of cases) expect(formatLabel(f)).toBe(label);
    expect(formatLabel(undefined)).toBeNull();
  });
});

describe("albumFormat: the headline and the notes a header and its rows share", () => {
  const cd: MediaFormat = { codec: "FLAC", bits: 16, rate: 44_100 };
  const hires: MediaFormat = { codec: "FLAC", bits: 24, rate: 96_000 };
  const mp3: MediaFormat = { codec: "MP3", kbps: 320 };

  it("headlines the format every track shares, with no notes", () => {
    expect(albumFormat([{ format: cd }, { format: cd }])).toEqual({
      label: "FLAC · 16/44.1",
      notes: [null, null],
    });
  });

  it("headlines the predominant format and notes every exception", () => {
    const tracks = [{ format: cd }, { format: hires }, { format: cd }, { format: mp3 }];
    expect(albumFormat(tracks)).toEqual({
      label: "FLAC · 16/44.1",
      notes: [null, "FLAC · 24/96", null, "MP3 · 320 kbps"],
    });
  });

  it("says mixed formats, and every track says its own, when nothing reaches half", () => {
    const tracks = [{ format: cd }, { format: hires }, { format: mp3 }];
    expect(albumFormat(tracks)).toEqual({
      label: "mixed formats",
      notes: ["FLAC · 16/44.1", "FLAC · 24/96", "MP3 · 320 kbps"],
    });
  });

  it("counts only the tracks it knows, and has no headline when it knows none", () => {
    expect(albumFormat([{ format: cd }, {}, {}])).toEqual({
      label: "FLAC · 16/44.1",
      notes: [null, null, null],
    });
    expect(albumFormat([{}, {}])).toEqual({ label: null, notes: [null, null] });
  });
});

describe("fmtBytes", () => {
  it("prints KB, MB, then GB with one decimal under ten", () => {
    expect(fmtBytes(512)).toBe("1 KB");
    expect(fmtBytes(300 * 1024)).toBe("300 KB");
    expect(fmtBytes(940 * 1024 ** 2)).toBe("940 MB");
    expect(fmtBytes(1.23 * 1024 ** 3)).toBe("1.2 GB");
    expect(fmtBytes(12.6 * 1024 ** 3)).toBe("13 GB");
  });
});

// --------------------------------------------------------------- a listen

describe("isListen: the one definition of a listen", () => {
  it("is half the track, or four minutes, whichever comes first", () => {
    expect(listenThresholdSecs(300)).toBe(150);
    expect(listenThresholdSecs(600)).toBe(240);
    expect(listenThresholdSecs(null)).toBe(240);
    expect(isListen(149, 300)).toBe(false);
    expect(isListen(150, 300)).toBe(true);
    expect(isListen(240, 3600)).toBe(true);
  });

  it("never counts a track shorter than the 30 second floor", () => {
    expect(isListen(29, 29)).toBe(false);
    expect(isListen(15, 30)).toBe(true);
  });

  it("the words say the same thing as the numbers", () => {
    expect(LISTEN_DEFINITION).toContain("half its track");
    expect(LISTEN_DEFINITION).toContain(`${listenThresholdSecs(null) / 60} minutes`);
  });
});

describe("playKey: the record's content key", () => {
  it("is trimmed, lowercased and whitespace-collapsed, field by field", () => {
    expect(playKey("  Some   Song ", "BAND", null)).toBe("some song|band|");
    expect(playKey("Song", "Band", "Record")).toBe(playKey(" song", "band ", "RECORD"));
  });
});

describe("foldPlayEvent: folding the record into play stats", () => {
  it("tallies plays, listens, seconds and the latest start by content key", () => {
    const stats = emptyPlayStats();
    foldPlayEvent(stats, play(T0, "Song", "Record", 200));
    foldPlayEvent(stats, play(T0 + 10 * MIN, "SONG ", "record", 60));
    expect(stats.tracks[playKey("Song", "Band", "Record")]).toEqual({
      plays: 2,
      listens: 1,
      lastAt: T0 + 10 * MIN,
      seconds: 260,
    });
    expect(stats.since).toBe(T0);
  });

  it("counts library plays only: external and radio lines never count", () => {
    const stats = emptyPlayStats();
    const airplay: ListeningExternalEvent = {
      v: 1,
      at: T0,
      tzOffsetMin: 0,
      kind: "external",
      source: "AirPlay",
      sourceId: "AIRPLAY",
      title: "Song",
      artist: "Band",
      album: "Record",
      playedSeconds: 240,
      duration: 240,
    };
    const sighting: ListeningRadioTrackEvent = {
      v: 1,
      at: T0,
      tzOffsetMin: 0,
      kind: "radio-track",
      station: "A Station",
      title: "Song",
      artist: "Band",
    };
    foldPlayEvent(stats, airplay);
    foldPlayEvent(stats, sighting);
    expect(stats).toEqual(emptyPlayStats());
  });

  it("an album's run continues across plays within the session gap", () => {
    const stats = emptyPlayStats();
    foldPlayEvent(stats, play(T0, "One", "Record", 200)); // a listen
    foldPlayEvent(stats, play(T0 + 200_000, "Two", "Record", 60)); // not a listen
    const runs = stats.albumRuns[playKey(null, null, "Record")];
    expect(runs).toEqual([
      {
        startAt: T0,
        endAt: T0 + 260_000,
        plays: 2,
        listened: [playKey("One", "Band", "Record")],
      },
    ]);
  });

  it("opens a new run after the gap, or when another album came between", () => {
    const stats = emptyPlayStats();
    const key = playKey(null, null, "Record");
    foldPlayEvent(stats, play(T0, "One", "Record", 100));
    // 100 s played, then more than the gap before the next start
    foldPlayEvent(stats, play(T0 + 100_000 + SESSION_GAP_MS + 1, "Two", "Record", 100));
    expect(stats.albumRuns[key]).toHaveLength(2);
    // another album, then back: a third run
    foldPlayEvent(stats, play(T0 + 2 * SESSION_GAP_MS, "Else", "Other", 100));
    foldPlayEvent(stats, play(T0 + 2 * SESSION_GAP_MS + 2 * MIN, "Three", "Record", 100));
    expect(stats.albumRuns[key]).toHaveLength(3);
  });

  it("keeps only the most recent plays", () => {
    const stats = emptyPlayStats();
    for (let i = 0; i < PLAY_STATS_RECENT + 5; i++)
      foldPlayEvent(stats, play(T0 + i * MIN, `Song ${i}`, null, 40));
    expect(stats.recent).toHaveLength(PLAY_STATS_RECENT);
    expect(stats.recent[0].title).toBe("Song 5");
  });
});

describe("resumeRun and resumeTarget: pick up where you left off", () => {
  const album = ["One", "Two", "Three", "Four"].map((t, i) =>
    track(`t${i + 1}`, t, { album: "Record", trackNumber: i + 1 }),
  );
  /** The run, which these cases need to exist. */
  const runOf = (recent: ListeningPlayEvent[], now: number): ResumeRun => {
    const run = resumeRun(recent, now);
    if (!run) throw new Error("expected a resume run");
    return run;
  };

  it("finds the latest run of one album, back to the last gap or album change", () => {
    const recent = [
      play(T0 - 2 * 60 * MIN, "Old", "Record", 240), // before the gap
      play(T0 - 10 * MIN, "Else", "Other", 240), // another album
      play(T0, "One", "Record", 240),
      play(T0 + 4 * MIN, "Two", "Record", 240),
    ];
    const run = runOf(recent, T0 + 60 * MIN);
    expect(run.plays.map((p) => p.title)).toEqual(["One", "Two"]);
    expect(run).toMatchObject({ album: "Record", artist: "Band", lastListened: true });
  });

  it("offers nothing when the last play was a week ago, or had no album", () => {
    const last = play(T0, "One", "Record", 240);
    expect(resumeRun([last], T0 + 4 * MIN + 7 * 86_400_000 + 1)).toBeNull();
    expect(resumeRun([play(T0, "Single", null, 240)], T0 + MIN)).toBeNull();
    expect(resumeRun([], T0)).toBeNull();
  });

  it("resumes after the last listened track", () => {
    const run = runOf([play(T0, "two", "Record", 240)], T0 + 5 * MIN);
    expect(resumeTarget(run, album)?.id).toBe("t3");
  });

  it("resumes the interrupted track itself when its play never became a listen", () => {
    const run = runOf([play(T0, "Two", "Record", 30)], T0 + MIN);
    expect(resumeTarget(run, album)?.id).toBe("t2");
  });

  it("offers nothing when the run reached the end, or the track is not on the album", () => {
    const ended = runOf([play(T0, "Four", "Record", 240)], T0 + 5 * MIN);
    expect(resumeTarget(ended, album)).toBeNull();
    const stray = runOf([play(T0, "Bonus", "Record", 240)], T0 + 5 * MIN);
    expect(resumeTarget(stray, album)).toBeNull();
    // a one-track album has nowhere to resume to
    const single = runOf([play(T0, "One", "Record", 30)], T0 + MIN);
    expect(resumeTarget(single, album.slice(0, 1))).toBeNull();
  });
});

describe("groupSessions: the Timeline's unit", () => {
  it("joins lines at most the gap apart, from one line's end to the next's start, in time order", () => {
    const a = play(T0, "One", "Record", 240);
    const b = play(T0 + 4 * MIN + SESSION_GAP_MS, "Two", "Record", 240); // exactly the gap
    const c = play(T0 + 8 * MIN + 2 * SESSION_GAP_MS + 1, "Three", "Record", 240); // past it
    const sessions = groupSessions([c, a, b]);
    expect(sessions.map((s) => s.events)).toEqual([[a, b], [c]]);
    expect(sessions[0]).toMatchObject({ startAt: a.at, endAt: eventEnd(b) });
  });

  it("a radio sighting has no played time: it ends where it starts", () => {
    const sighting: ListeningRadioTrackEvent = {
      v: 1,
      at: T0,
      tzOffsetMin: 0,
      kind: "radio-track",
      station: null,
      title: "Song",
      artist: null,
    };
    expect(eventEnd(sighting)).toBe(T0);
    expect(eventEnd(play(T0, "One", null, 90))).toBe(T0 + 90_000);
  });
});

// ------------------------------------------------- a title meets the library

describe("nameSortKey", () => {
  it("files a leading The under what follows, and only The", () => {
    expect(nameSortKey("The Cure")).toBe("Cure");
    expect(nameSortKey("the national")).toBe("national");
    expect(nameSortKey("A Tribe Called Quest")).toBe("A Tribe Called Quest");
    expect(nameSortKey("Theo")).toBe("Theo");
    expect(nameSortKey("The")).toBe("The");
  });
});

describe("editionless: a title as a heard-elsewhere line meets the library", () => {
  it("drops edition suffixes in brackets and after a dash, and lowercases", () => {
    const cases: [string, string][] = [
      ["Song (Remastered 2015)", "song"],
      ["Song [Deluxe Edition]", "song"],
      ["Song (Live at the Hall)", "song"],
      ["Song (Mono Version)", "song"],
      ["Song - Live", "song"],
      ["Song - 2011 Remaster", "song"],
      ["Song - Remastered 2009", "song"],
      ["Song - Radio Edit", "song"],
      ["  Two   Spaces  ", "two spaces"],
    ];
    for (const [title, key] of cases) expect(editionless(title), title).toBe(key);
  });

  it("keeps brackets that are not an edition, and edition words inside a title", () => {
    expect(editionless("Song (feat. Guest)")).toBe("song (feat. guest)");
    expect(editionless("Song (Take 2)")).toBe("song (take 2)");
    expect(editionless("Live and Let Die")).toBe("live and let die");
  });
});

describe("inLibraryIndex: does the library hold this track", () => {
  const index = titleIndexOf([
    {
      tracks: [
        track("t1", "Song (Remastered)", {
          artist: "Lead; Guest",
          artists: ["Lead", "Guest"],
          albumArtist: "Lead",
        }),
        track("t2", "Other Song", { artist: "Solo" }),
      ],
    },
  ]);

  it("matches by editionless title when the line names no artist", () => {
    expect(inLibraryIndex(index, "Song - Live", null)).toBe(true);
    expect(inLibraryIndex(index, "Missing", null)).toBe(false);
  });

  it("matches any performer or the album artist against a streaming credit's names", () => {
    expect(inLibraryIndex(index, "Song", "Guest")).toBe(true);
    expect(inLibraryIndex(index, "Song", "Lead & Someone")).toBe(true);
    expect(inLibraryIndex(index, "Song", "Someone feat. Guest")).toBe(true);
    expect(inLibraryIndex(index, "Other Song", "SOLO")).toBe(true);
  });

  it("does not match the title under someone else's name", () => {
    expect(inLibraryIndex(index, "Song", "Someone Else")).toBe(false);
  });
});

// -------------------------------------------------------- album loudness

describe("integrateLoudnessHistograms: one loudness over several tracks' blocks", () => {
  /** A histogram with `count` blocks at `lufs` (the bin it falls in). */
  const blocksAt = (lufs: number, count: number): number[] => {
    const h = new Array<number>(LOUD_HIST_BINS).fill(0);
    h[Math.floor((lufs - LOUD_HIST_MIN) / LOUD_HIST_STEP)] = count;
    return h;
  };
  /** The loudness a bin stands for: its centre. */
  const centre = (lufs: number): number =>
    LOUD_HIST_MIN + (Math.floor((lufs - LOUD_HIST_MIN) / LOUD_HIST_STEP) + 0.5) * LOUD_HIST_STEP;

  it("is the bin's own loudness when every block sits in one bin", () => {
    expect(integrateLoudnessHistograms([blocksAt(-14, 50)])).toBeCloseTo(centre(-14), 9);
  });

  it("averages energy, not loudness, across tracks", () => {
    // equal time at two levels 10 LU apart: 10·log10((1 + 0.1) / 2) ≈ −2.60 LU
    // under the louder one, well inside the −10 LU relative gate
    const album = integrateLoudnessHistograms([blocksAt(-20, 100), blocksAt(-30, 100)]);
    expect(album).toBeCloseTo(centre(-20) + 10 * Math.log10(1.1 / 2), 9);
  });

  it("applies the relative gate over the combined distribution", () => {
    // blocks 20 LU under the rest fall below the gate and do not count
    const album = integrateLoudnessHistograms([blocksAt(-20, 100), blocksAt(-40, 100)]);
    expect(album).toBeCloseTo(centre(-20), 9);
  });

  it("is null with no blocks at all", () => {
    expect(integrateLoudnessHistograms([])).toBeNull();
    expect(integrateLoudnessHistograms([new Array<number>(LOUD_HIST_BINS).fill(0)])).toBeNull();
  });
});
