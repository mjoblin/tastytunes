import { describe, expect, it } from "vitest";
import {
  type FavoriteMedia,
  type ListeningPlayEvent,
  type MediaNode,
  copiesOf,
  copyMarkOf,
  favoriteKey,
  heartOf,
  copyStat,
  emptyPlayStats,
  foldPlayEvent,
  nodeFacts,
  playFacts,
  sameCopyRow,
} from "./model";

const node = (over: Partial<MediaNode>): MediaNode => ({
  id: over.id ?? "t",
  parentId: null,
  title: "Close Your Eyes",
  upnpClass: "object.item.audioItem.musicTrack",
  isContainer: false,
  artUrl: null,
  artist: "The Artist",
  album: "Songbooks+",
  year: null,
  trackNumber: null,
  durationSecs: null,
  serverUdn: "uuid:nas",
  ...over,
});

let at = 1_700_000_000_000;
const play = (over: Partial<ListeningPlayEvent>): ListeningPlayEvent => ({
  v: 1,
  at: (at += 600_000),
  tzOffsetMin: 0,
  kind: "play",
  title: "Close Your Eyes",
  artist: "The Artist",
  album: "Songbooks+",
  playedSeconds: 200,
  duration: null,
  codec: "FLAC",
  sampleRate: 44100,
  bitDepth: 16,
  lossless: true,
  source: null,
  sourceId: "MEDIA_PLAYER",
  ...over,
});

describe("copiesOf: which copies a play's facts could be", () => {
  const disc2 = node({ id: "d2", durationSecs: 241, trackNumber: 7, discNumber: 2 });
  const disc5 = node({ id: "d5", durationSecs: 263, trackNumber: 3, discNumber: 5 });

  it("tells two takes on one album apart by length, within the slack", () => {
    expect(copiesOf({ secs: 262 }, [disc2, disc5], nodeFacts)).toEqual([disc5]);
    expect(copiesOf({ secs: 240 }, [disc2, disc5], nodeFacts)).toEqual([disc2]);
  });

  it("keeps every copy when the facts say nothing", () => {
    expect(copiesOf({}, [disc2, disc5], nodeFacts)).toEqual([disc2, disc5]);
    expect(copiesOf({ secs: null }, [disc2, disc5], nodeFacts)).toEqual([disc2, disc5]);
  });

  it("sets aside a fact that would rule out every copy (a transcode, a re-rip)", () => {
    expect(copiesOf({ secs: 500 }, [disc2, disc5], nodeFacts)).toEqual([disc2, disc5]);
    const cd = node({ id: "cd", format: { codec: "FLAC", rate: 44100, bits: 16 } });
    const hires = node({ id: "hr", format: { codec: "FLAC", rate: 96000, bits: 24 } });
    // a server that converts everything to 48k: neither rate matches, neither copy is lost
    expect(copiesOf({ rate: 48000, bits: 24 }, [cd, hires], nodeFacts)).toEqual([hires]);
    expect(copiesOf({ rate: 48000 }, [cd, hires], nodeFacts)).toEqual([cd, hires]);
  });

  it("tells a server's copy from the streamer drive's by the picture's host", () => {
    const usb = node({
      id: "u",
      serverUdn: "uuid:evo",
      artUrl: "http://192.168.50.45:8080/a/1.jpg",
    });
    const nas = node({ id: "n", artUrl: "http://192.168.50.10:9790/minimserver/x.jpg" });
    expect(copiesOf({ host: "192.168.50.10" }, [usb, nas], nodeFacts)).toEqual([nas]);
    expect(copiesOf({ host: "192.168.50.45" }, [usb, nas], nodeFacts)).toEqual([usb]);
  });

  it("prefers the picture's own address over everything else", () => {
    const a = node({
      id: "a",
      artUrl: "http://nas:9790/Toto IV (JP)/folder.jpg",
      durationSecs: 330,
    });
    const b = node({
      id: "b",
      artUrl: "http://nas:9790/Toto IV (US)/folder.jpg",
      durationSecs: 330,
    });
    expect(
      copiesOf({ art: "http://nas:9790/Toto IV (US)/folder.jpg", secs: 330 }, [a, b], nodeFacts),
    ).toEqual([b]);
  });
});

