import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// MusicBrainz's stand-in: a fictional two-disc release, disc 1 of 12 tracks and disc 2 (the one
// in the player) of 10; any other release is a 404. Every release asked for is recorded.
const RELEASE = "c0ffee00-4d15-4c0d-9e11-6a7b0c0d15c2";
const DISC2: Array<[string, number]> = [
  ["Low Tide", 214],
  ["Salt on the Window", 187],
  ["The Lamplighter", 262],
  ["Ferry at Six", 198],
  ["Gulls", 141],
  ["A Long Way Round", 305],
  ["Breakwater", 233],
  ["Harbour Lights", 276],
  ["Mooring", 199],
  ["Last Boat Home", 452],
];
const DISC1 = Array.from({ length: 12 }, (_, i): [string, number] => [
  `First Disc Song ${i + 1}`,
  200 + i * 3,
]);
const asked: string[] = [];
let mb: Server;
// discTracks reads where MusicBrainz is (TASTYTUNES_MB_URL) as it loads, so it loads once the
// stand-in listens
let disc: typeof import("./discTracks");

beforeAll(async () => {
  mb = createServer((req, res) => {
    const m = /^\/ws\/2\/release\/([0-9a-f-]{36})$/.exec(
      new URL(req.url ?? "/", "http://mb").pathname,
    );
    if (!m) {
      res.writeHead(404);
      res.end();
      return;
    }
    asked.push(m[1]);
    if (m[1] !== RELEASE) {
      res.writeHead(404);
      res.end();
      return;
    }
    const medium = (position: number, tracks: Array<[string, number]>) => ({
      position,
      format: "CD",
      "track-count": tracks.length,
      tracks: tracks.map(([title, secs], i) => ({
        position: i + 1,
        number: String(i + 1),
        title,
        length: secs * 1000,
      })),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: RELEASE,
        title: "Harbour Lights",
        media: [medium(1, DISC1), medium(2, DISC2)],
      }),
    );
  });
  await new Promise<void>((resolve) => mb.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("TASTYTUNES_MB_URL", `http://127.0.0.1:${(mb.address() as AddressInfo).port}`);
  disc = await import("./discTracks");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => mb.close(resolve));
});

describe("fetchDiscTracks", () => {
  it("names the disc of a two-disc release by its track count, asking once for the release", async () => {
    const disc2 = await disc.fetchDiscTracks("C0FFEE00-4D15-4C0D-9E11-6A7B0C0D15C2", 10, 2467);
    const disc1 = await disc.fetchDiscTracks(RELEASE, 12, null);
    const none = await disc.fetchDiscTracks(RELEASE, 11, null);
    expect(disc2?.tracks.length).toBe(10);
    expect(disc2?.tracks[0].title).toBe("Low Tide");
    expect(disc2?.tracks[0].n).toBe(1);
    expect(disc2?.tracks[9].title).toBe("Last Boat Home");
    expect(disc2?.tracks[9].secs).toBe(452);
    expect(disc1?.tracks[0]?.title).toBe("First Disc Song 1");
    expect(none).toBeNull();
    expect(asked.length).toBe(1);
  });

  it("answers a release MusicBrainz lacks as a miss, asked once", async () => {
    const before = asked.length;
    const missing = await disc.fetchDiscTracks("00000000-0000-4000-8000-000000000000", 10, null);
    const again = await disc.fetchDiscTracks("00000000-0000-4000-8000-000000000000", 10, null);
    expect(missing).toBeNull();
    expect(again).toBeNull();
    expect(asked.length - before).toBe(1);
  });
});

describe("pickMedium", () => {
  const media = [
    { format: "Vinyl", tracks: [{ n: 1, title: "a", secs: 100 }] },
    { format: "CD", tracks: [{ n: 1, title: "b", secs: 300 }] },
    { format: "CD", tracks: [{ n: 1, title: "c", secs: 120 }] },
  ];

  it("takes the nearest length among media of the disc's count, then a CD", () => {
    expect(disc.pickMedium(media, 1, 290)?.tracks[0].title).toBe("b");
    expect(disc.pickMedium(media, 1, null)?.tracks[0].title).toBe("b");
  });

  it("gives no answer for a count nobody has, and an unknown count takes a lone medium only", () => {
    expect(disc.pickMedium(media, 2, null)).toBeNull();
    expect(disc.pickMedium(media, null, null)).toBeNull();
    expect(disc.pickMedium([media[0]], null, null)?.tracks[0].title).toBe("a");
  });
});
