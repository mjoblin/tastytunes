import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeStreamer, type FakeStreamer } from "./__fixtures__/fakeStreamer";
import { refreshServers, search, serversListed } from "./upnpBrowser";

describe("search: the live search on a server that answers 150 at a time", () => {
  let server: FakeStreamer;

  beforeAll(async () => {
    server = await startFakeStreamer({ searchPaged: true });
    await refreshServers(server.host);
  });

  afterAll(() => server.stop());

  it("pages through to the server's total", async () => {
    const before = server.searchCalls;
    const r = await search(server.host, "mock-udn-1", "mock");
    const asked = server.searchCalls - before;
    const artists = r.items.filter((n) => n.isContainer && /person|Artist/.test(n.upnpClass));
    expect(r.items.length).toBe(r.total);
    expect(artists.length).toBeGreaterThan(150);
    expect(asked).toBeGreaterThan(3);
  });
});

describe("serversListed: the server listing in flight, however long it takes", () => {
  it("waits with no cap of its own, and settles when the listing does", async () => {
    const server = await startFakeStreamer({ holdUpnp: true, artists: 4 });
    try {
      const listed = refreshServers(server.host);
      let settled = false;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const waited = serversListed().then(() => {
        settled = true;
      });
      // a minute on the clock: a cap of any length short of it would have answered by now
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      expect(settled).toBe(false);
      server.releaseUpnp();
      expect((await listed).map((s) => s.udn)).toEqual(["mock-udn-1"]);
      await waited;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
      await server.stop();
    }
  });
});
