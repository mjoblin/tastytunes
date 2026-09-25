/**
 * The renderer's formatters and the now-playing merge: one home each, so
 * every surface that prints a time, a rate or a quality says it the same way.
 */
import { describe, expect, it } from "vitest";
import type { ZoneNowPlaying, ZonePlayState, ZonePlayStateMetadata } from "@shared/smoip";
import {
  activeSourceId,
  controlSet,
  cx,
  deriveNowPlaying,
  fmtAgo,
  fmtDayBucket,
  fmtDuration,
  fmtKHz,
  fmtRelative,
  fmtTime,
  matchesFilter,
  signalQuality,
} from "./format";

const md = (f: Partial<ZonePlayStateMetadata>): ZonePlayStateMetadata => ({
  class: null,
  source: null,
  name: null,
  playback_source: null,
  track_number: null,
  duration: null,
  album: null,
  artist: null,
  title: null,
  art_url: null,
  sample_format: null,
  mqa: null,
  codec: null,
  lossless: null,
  sample_rate: null,
  bit_depth: null,
  encoding: null,
  station: null,
  bitrate: null,
  radio_id: null,
  ...f,
});

const ps = (
  f: Partial<ZonePlayState>,
  meta: Partial<ZonePlayStateMetadata> | null,
): ZonePlayState => ({
  state: "play",
  position: null,
  presettable: null,
  queue_index: null,
  queue_length: null,
  queue_id: 1,
  mode_repeat: null,
  mode_shuffle: null,
  metadata: meta ? md(meta) : null,
  ...f,
});

const nowPlaying = (lines: [string | null, string | null, string | null]): ZoneNowPlaying => ({
  state: "play",
  source: { id: "MEDIA_PLAYER", name: "Media Library" },
  display: {
    line1: lines[0],
    line2: lines[1],
    line3: lines[2],
    format: null,
    mqa: null,
    playback_source: null,
    class: null,
    art_url: "http://device/art.jpg",
    art_file: null,
    progress: null,
    context: null,
  },
  queue: null,
  controls: ["pause", "skip_next"],
});

const SEC = 1000;
const DAY = 86_400_000;

describe("fmtTime: a playhead", () => {
  it("is M:SS under an hour and H:MM:SS over, whole seconds, floored", () => {
    expect(fmtTime(0)).toBe("0:00");
    expect(fmtTime(59.9)).toBe("0:59");
    expect(fmtTime(61)).toBe("1:01");
    expect(fmtTime(3600)).toBe("1:00:00");
    expect(fmtTime(3723)).toBe("1:02:03");
  });

  it("shows a placeholder for anything that is not a time", () => {
    for (const v of [null, undefined, NaN, Infinity, -1]) expect(fmtTime(v)).toBe("–:––");
  });
});

describe("fmtDuration: a collection's runtime, in words", () => {
  it("rounds to whole minutes FIRST, so the minutes never read 60", () => {
    expect(fmtDuration(3580)).toBe("1 hr"); // 59:40
    expect(fmtDuration(7176)).toBe("2 hrs"); // 1:59:36
  });

  it("says minutes, hours and minutes, or under a minute", () => {
    expect(fmtDuration(42 * 60)).toBe("42 min");
    expect(fmtDuration(72 * 60)).toBe("1 hr 12 min");
    expect(fmtDuration(125 * 60)).toBe("2 hrs 5 min");
    expect(fmtDuration(20)).toBe("under a minute");
    expect(fmtDuration(0)).toBe("0 min");
  });

  it("coarse drops the minutes once the hours run to two digits", () => {
    expect(fmtDuration(605 * 60, { coarse: true })).toBe("10 hrs");
    expect(fmtDuration(605 * 60)).toBe("10 hrs 5 min");
    expect(fmtDuration(545 * 60, { coarse: true })).toBe("9 hrs 5 min");
  });
});

describe("fmtKHz", () => {
  it("prints whole rates bare and fractional rates to one decimal", () => {
    expect(fmtKHz(48_000)).toBe("48 kHz");
    expect(fmtKHz(44_100)).toBe("44.1 kHz");
    expect(fmtKHz(88_200)).toBe("88.2 kHz");
    expect(fmtKHz(192_000)).toBe("192 kHz");
  });
});

describe("fmtRelative and fmtAgo: how long ago", () => {
  const now = Date.UTC(2026, 5, 15, 12);

  it("fmtRelative counts up through minutes, hours and days", () => {
    expect(fmtRelative(now - 44 * SEC, now)).toBe("just now");
    expect(fmtRelative(now + 60 * SEC, now)).toBe("just now"); // a clock skewed ahead
    expect(fmtRelative(now - 5 * 60 * SEC, now)).toBe("5 min ago");
    expect(fmtRelative(now - 3 * 3600 * SEC, now)).toBe("3 hr ago");
    expect(fmtRelative(now - DAY, now)).toBe("yesterday");
    expect(fmtRelative(now - 3 * DAY, now)).toBe("3 days ago");
  });

  it("fmtAgo is coarse: days, then weeks, months and years, never a date", () => {
    expect(fmtAgo(now - 3600 * SEC, now)).toBe("today");
    expect(fmtAgo(now - DAY, now)).toBe("yesterday");
    expect(fmtAgo(now - 13 * DAY, now)).toBe("13 days ago");
    expect(fmtAgo(now - 14 * DAY, now)).toBe("2 weeks ago");
    expect(fmtAgo(now - 59 * DAY, now)).toBe("8 weeks ago");
    expect(fmtAgo(now - 60 * DAY, now)).toBe("2 months ago");
    expect(fmtAgo(now - 365 * DAY, now)).toBe("a year ago");
    expect(fmtAgo(now - 800 * DAY, now)).toBe("2 years ago");
  });
});

