import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type MediaNode } from "@shared/model";
import type { ResumeOffer, Target, ToolContext } from "./toolkit";

// resume_album over a stand-in context: the window's streamer disconnected, another streamer
// reached by the device argument, and the media server's browse and the index's revalidation
// recording which streamer they went through.
const through = vi.hoisted(() => ({ browsed: [] as string[], revalidated: [] as string[] }));
const tracks = vi.hoisted(() => [] as MediaNode[]);
vi.mock("../../data/persist", () => ({ getSettings: () => DEFAULT_SETTINGS }));
vi.mock("../../media/upnpBrowser", () => ({
  browseChildrenOf: (host: string) => {
    through.browsed.push(host);
    return Promise.resolve(tracks);
  },
  presetSave: async () => {},
}));
vi.mock("../../media/mediaIndex", () => ({
  pools: () => [],
  revalidate: (host: string) => {
    through.revalidated.push(host);
    return Promise.resolve(false);
  },
}));
vi.mock("../../media/resolveContent", () => ({ indexFinder: () => () => null }));

const { editTools } = await import("./editTools");

const node = (over: Partial<MediaNode>): MediaNode => ({
  id: "x",
  parentId: null,
  title: "x",
  upnpClass: "object.item.audioItem.musicTrack",
  isContainer: false,
  artUrl: null,
  artist: "The Cure",
  album: "Disintegration",
  year: null,
  trackNumber: null,
  durationSecs: 300,
  ...over,
});
tracks.push(
  node({ id: "t1", title: "Plainsong", trackNumber: 1 }),
  node({ id: "t2", title: "Pictures of You", trackNumber: 2 }),
  node({ id: "t3", title: "Closedown", trackNumber: 3 }),
);
const album = node({
  id: "album-1",
  title: "Disintegration",
  isContainer: true,
  upnpClass: "object.container.album.musicAlbum",
  serverUdn: "uuid:nas",
});
// the run stopped after a listen of track 2, so it resumes from track 3
const offer = {
  run: {
    album: "Disintegration",
    artist: "The Cure",
    plays: [],
    last: { title: "Pictures of You" },
    lastListened: true,
  },
  node: album,
  target: tracks[2],
  position: 3,
  total: 3,
} as unknown as ResumeOffer;

function kitchen() {
  return {
    window: false,
    host: "10.0.0.9",
    name: "Kitchen",
    ensureAwake: vi.fn(async () => {}),
    queueAdd: vi.fn(async () => {}),
  };
}

function context(other: ReturnType<typeof kitchen>): ToolContext {
  const disconnected = new Error("Not connected to a streamer.");
  return {
    dm: {} as ToolContext["dm"],
    connected: () => {
      throw disconnected;
    },
    target: (device) =>
      device === "Kitchen"
        ? Promise.resolve(other as unknown as Target)
        : Promise.reject(disconnected),
    kickIndex: () => "",
    resumeOffer: () => Promise.resolve(offer),
    mutateSchedules: () => {},
    saveSettings: () => DEFAULT_SETTINGS,
    sendCommand: () => {},
    displayModeOn: () => false,
    windowOpen: () => false,
  };
}

describe("resume_album on another streamer", () => {
  it("browses and resumes through the streamer named, with the window's disconnected", async () => {
    const other = kitchen();
    const r = await editTools(context(other))["resume_album"].handler({ device: "Kitchen" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]).toEqual({
      type: "text",
      text: 'Resuming "Disintegration" from track 3, "Closedown".',
    });
    expect(other.ensureAwake).toHaveBeenCalled();
    expect(through.revalidated).toEqual(["10.0.0.9"]);
    expect(through.browsed).toEqual(["10.0.0.9"]);
    expect(other.queueAdd).toHaveBeenCalledWith("uuid:nas", "album-1", "PLAY_FROM_HERE", "t3");
  });
});
