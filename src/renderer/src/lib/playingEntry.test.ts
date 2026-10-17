/**
 * Which queue entry is playing, and whether a library item matches it.
 *
 * The streamer describes the playing track twice: a queue POINTER (play_id,
 * queue_id) and a file-tag READOUT (play_state.metadata). Library rows match
 * the pointer's entry, because the entry carries the server's own names; the
 * readout is the audible truth when the pointer has run ahead of it.
 */
import { describe, expect, it } from "vitest";
import type { MediaNode } from "@shared/model";
import type {
  QueueList,
  QueueListItem,
  QueueListItemMetadata,
  ZonePlayState,
  ZonePlayStateMetadata,
} from "@shared/smoip";
import {
  albumMatchesEntry,
  contentPlayId,
  entryArtistMatches,
  entryMatchesReadout,
  playingQueueEntry,
  trackMatchesEntry,
} from "./playingEntry";

// ------------------------------------------------------------------ fixtures

const entry = (id: number, f: Partial<QueueListItemMetadata>): QueueListItem => ({
  id,
  position: id,
  metadata: {
    class: null,
    source: null,
    name: null,
    title: null,
    art_url: null,
    track_number: null,
    duration: null,
    genre: null,
    album: null,
    artist: null,
    ...f,
  },
});

const queue = (items: QueueListItem[], playId: number | null): QueueList => ({
  start: 0,
  count: items.length,
  total: items.length,
  play_postition: null,
  play_id: playId,
  items,
});

