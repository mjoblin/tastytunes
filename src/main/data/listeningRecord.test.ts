import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { ListeningEvent } from "@shared/model";
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

describe("a recall that loaded nothing claims nothing (0.13.0-rc.6)", () => {
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

describe("a play's time is the music's, never the clock's", () => {
  const track = (queueId: number, title: string, duration: number): ZonePlayState =>
    ({
      state: "play",
      queue_id: queueId,
      metadata: {
        class: "md.track.library",
        source: "MEDIA_PLAYER",
        title,
        artist: "Glass Orchard",
        album: "Paper Moons",
        duration,
      },
    }) as ZonePlayState;
  const appended = (run: () => void): ListeningEvent[] => {
    const seen: ListeningEvent[] = [];
    listeningRecord.setEventNotifier((e) => seen.push(e));
    vi.useFakeTimers();
    try {
      run();
    } finally {
      vi.useRealTimers();
    }
    return seen;
  };

  const station = (name: string, state = "play"): ZonePlayState =>
    ({
      state,
      queue_id: null,
      metadata: { class: "md.radio", source: "IR", station: name, title: null },
    }) as unknown as ZonePlayState;

  it("counts a library track the computer slept through as its length, the album playing on", () => {
    const seen = appended(() => {
      listeningRecord.onPlayState(track(8100001, "Lantern Hours", 300), "Media Library", EVO);
      vi.advanceTimersByTime(120_000);
      listeningRecord.noteSleep();
      vi.advanceTimersByTime(10 * 3600_000);
      listeningRecord.flush();
    });
    expect(seen.at(-1)).toMatchObject({ title: "Lantern Hours", playedSeconds: 300 });
  });

  it("counts the sleep for a station still playing after the wake, a lost connection between", () => {
    const seen = appended(() => {
      listeningRecord.onPlayState(station("Harbor FM"), "Internet Radio", EVO);
      vi.advanceTimersByTime(600_000);
      listeningRecord.noteSleep();
      vi.advanceTimersByTime(3600_000);
      // the wake finds the socket gone: the session waits for the streamer's word
      listeningRecord.flush();
      vi.advanceTimersByTime(5_000);
      listeningRecord.onPlayState(station("Harbor FM"), "Internet Radio", EVO);
      vi.advanceTimersByTime(60_000);
      listeningRecord.flush();
    });
    const sessions = seen.filter((e) => e.kind === "radio-session");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ station: "Harbor FM", playedSeconds: 600 + 3600 + 5 + 60 });
  });

  it("ends a station's session where the sleep began when the wake finds it gone", () => {
    const seen = appended(() => {
      listeningRecord.onPlayState(station("Harbor FM"), "Internet Radio", EVO);
      vi.advanceTimersByTime(600_000);
      listeningRecord.noteSleep();
      vi.advanceTimersByTime(3600_000);
      listeningRecord.onPlayState(station("Harbor FM", "stop"), "Internet Radio", EVO);
    });
    expect(seen.filter((e) => e.kind === "radio-session").at(-1)).toMatchObject({
      playedSeconds: 600,
    });
  });

  it("ends it at the first sleep when the computer slept again before the streamer said", () => {
    const seen = appended(() => {
      listeningRecord.onPlayState(station("Harbor FM"), "Internet Radio", EVO);
      vi.advanceTimersByTime(600_000);
      listeningRecord.noteSleep();
      vi.advanceTimersByTime(3600_000);
      // a short wake with no play push, then asleep again until the morning
      listeningRecord.noteSleep();
      vi.advanceTimersByTime(6 * 3600_000);
      listeningRecord.onPlayState(station("Harbor FM", "stop"), "Internet Radio", EVO);
    });
    expect(seen.filter((e) => e.kind === "radio-session").at(-1)).toMatchObject({
      playedSeconds: 600,
    });
  });

  it("ends it at the sleep when the app quits before the streamer says", () => {
    const seen = appended(() => {
      listeningRecord.onPlayState(station("Tide Radio"), "Internet Radio", EVO);
      vi.advanceTimersByTime(300_000);
      listeningRecord.noteSleep();
      vi.advanceTimersByTime(3600_000);
      listeningRecord.flush();
      listeningRecord.flush({ quitting: true });
    });
    expect(seen.filter((e) => e.kind === "radio-session").at(-1)).toMatchObject({
      station: "Tide Radio",
      playedSeconds: 300,
    });
  });

  it("counts a play left open long past its track as the track's length", () => {
    const seen = appended(() => {
      listeningRecord.onPlayState(track(8100002, "Tin Weather", 300), "Media Library", EVO);
      vi.advanceTimersByTime(5 * 3600_000);
      listeningRecord.flush();
    });
    expect(seen.at(-1)).toMatchObject({ title: "Tin Weather", playedSeconds: 300 });
  });

  it("keeps a play that ran a little past its length as it ran", () => {
    const seen = appended(() => {
      listeningRecord.onPlayState(track(8100003, "Small Hours", 300), "Media Library", EVO);
      vi.advanceTimersByTime(320_000);
      listeningRecord.flush();
    });
    expect(seen.at(-1)).toMatchObject({ title: "Small Hours", playedSeconds: 320 });
  });

  it("reads a line written before the bound as its track's length, leaving others as written", () => {
    const dir = join(app.getPath("userData"), "history");
    mkdirSync(dir, { recursive: true });
    const line = (kind: string, played: number, duration: number | null): string =>
      JSON.stringify({
        v: 1,
        at: Date.UTC(2041, 2, 3),
        tzOffsetMin: 0,
        kind,
        title: "Tin Weather",
        artist: "Glass Orchard",
        album: "Paper Moons",
        duration,
        playedSeconds: played,
      });
    writeFileSync(
      join(dir, "2041.jsonl"),
      [
        line("play", 224109, 376),
        line("play", 400, 376),
        line("play", 900, null),
        line("external", 5000, 376),
      ].join("\n") + "\n",
    );
    expect(
      listeningRecord
        .readYear(2041)
        .events.map((e) => ("playedSeconds" in e ? e.playedSeconds : null)),
    ).toEqual([376, 400, 900, 5000]);
  });
});

