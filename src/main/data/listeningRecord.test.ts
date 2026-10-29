import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { describe, expect, it } from "vitest";
import type { ZonePlayState } from "@shared/smoip";
import { listeningRecord } from "./listeningRecord";

const EVO = "4e2b3cfa";
// the fields the record reads; a push carries more
const play = (queueId: number, title: string): ZonePlayState =>
  ({
    state: "play",
    queue_id: queueId,
    metadata: {
      class: "md.track.library",
      source: "MEDIA_PLAYER",
      title,
      artist: "For Those I Love",
      album: "Carving The Stone",
    },
  }) as ZonePlayState;
const recall = (id: number, name: string): void =>
  listeningRecord.openContext({ kind: "preset", id, name, streamer: EVO });

describe("a recall that loaded nothing claims nothing (his preset 24, 0.13.0-rc.6)", () => {
  it("leaves the next track of the queue already playing to the preset that loaded it", () => {
    // preset 30 loads its album, and its first track plays
    recall(30, "Carving The Stone");
    listeningRecord.onQueue([2940320, 6955616, 6385328]);
    listeningRecord.onPlayState(play(2940320, "Carving The Stone"), "Media Library", EVO);
    expect(listeningRecord.currentVia()).toMatchObject({ kind: "preset", id: 30 });
    // preset 24 is accepted and loads nothing; the album's next track starts
    recall(24, "Manning Fireworks");
    listeningRecord.onPlayState(play(6955616, "No Quiet"), "Media Library", EVO);
    expect(listeningRecord.currentVia()).toMatchObject({ kind: "preset", id: 30 });
  });

  it("still credits a recall that loads its queue", () => {
    recall(11, "Only God Was Above Us");
    listeningRecord.onQueue([7000001, 7000002]);
    listeningRecord.onPlayState(play(7000001, "Ice Cream Piano"), "Media Library", EVO);
    expect(listeningRecord.currentVia()).toMatchObject({ kind: "preset", id: 11 });
  });
});

describe("presetLastAlbum: what a preset slot last played", () => {
  it("names the slot's album, passing over a play credited to it wrongly", async () => {
    const dir = join(app.getPath("userData"), "history");
    mkdirSync(dir, { recursive: true });
    const via = { kind: "preset", id: 24, name: "Manning Fireworks", streamer: EVO };
    const line = (at: number, title: string, artist: string, album: string): string =>
      JSON.stringify({
        v: 1,
        at,
        tzOffsetMin: 420,
        kind: "play",
        title,
        artist,
        album,
        duration: 200,
        codec: "FLAC",
        sampleRate: 96000,
        bitDepth: 24,
        lossless: true,
        source: "Media Library",
        sourceId: "MEDIA_PLAYER",
        streamer: EVO,
        playedSeconds: 200,
        via,
      });
    writeFileSync(
      join(dir, "2025.jsonl"),
      [
        line(Date.UTC(2025, 8, 14), "Wristwatch", "MJ Lenderman", "Manning Fireworks"),
        // credited to the slot by a recall that loaded nothing: another album
        line(Date.UTC(2025, 9, 28), "No Quiet", "For Those I Love", "Carving The Stone"),
      ].join("\n") + "\n",
    );
    expect(await listeningRecord.presetLastAlbum(EVO, 24)).toEqual({
      album: "Manning Fireworks",
      artist: "MJ Lenderman",
      artUrl: null,
    });
    expect(await listeningRecord.presetLastAlbum(EVO, 25)).toBeNull();
    expect(await listeningRecord.presetLastAlbum("another-streamer", 24)).toBeNull();
  });
});
