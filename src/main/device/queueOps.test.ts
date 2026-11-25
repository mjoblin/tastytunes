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
const actions: string[] = [];
let afterAdd: () => void = () => {};
const marked: string[][] = [];
vi.mock("../media/upnpBrowser", () => ({
  queueAdd: vi.fn((host: string, _udn: string, objectId: string, action: string) => {
    added.push({ host, objectId });
    actions.push(action);
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

function engine(
  start: FakeSocket,
  queued = 0,
): {
  ops: InstanceType<typeof QueueOps>;
  set(s: FakeSocket | null): void;
} {
  let socket: FakeSocket | null = start;
  const ops = new QueueOps({
    host: () => socket?.host ?? null,
    socket: () => socket as never,
    queue: () => ({ total: queued }) as never,
    push: () => {},
    ensureAwake: () => Promise.resolve(),
  });
  return { ops, set: (s) => (socket = s) };
}

beforeEach(() => {
  added.length = 0;
  actions.length = 0;
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

describe("a list of tracks on the same batch", () => {
  const three = [item("one"), item("two"), item("three")];
  const ids = (): string[] => added.map((a) => a.objectId);

  it("replaces with the first and appends the rest, saying how long the queue it replaced was", async () => {
    const { ops } = engine(socketFor("10.0.0.5"), 17);
    const res = await ops.queueTracks(three, "replace");
    expect(ids()).toEqual(["id-one", "id-two", "id-three"]);
    expect(actions).toEqual(["REPLACE", "APPEND", "APPEND"]);
    expect(res).toEqual({ added: 3, missed: [], total: 3, replaced: 17 });
  });

  it("leaves the list in its order after the playing track, whatever the verb", async () => {
    const { ops } = engine(socketFor("10.0.0.5"));
    await ops.queueTracks(three, "play_next");
    // each PLAY_NEXT lands right after the playing track, so the list goes in reversed
    expect(ids()).toEqual(["id-three", "id-two", "id-one"]);
    expect(actions).toEqual(["PLAY_NEXT", "PLAY_NEXT", "PLAY_NEXT"]);
    added.length = 0;
    actions.length = 0;
    const res = await ops.queueTracks(three, "play_now");
    // the rest go in as next, reversed, and the first last, played now: one, two, three
    expect(ids()).toEqual(["id-three", "id-two", "id-one"]);
    expect(actions).toEqual(["PLAY_NEXT", "PLAY_NEXT", "PLAY_NOW"]);
    expect(res.replaced).toBeNull();
  });

  it("names what it couldn't add, in the list's order", async () => {
    const { ops, set } = engine(socketFor("10.0.0.5"));
    afterAdd = () => set(socketFor("10.0.0.9"));
    const res = await ops.queueTracks(three, "append");
    expect(res).toEqual({ added: 1, missed: ["two", "three"], total: 3, replaced: null });
  });

  it("holds the one-run claim with a playlist load", async () => {
    const { ops } = engine(socketFor("10.0.0.5"));
    const loading = ops.playlistActivate("p1");
    await expect(ops.queueTracks(three, "append")).rejects.toThrow(/Already loading “Evening”/);
    await loading;
    expect((await ops.queueTracks(three, "append")).added).toBe(3);
  });
});