describe("sameCopyRow: one track of one copy, seen twice", () => {
  it("is the listing's row and the index's entry, whatever their ids", () => {
    const listing = node({ id: "0$album$7", durationSecs: 241, trackNumber: 7 });
    const index = node({ id: "0$search$99", durationSecs: 241, trackNumber: 7 });
    expect(sameCopyRow(listing, index)).toBe(true);
  });
  it("is not another edition, alike in all but its picture", () => {
    const jp = node({
      durationSecs: 330,
      trackNumber: 1,
      artUrl: "http://nas/Toto IV (JP)/folder.jpg",
    });
    const us = node({
      durationSecs: 330,
      trackNumber: 1,
      artUrl: "http://nas/Toto IV (US)/folder.jpg",
    });
    expect(sameCopyRow(jp, us)).toBe(false);
    expect(sameCopyRow(jp, node({ ...jp, id: "other", artUrl: `${jp.artUrl}?size=160` }))).toBe(
      true,
    );
  });
  it("is not another take or another server's copy", () => {
    const a = node({ durationSecs: 241, trackNumber: 7 });
    expect(sameCopyRow(a, node({ durationSecs: 263, trackNumber: 3 }))).toBe(false);
    expect(sameCopyRow(a, node({ durationSecs: 241, trackNumber: 7, serverUdn: "uuid:evo" }))).toBe(
      false,
    );
  });
});

describe("copyStat: a row's own tally", () => {
  it("splits a past record between two takes by length", () => {
    const stats = emptyPlayStats();
    for (let i = 0; i < 3; i++) foldPlayEvent(stats, play({ duration: 241 }));
    foldPlayEvent(stats, play({ duration: 263 }));
    const disc2 = node({ id: "d2", durationSecs: 241, trackNumber: 7, discNumber: 2 });
    const disc5 = node({ id: "d5", durationSecs: 263, trackNumber: 3, discNumber: 5 });
    expect(copyStat(stats, disc2, [disc2, disc5])?.plays).toBe(3);
    expect(copyStat(stats, disc5, [disc2, disc5])?.plays).toBe(1);
    // alone (no other copy known), a row keeps the whole tally, as before
    expect(copyStat(stats, disc2, [])?.plays).toBe(4);
  });

  it("counts a play it cannot place on every copy", () => {
    const stats = emptyPlayStats();
    foldPlayEvent(stats, play({ duration: null }));
    const disc2 = node({ id: "d2", durationSecs: 241, trackNumber: 7 });
    const disc5 = node({ id: "d5", durationSecs: 263, trackNumber: 3 });
    expect(copyStat(stats, disc2, [disc5])?.plays).toBe(1);
    expect(copyStat(stats, disc5, [disc2])?.plays).toBe(1);
  });

  it("gives a new play to the copy whose picture it showed", () => {
    const stats = emptyPlayStats();
    foldPlayEvent(
      stats,
      play({ duration: 330, artUrl: "http://nas:9790/Toto IV (US)/folder.jpg", artHost: "nas" }),
    );
    const jp = node({
      id: "jp",
      artUrl: "http://nas:9790/Toto IV (JP)/folder.jpg",
      durationSecs: 330,
    });
    const us = node({
      id: "us",
      artUrl: "http://nas:9790/Toto IV (US)/folder.jpg?size=160",
      durationSecs: 330,
      trackNumber: 2,
    });
    expect(copyStat(stats, us, [jp])?.plays).toBe(1);
    expect(copyStat(stats, jp, [us])).toBeNull();
  });

  it("keeps one bucket per set of facts, and the plain tally beside them", () => {
    const stats = emptyPlayStats();
    foldPlayEvent(stats, play({ duration: 241 }));
    foldPlayEvent(stats, play({ duration: 241.4 }));
    foldPlayEvent(stats, play({ duration: 263 }));
    const key = Object.keys(stats.tracks)[0];
    expect(stats.tracks[key].plays).toBe(3);
    expect(stats.variants[key]).toHaveLength(2);
    expect(playFacts(play({ duration: 241, artHost: "nas" }))).toMatchObject({
      secs: 241,
      host: "nas",
    });
  });
});

const album = (over: Partial<MediaNode>): MediaNode =>
  node({
    title: "Toto IV",
    artist: "Toto",
    album: null,
    isContainer: true,
    upnpClass: "object.container.album.musicAlbum",
    ...over,
  });
const heart = (over: Partial<FavoriteMedia>): FavoriteMedia => ({
  kind: "album",
  addedAt: 1,
  title: "Toto IV",
  artist: "Toto",
  album: null,
  artUrl: null,
  serverUdn: null,
  serverName: null,
  objectId: null,
  titlePath: null,
  ...over,
});
const asItem = (n: MediaNode) => ({
  kind: n.isContainer ? ("album" as const) : ("track" as const),
  title: n.title,
  artist: n.artist,
  album: n.isContainer ? null : n.album,
  artUrl: n.artUrl,
  serverUdn: n.serverUdn ?? null,
  durationSecs: n.isContainer ? null : n.durationSecs,
});

