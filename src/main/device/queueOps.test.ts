import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Playlist, PlaylistItem } from "@shared/model";

// A playlist load belongs to the streamer it started on: switched to another, or disconnected, it
// stops there rather than adding the rest of the playlist to a streamer no longer chosen.
const item = (title: string): PlaylistItem => ({
  title,
  artist: "The Mock Artists",
  album: "Amber Nights",
  artUrl: null,
  serverUdn: "uuid:server",
  serverName: "Server",
  objectId: `id-${title}`,
});
const playlist: Playlist = {
  id: "p1",
  name: "Evening",
  createdAt: 0,
  updatedAt: 0,
  items: [item("one"), item("two"), item("three")],
};

const added: Array<{ host: string; objectId: string }> = [];
let afterAdd: () => void = () => {};
const marked: string[][] = [];
vi.mock("../media/upnpBrowser", () => ({
  queueAdd: vi.fn((host: string, _udn: string, objectId: string) => {
    added.push({ host, objectId });
    afterAdd();
    return Promise.resolve();
  }),
}));
vi.mock("../media/resolveContent", () => ({ resolveContent: vi.fn(() => Promise.resolve(null)) }));
vi.mock("../data/playlists", () => ({
  getPlaylists: () => [playlist],
  healPlaylistItem: vi.fn(),
  markPlaylistPlayed: (_id: string, missing: string[]) => {
    marked.push(missing);
    return [playlist];
  },
}));
vi.mock("../data/listeningRecord", () => ({
  listeningRecord: { openContext: vi.fn(), releaseContextBinding: vi.fn(), endContext: vi.fn() },
}));
vi.mock("./smoipHttp", () => ({}));
const { QueueOps } = await import("./queueOps");

type FakeSocket = { host: string; suppressQueueRefetch: boolean; send(): void };
const socketFor = (host: string): FakeSocket => ({ host, suppressQueueRefetch: false, send() {} });

function engine(start: FakeSocket): {
  ops: InstanceType<typeof QueueOps>;
  set(s: FakeSocket | null): void;
} {
  let socket: FakeSocket | null = start;
  const ops = new QueueOps({
    host: () => socket?.host ?? null,
    socket: () => socket as never,
    queue: () => null,
    push: () => {},
    ensureAwake: () => Promise.resolve(),
  });
  return { ops, set: (s) => (socket = s) };
}

beforeEach(() => {
  added.length = 0;
  marked.length = 0;
  afterAdd = () => {};
});

describe("a playlist load and its streamer", () => {
  it("adds every entry while the streamer stays the same, a reconnect included", async () => {
    const { ops, set } = engine(socketFor("10.0.0.5"));
    // a reconnect to the same streamer: a new socket object, the same host
    afterAdd = () => set(socketFor("10.0.0.5"));
    const run = await ops.playlistActivate("p1");
    expect(added.map((a) => a.objectId)).toEqual(["id-one", "id-two", "id-three"]);
    expect(run).toMatchObject({ added: 3, cancelled: false, finished: true });
  });

  it("stops when another streamer is chosen, adding nothing to either after the switch", async () => {
    const { ops, set } = engine(socketFor("10.0.0.5"));
    afterAdd = () => set(socketFor("10.0.0.9"));
    const run = await ops.playlistActivate("p1");
    expect(added).toEqual([{ host: "10.0.0.5", objectId: "id-one" }]);
    expect(run).toMatchObject({ added: 1, done: 1, cancelled: true, finished: true, missed: [] });
    // the entries never tried are not marked missing on the playlist
    expect(marked).toEqual([[]]);
  });

  it("stops on a disconnect", async () => {
    const { ops, set } = engine(socketFor("10.0.0.5"));
    afterAdd = () => set(null);
    const run = await ops.playlistActivate("p1");
    expect(added).toHaveLength(1);
    expect(run).toMatchObject({ added: 1, cancelled: true });
  });
});
