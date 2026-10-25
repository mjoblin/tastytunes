import { describe, expect, it } from "vitest";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import { prefetchOrder } from "./artistPrefetch";

const play = (artist: unknown, kind = "play"): { kind: string; artist?: unknown } => ({
  kind,
  artist,
});

const node = (over: Partial<MediaNode>): MediaNode => ({
  id: over.title ?? "x",
  parentId: "music",
  title: "x",
  upnpClass: "object.item.audioItem.musicTrack",
  isContainer: false,
  artUrl: null,
  artist: null,
  album: null,
  year: null,
  trackNumber: null,
  durationSecs: null,
  serverUdn: "uuid:nas",
  ...over,
});
const album = (title: string, artist: string): MediaNode =>
  node({ title, artist, isContainer: true, upnpClass: "object.container.album.musicAlbum" });
const track = (title: string, artist: string, extra: string[] = []): MediaNode =>
  node({ title, artist, ...(extra.length ? { artists: [artist, ...extra] } : {}) });
const pools = (
  albums: MediaNode[],
  tracks: MediaNode[],
  artists: MediaNode[] = [],
): MediaIndexPools[] => [{ udn: "uuid:nas", serverName: "NAS", albums, tracks, artists }];

describe("the artists fetched ahead", () => {
  it("are the most-played first, by library plays, each as spelled most", () => {
    const events = [
      ...Array.from({ length: 3 }, () => play("The Cure")),
      ...Array.from({ length: 5 }, () => play("Low")),
      play("the cure"),
      play("The Cure"),
      // a radio session and a play with no artist count for nobody
      play("Radio Artist", "radio-session"),
      play(null),
      play("  "),
    ];
    expect(prefetchOrder(events, [])).toEqual(["The Cure", "Low"]);
  });

  it("then every other artist in the libraries, the ones with the most there first, each once", () => {
    const p = pools(
      [album("A1", "Big Band"), album("A2", "Big Band"), album("S1", "Small Act")],
      [track("t1", "Big Band"), track("t2", "Small Act", ["Guest Singer"]), track("t3", "Low")],
      [
        node({
          title: "Only Listed",
          isContainer: true,
          upnpClass: "object.container.person.musicArtist",
        }),
      ],
    );
    expect(prefetchOrder([play("LOW")], p)).toEqual([
      "LOW",
      "Big Band",
      "Small Act",
      "Guest Singer",
      "Only Listed",
    ]);
  });
});