describe("heartOf: the heart a copy carries", () => {
  const jp = album({ id: "jp", artUrl: "http://nas/Toto IV (JP)/folder.jpg" });
  const us = album({ id: "us", artUrl: "http://nas/Toto IV (US)/folder.jpg" });
  const usb = album({ id: "u", serverUdn: "uuid:evo", artUrl: "http://192.168.50.45:8080/a.jpg" });
  const library = [jp, us, usb];

  it("lights the copy a heart from before 0.13.0 was made on, and no other", () => {
    const old = heart({ serverUdn: "uuid:nas", objectId: "us", artUrl: us.artUrl });
    expect(heartOf(asItem(us), [old], library)).toBe(old);
    expect(heartOf(asItem(jp), [old], library)).toBeNull();
    expect(heartOf(asItem(usb), [old], library)).toBeNull();
  });

  it("keeps a heart per copy, each lighting its own", () => {
    const a = heart({
      serverUdn: "uuid:nas",
      objectId: "us",
      artUrl: us.artUrl,
      copy: "uuid:nas|us",
    });
    const b = heart({
      serverUdn: "uuid:evo",
      objectId: "u",
      artUrl: usb.artUrl,
      copy: "uuid:evo|u",
    });
    expect(favoriteKey(a)).not.toBe(favoriteKey(b));
    expect(heartOf(asItem(us), [a, b], library)).toBe(a);
    expect(heartOf(asItem(usb), [a, b], library)).toBe(b);
    expect(heartOf(asItem(jp), [a, b], library)).toBeNull();
  });

  it("finds a drive copy's heart after a standby moved its picture", () => {
    const b = heart({ serverUdn: "uuid:evo", artUrl: "http://192.168.50.45:8080/old-mount/a.jpg" });
    expect(heartOf(asItem(usb), [b], library)).toBe(b);
    expect(heartOf(asItem(us), [b], library)).toBeNull();
  });

  it("with no other copy known, lights unless the facts contradict", () => {
    const onNas = heart({ serverUdn: "uuid:nas", artUrl: us.artUrl });
    expect(heartOf(asItem(us), [onNas])).toBe(onNas);
    expect(heartOf(asItem(usb), [onNas])).toBeNull();
    expect(heartOf(asItem(usb), [heart({})])).not.toBeNull();
  });

  it("lights every copy for a heart whose copy has left the library", () => {
    const gone = heart({ serverUdn: "uuid:old-nas", artUrl: "http://old-nas/x.jpg" });
    expect(heartOf(asItem(us), [gone], library)).toBe(gone);
    expect(heartOf(asItem(jp), [gone], library)).toBe(gone);
  });

  it("tells the playing copy's heart by what the streamer says of it", () => {
    const usTrack = node({
      id: "ust",
      title: "Rosanna",
      album: "Toto IV",
      artist: "Toto",
      artUrl: us.artUrl,
      durationSecs: 331,
    });
    const jpTrack = node({
      id: "jpt",
      title: "Rosanna",
      album: "Toto IV",
      artist: "Toto",
      artUrl: jp.artUrl,
      durationSecs: 331,
    });
    const playing = {
      kind: "track" as const,
      title: "Rosanna",
      artist: "Toto",
      album: "Toto IV",
      artUrl: `${jp.artUrl}?size=500`,
      serverUdn: null,
      durationSecs: 331,
    };
    const onJp = heart({
      kind: "track",
      title: "Rosanna",
      album: "Toto IV",
      serverUdn: "uuid:nas",
      objectId: "jpt",
      artUrl: jp.artUrl,
      durationSecs: 331,
    });
    expect(heartOf(playing, [onJp], [usTrack, jpTrack])).toBe(onJp);
    expect(heartOf({ ...playing, artUrl: us.artUrl }, [onJp], [usTrack, jpTrack])).toBeNull();
  });

  it("marks a new heart by its server and item, else by when it was made", () => {
    expect(copyMarkOf({ serverUdn: "uuid:nas", objectId: "us" }, 5)).toBe("uuid:nas|us");
    expect(copyMarkOf({ serverUdn: null, objectId: null }, 5)).toBe("t5");
  });
});
