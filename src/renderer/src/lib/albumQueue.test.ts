/**
 * The queue as an album to measure while it plays (lib/albumOnPlay): only one album playing from
 * a media server, measured from the next track round to the playing one.
 */
import { describe, expect, it } from "vitest";
import type { QueueList, QueueListItem, ZonePlayState, ZonePlayStateMetadata } from "@shared/smoip";
import { albumQueue } from "./albumQueue";

const entry = (id: number, title: string, album = "Seventh"): QueueListItem => ({
  id,
  position: id - 1,
  metadata: {
    class: null,
    source: null,
    name: null,
    title,
    art_url: null,
    track_number: id,
    duration: 180 + id,
    genre: null,
    album,
    artist: "The Band",
  },
});

const queue = (items: QueueListItem[], playId: number, total = items.length): QueueList => ({
  start: 0,
  count: items.length,
  total,
  play_postition: null,
  play_id: playId,
  items,
});

const playing = (
  queueId: number,
  f: Partial<ZonePlayStateMetadata> = { source: "MEDIA_PLAYER", album: "Seventh" },
): ZonePlayState => ({
  state: "play",
  position: 12,
  presettable: null,
  queue_index: queueId - 1,
  queue_length: null,
  queue_id: queueId,
  mode_repeat: null,
  mode_shuffle: null,
  metadata: {
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
  },
});

const album = [entry(1, "One"), entry(2, "Two"), entry(3, "Three"), entry(4, "Four")];
const titles = (q: ReturnType<typeof albumQueue>): (string | null)[] | null =>
  q ? q.order.map((i) => i.metadata?.title ?? null) : null;

describe("albumQueue", () => {
  it("measures an album from the next track round to the playing one", () => {
    expect(titles(albumQueue(queue(album, 2), playing(2)))).toEqual([
      "Three",
      "Four",
      "One",
      "Two",
    ]);
    expect(titles(albumQueue(queue(album, 1), playing(1)))).toEqual([
      "Two",
      "Three",
      "Four",
      "One",
    ]);
  });

  it("keeps one identity while the album plays on, and a new one for another queue", () => {
    const a = albumQueue(queue(album, 1), playing(1));
    const b = albumQueue(queue(album, 3), playing(3));
    expect(a?.sig).toBe(b?.sig);
    const other = [entry(1, "Uno"), entry(2, "Dos")];
    expect(albumQueue(queue(other, 1), playing(1))?.sig).not.toBe(a?.sig);
  });

  it("is nothing for a playlist or a mixed queue", () => {
    const mixed = [...album.slice(0, 2), entry(3, "Elsewhere", "Another Album")];
    expect(albumQueue(queue(mixed, 1), playing(1))).toBeNull();
  });

  it("is nothing for a single track, a queue held only in part, or nothing playing in it", () => {
    expect(albumQueue(queue([entry(1, "One")], 1), playing(1))).toBeNull();
    expect(albumQueue(queue(album, 1, 40), playing(1))).toBeNull();
    expect(albumQueue(queue(album, 9), playing(9))).toBeNull();
  });

  it("is nothing away from the media player: radio, a cast, a disc", () => {
    expect(
      albumQueue(queue(album, 1), playing(1, { source: "AIRPLAY", album: "Seventh" })),
    ).toBeNull();
    expect(
      albumQueue(queue(album, 1), playing(1, { source: "MEDIA_PLAYER", album: null })),
    ).toBeNull();
  });
});
