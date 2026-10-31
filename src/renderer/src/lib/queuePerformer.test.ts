/**
 * What a queue entry's row, or a saved item's, shows for "artist".
 *
 * The streamer stores a compilation entry under its album artist ("Various
 * Artists") while the index knows each performer; the row shows the performer
 * only when one ready index names exactly one. The shapes are Asset's, live
 * 2026-08-21.
 */
import { describe, expect, it } from "vitest";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import type { QueueListItemMetadata } from "@shared/smoip";
import { performerFor, performerForSaved, trackIndexFor } from "./queuePerformer";

const node: MediaNode = {
  id: "t",
  parentId: "a",
  title: "Down in Splendour",
  upnpClass: "object.item.audioItem.musicTrack",
  isContainer: false,
  artUrl: null,
  artist: "Straitjacket Fits",
  albumArtist: "Various Artists",
  album: "Nature's Best 2",
  year: "2004",
  trackNumber: 102,
  durationSecs: 218,
};

const entry: QueueListItemMetadata = {
  class: "md.track.library",
  source: "MEDIA_PLAYER",
  name: null,
  title: "Down in Splendour",
  art_url: null,
  track_number: 102,
  duration: 218,
  genre: null,
  album: "Nature's Best 2",
  artist: "Various Artists",
};

const pools: MediaIndexPools[] = [
  { udn: "a", serverName: "A", albums: [], artists: [], tracks: [node] },
];

describe("trackIndexFor", () => {
  it("builds one index per pools snapshot and hands the same one back", () => {
    expect(trackIndexFor(pools)).toBe(trackIndexFor(pools));
  });
});

describe("performerFor", () => {
  const idx = trackIndexFor(pools);

  it("shows the performer the index knows for an entry stored under the album artist", () => {
    expect(performerFor(entry, idx)).toBe("Straitjacket Fits");
  });

  it("keeps the device's string for an entry already naming the performer", () => {
    expect(performerFor({ ...entry, artist: "Straitjacket Fits" }, idx)).toBeNull();
  });

  it("keeps the device's string for an unmatched entry (the tag readout's album)", () => {
    expect(performerFor({ ...entry, album: "Nature's Best 2 [Disc 1]" }, idx)).toBeNull();
  });

  it("keeps the device's string when the entry has no artist", () => {
    expect(performerFor({ ...entry, artist: null }, idx)).toBeNull();
  });

  it("keeps the device's string when the indexes disagree on the performer", () => {
    const twoIdx = trackIndexFor([
      ...pools,
      {
        udn: "b",
        serverName: "B",
        albums: [],
        artists: [],
        tracks: [{ ...node, id: "t2", artist: "Tim Finn" }],
      },
    ]);
    expect(performerFor(entry, twoIdx)).toBeNull();
  });
});

describe("performerForSaved", () => {
  const idx = trackIndexFor([
    { udn: "a", serverName: "A", albums: [], artists: [], tracks: [node] },
  ]);

  it("shows the performer for an item saved under the album artist", () => {
    const saved = {
      title: "Down in Splendour",
      artist: "Various Artists",
      album: "Nature's Best 2",
      durationSecs: 218,
    };
    expect(performerForSaved(saved, idx)).toBe("Straitjacket Fits");
  });

  it("keeps the device's string for an item saved as the performer", () => {
    const saved = {
      title: "Down in Splendour",
      artist: "Straitjacket Fits",
      album: "Nature's Best 2",
      durationSecs: 218,
    };
    expect(performerForSaved(saved, idx)).toBeNull();
  });

  it("still matches an item saved with no duration", () => {
    const saved = {
      title: "Down in Splendour",
      artist: "Various Artists",
      album: "Nature's Best 2",
    };
    expect(performerForSaved(saved, idx)).toBe("Straitjacket Fits");
  });
});