describe("fmtDayBucket", () => {
  it("says Today and Yesterday by the local calendar day, not 24-hour spans", () => {
    const noon = new Date(2026, 5, 15, 12).getTime();
    expect(fmtDayBucket(new Date(2026, 5, 15, 0, 5).getTime(), noon)).toBe("Today");
    // eleven hours ago, but on the previous calendar day
    const lateLastNight = new Date(2026, 5, 14, 23, 55).getTime();
    expect(fmtDayBucket(lateLastNight, new Date(2026, 5, 15, 0, 30).getTime())).toBe("Yesterday");
  });
});

describe("deriveNowPlaying: the one merge of play_state and now_playing", () => {
  it("reads a library track from the metadata, with its badges in chip order", () => {
    const meta = deriveNowPlaying(
      ps(
        {},
        {
          title: "Opening",
          artist: "Band",
          album: "Record",
          art_url: "http://device/a.jpg",
          codec: "FLAC",
          sample_rate: 96_000,
          bit_depth: 24,
          bitrate: 4_608_000,
          lossless: true,
          mqa: "none",
          duration: 200,
        },
      ),
      null,
    );
    expect(meta).toEqual({
      title: "Opening",
      subtitle: "Band",
      album: "Record",
      artUrl: "http://device/a.jpg",
      isRadio: false,
      badges: ["FLAC", "96 kHz", "24-bit", "4608 kbps", "lossless"],
    });
  });

  it("names MQA when the stream carries it", () => {
    const meta = deriveNowPlaying(ps({}, { title: "T", mqa: "studio", duration: 1 }), null);
    expect(meta.badges).toEqual(["MQA studio"]);
  });

  it("falls back to the now-playing display lines", () => {
    const meta = deriveNowPlaying(
      ps({}, { duration: 100 }),
      nowPlaying(["Line One", "Line Two", "Line Three"]),
    );
    expect(meta).toMatchObject({
      title: "Line One",
      subtitle: "Line Two",
      album: "Line Three",
      artUrl: "http://device/art.jpg",
    });
  });

  it("reads radio as the station over the song, with no album", () => {
    const meta = deriveNowPlaying(
      ps({}, { class: "stream.radio", station: "A Station", title: "A Song", album: "Ignored" }),
      null,
    );
    expect(meta).toMatchObject({
      title: "A Station",
      subtitle: "A Song",
      album: null,
      isRadio: true,
    });
    // a station name alone is enough to know it is radio
    expect(deriveNowPlaying(ps({}, { station: "A Station" }), null).isRadio).toBe(true);
  });

  it("NOTHING LOADED: an emptied queue's stale title reads as empty", () => {
    // state ready, no queue id and no duration, still carrying the last title
    const idle = ps({ state: "ready", queue_id: null }, { title: "Last Track" });
    const meta = deriveNowPlaying(idle, nowPlaying(["Last Track", null, null]));
    expect(meta).toEqual({
      title: null,
      subtitle: null,
      album: null,
      artUrl: null,
      isRadio: false,
      badges: [],
    });
  });

  it("a ready streamer with a queue or a duration is loaded, not idle", () => {
    expect(deriveNowPlaying(ps({ state: "ready" }, { title: "Queued" }), null).title).toBe(
      "Queued",
    );
    const paused = ps({ state: "ready", queue_id: null }, { title: "Known", duration: 200 });
    expect(deriveNowPlaying(paused, null).title).toBe("Known");
  });
});

describe("signalQuality: the one-glance lamp", () => {
  it("hi-res lossless, lossless, lossy, unknown", () => {
    const q = (f: Partial<ZonePlayStateMetadata>): string => signalQuality(ps({}, f));
    expect(q({ lossless: true, bit_depth: 24, sample_rate: 96_000 })).toBe("hires");
    expect(q({ lossless: true, bit_depth: 16, sample_rate: 44_100 })).toBe("lossless");
    expect(q({ lossless: true, bit_depth: 16, sample_rate: 44_100, mqa: "studio" })).toBe("hires");
    expect(q({ codec: "MP3", bitrate: 320_000 })).toBe("lossy");
    // a hi-res rate is not hi-res lossless when the stream is not lossless
    expect(q({ codec: "AAC", sample_rate: 96_000 })).toBe("lossy");
    expect(q({})).toBe("unknown");
    expect(signalQuality(null)).toBe("unknown");
  });
});

describe("the small helpers", () => {
  it("matchesFilter: every token somewhere across the fields, any case", () => {
    const fields = ["Iron Maiden", "The Number of the Beast", null];
    expect(matchesFilter("maiden beast", fields)).toBe(true);
    expect(matchesFilter("  MAIDEN  ", fields)).toBe(true);
    expect(matchesFilter("maiden priest", fields)).toBe(false);
    expect(matchesFilter("", fields)).toBe(true);
  });

  it("activeSourceId: zone state first, now_playing for the beat it lags", () => {
    expect(activeSourceId({ source: "AIRPLAY" }, { source: { id: "MEDIA_PLAYER" } })).toBe(
      "AIRPLAY",
    );
    expect(activeSourceId({ source: null }, { source: { id: "MEDIA_PLAYER" } })).toBe(
      "MEDIA_PLAYER",
    );
    expect(activeSourceId(null, null)).toBeNull();
  });

  it("controlSet and cx", () => {
    expect(controlSet(nowPlaying([null, null, null]))).toEqual(new Set(["pause", "skip_next"]));
    expect(controlSet(null).size).toBe(0);
    expect(cx("a", false, null, undefined, "", "b")).toBe("a b");
  });
});