const readout = (f: Partial<ZonePlayStateMetadata>): ZonePlayStateMetadata => ({
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

const playState = (
  queueId: number | null,
  md: Partial<ZonePlayStateMetadata> | null,
): ZonePlayState => ({
  state: "play",
  position: null,
  presettable: null,
  queue_index: null,
  queue_length: null,
  queue_id: queueId,
  mode_repeat: null,
  mode_shuffle: null,
  metadata: md ? readout(md) : null,
});

const node = (f: Partial<MediaNode>): MediaNode => ({
  id: "n",
  parentId: null,
  title: "",
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

const A = entry(1, { title: "Opening", duration: 200, album: "Record", artist: "Band" });
const B = entry(2, { title: "Middle", duration: 180, album: "Record", artist: "Band" });
const C = entry(3, { title: "Closing", duration: 240, album: "Record", artist: "Band" });

// ------------------------------------------------------------------- tests

describe("playingQueueEntry", () => {
  it("is the entry the pointer names: the settled id, else play_id, else queue_id", () => {
    const q = queue([A, B, C], 2);
    expect(playingQueueEntry(q, playState(3, null), 1)).toBe(A);
    expect(playingQueueEntry(q, playState(3, null), null)).toBe(B);
    expect(playingQueueEntry(queue([A, B, C], null), playState(3, null))).toBe(C);
  });

  it("is null when nothing is named or the named entry is not in the list", () => {
    expect(playingQueueEntry(queue([A, B], null), playState(null, null))).toBeNull();
    expect(playingQueueEntry(queue([A, B], 9), null)).toBeNull();
    expect(playingQueueEntry(null, playState(1, null))).toBeNull();
  });
});

describe("entryMatchesReadout: strictly, title equal and length within 2 s", () => {
  it("matches on title and a duration within two seconds", () => {
    expect(entryMatchesReadout(A, readout({ title: "Opening", duration: 202 }))).toBe(true);
    expect(entryMatchesReadout(A, readout({ title: "Opening", duration: 203 }))).toBe(false);
    expect(entryMatchesReadout(A, readout({ title: "opening", duration: 200 }))).toBe(false);
  });

  it("ignores the album: renaming servers change it, never the title or length", () => {
    // Asset merges "[Disc n]" folders, so the readout's album differs
    expect(entryMatchesReadout(A, readout({ title: "Opening", album: "Record [Disc 1]" }))).toBe(
      true,
    );
  });

  it("does not hold an unknown duration against a match, but needs a title on both sides", () => {
    expect(entryMatchesReadout(A, readout({ title: "Opening" }))).toBe(true);
    expect(entryMatchesReadout(A, readout({ duration: 200 }))).toBe(false);
    expect(entryMatchesReadout(entry(9, {}), readout({ title: "Opening" }))).toBe(false);
    expect(entryMatchesReadout(A, null)).toBe(false);
  });
});

describe("contentPlayId: THE POINTER CAN LIE", () => {
  it("stays with the pointer when its entry matches the readout", () => {
    const q = queue([A, B, C], 2);
    expect(contentPlayId(q, playState(2, { title: "Middle", duration: 180 }))).toEqual({
      raw: 2,
      content: null,
    });
  });

  it("names the one entry the readout matches when the pointer has run ahead", () => {
    // a queue edit landed after the decoder pre-opened the next file: the
    // pointer says Closing, the speakers (and the readout) say Middle
    const q = queue([A, B, C], 3);
    expect(contentPlayId(q, playState(3, { title: "Middle", duration: 181 }))).toEqual({
      raw: 3,
      content: 2,
    });
  });

  it("will not re-target when more than one entry matches the readout", () => {
    const twice = entry(4, { title: "Middle", duration: 180 });
    const q = queue([A, B, C, twice], 3);
    expect(contentPlayId(q, playState(3, { title: "Middle" })).content).toBeNull();
  });

  it("has nothing to say without a pointer, a readout title or a list", () => {
    expect(contentPlayId(queue([A, B], null), playState(null, { title: "Middle" }))).toEqual({
      raw: null,
      content: null,
    });
    expect(contentPlayId(queue([A, B], 1), playState(1, {})).content).toBeNull();
    expect(contentPlayId(null, playState(1, { title: "Middle" }))).toEqual({
      raw: 1,
      content: null,
    });
  });
});

describe("entryArtistMatches: the entry names one of the item's identities", () => {
  it("matches a performer, not only the packed display string", () => {
    const featured = { artist: "Lead; Guest", artists: ["Lead", "Guest"] };
    expect(entryArtistMatches("Lead", featured)).toBe(true);
    expect(entryArtistMatches("guest ", featured)).toBe(true);
  });

  it("matches the album artist: a compilation track's entry says Various Artists", () => {
    const track = { artist: "A Singer", albumArtist: "Various Artists" };
    expect(entryArtistMatches("Various Artists", track)).toBe(true);
    expect(entryArtistMatches("A Singer", track)).toBe(true);
  });

  it("rejects anyone else, and never holds a missing name against the match", () => {
    expect(entryArtistMatches("Other", { artist: "Band" })).toBe(false);
    expect(entryArtistMatches(null, { artist: "Band" })).toBe(true);
    expect(entryArtistMatches("  ", { artist: "Band" })).toBe(true);
    expect(entryArtistMatches("Band", { artist: null })).toBe(true);
  });
});

describe("trackMatchesEntry and albumMatchesEntry", () => {
  const track = node({ title: "Opening", album: "Record", artist: "Band", durationSecs: 199 });

  it("a track matches on title, album, artist and a length within two seconds", () => {
    expect(trackMatchesEntry(track, A.metadata)).toBe(true);
    expect(trackMatchesEntry({ ...track, album: "Other" }, A.metadata)).toBe(false);
    expect(trackMatchesEntry({ ...track, artist: "Someone" }, A.metadata)).toBe(false);
    expect(trackMatchesEntry({ ...track, title: "opening" }, A.metadata)).toBe(false);
  });

  it("tells twin titles on one album apart by length (a reprise)", () => {
    const reprise = { ...track, id: "r", durationSecs: 95 };
    expect(trackMatchesEntry(reprise, A.metadata)).toBe(false);
  });

  it("does not hold an unknown album or length against a track", () => {
    expect(trackMatchesEntry({ ...track, album: null, durationSecs: null }, A.metadata)).toBe(true);
    expect(
      trackMatchesEntry(track, { title: "Opening", album: null, artist: null, duration: null }),
    ).toBe(true);
    expect(trackMatchesEntry(track, null)).toBe(false);
  });

  it("an album owns an entry by its title and artist identity", () => {
    const album = node({ title: "Record", artist: "Band", isContainer: true });
    expect(albumMatchesEntry(album, A.metadata)).toBe(true);
    expect(albumMatchesEntry({ ...album, artist: "Another Band" }, A.metadata)).toBe(false);
    expect(
      albumMatchesEntry(album, { title: "Opening", album: null, artist: null, duration: null }),
    ).toBe(false);
  });
});
