import { describe, expect, it } from "vitest";
import type { MediaNode } from "@shared/model";
import { inRunningOrder } from "./searchOrder";

const track = (title: string, album: string, n: number | null, disc?: number): MediaNode => ({
  id: `${album}-${title}`,
  parentId: null,
  title,
  upnpClass: "object.item.audioItem.musicTrack",
  isContainer: false,
  artUrl: null,
  artist: "Band",
  album,
  year: null,
  trackNumber: n,
  durationSecs: null,
  serverUdn: "s1",
  ...(disc != null ? { discNumber: disc } : {}),
});
const album: MediaNode = {
  ...track("Night", "Night", null),
  id: "alb-night",
  upnpClass: "object.container.album.musicAlbum",
  isContainer: true,
};

describe("inRunningOrder: search results' tracks", () => {
  it("puts an album's tracks in running order, the albums as they first appear, the rest in place", () => {
    const list = [
      album,
      track("All Alone", "Night", 10),
      track("Zeta", "Day", 2),
      track("Derecho", "Night", 2),
      track("Alpha", "Day", 1),
      track("Dollar", "Night", 7),
    ];
    expect(inRunningOrder(list).map((n) => n.title)).toEqual([
      "Night",
      "Derecho",
      "Dollar",
      "All Alone",
      "Alpha",
      "Zeta",
    ]);
  });

  it("orders by disc before position, a track with no number last on its disc", () => {
    const list = [track("B", "Box", 1, 2), track("C", "Box", null, 1), track("A", "Box", 3, 1)];
    expect(inRunningOrder(list).map((n) => n.title)).toEqual(["A", "C", "B"]);
  });
});