describe("a year past the argument limit reads whole", () => {
  it("reads 150,000 lines of one year, as the record and an agent read them", async () => {
    const dir = join(app.getPath("userData"), "history");
    mkdirSync(dir, { recursive: true });
    const at = Date.UTC(2043, 0, 1);
    const line = (i: number): string =>
      `{"v":1,"at":${at + i},"tzOffsetMin":0,"kind":"radio-track","station":"Harbor FM","title":"T${i}"}`;
    writeFileSync(
      join(dir, "2043.jsonl"),
      Array.from({ length: 150_000 }, (_, i) => line(i)).join("\n") + "\n",
    );
    const { events } = await listeningRecord.readAll();
    expect(events.filter((e) => e.at >= at && e.at < at + 150_000)).toHaveLength(150_000);
  });
});

describe("a later version's lines are counted apart, never as plays", () => {
  it("reads a known kind at version 1, and leaves an unknown kind or a later version uncounted", () => {
    const dir = join(app.getPath("userData"), "history");
    mkdirSync(dir, { recursive: true });
    const at = Date.UTC(2044, 0, 1);
    const line = (extra: Record<string, unknown>): string =>
      JSON.stringify({
        v: 1,
        at,
        tzOffsetMin: 0,
        kind: "play",
        title: "Tin Weather",
        playedSeconds: 200,
        duration: 300,
        ...extra,
      });
    writeFileSync(
      join(dir, "2044.jsonl"),
      [line({}), line({ kind: "stop" }), line({ v: 2 }), line({ at: at + 1 })].join("\n") + "\n",
    );
    const year = listeningRecord.readYear(2044);
    expect(year.events.map((e) => e.kind)).toEqual(["play", "play"]);
    expect(year.unreadable).toBe(0);
  });
});
