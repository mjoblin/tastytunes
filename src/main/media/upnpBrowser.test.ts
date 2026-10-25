import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeStreamer, type FakeStreamer } from "./__fixtures__/fakeStreamer";
import { refreshServers, search } from "./upnpBrowser";

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
