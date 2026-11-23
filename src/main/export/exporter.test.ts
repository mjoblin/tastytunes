import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AudioAnalysis,
  ListeningPlayEvent,
  MediaIndexPools,
  MediaNode,
  Playlist,
} from "@shared/model";
import { featuresToStored, onsetsToStored, stripToStored } from "@shared/analysisCodec";
import { exportAlbum, exportTrack, type ExportEnv, type ExportOptions } from "./exporter";

const UDN = "uuid:server-1";

function node(over: Partial<MediaNode> & { id: string; title: string }): MediaNode {
  return {
    parentId: null,
    upnpClass: "object.item.audioItem.musicTrack",
    isContainer: false,
    artUrl: "http://10.0.0.5:9790/aa/1/cover.jpg",
    artist: "Dusk Parade",
    album: "Harbour Lights",
    year: "2019",
    trackNumber: 1,
    durationSecs: 90,
    format: { codec: "FLAC", bits: 16, rate: 44100, kbps: 900, sizeBytes: 10_000_000, channels: 2 },
    ...over,
  };
}

const album: MediaNode = {
  ...node({ id: "al-1", title: "Harbour Lights" }),
  upnpClass: "object.container.album.musicAlbum",
  isContainer: true,
  album: null,
  trackNumber: null,
  durationSecs: null,
  format: undefined,
};
const other: MediaNode = {
  ...album,
  id: "al-2",
  title: "Low Tide",
  year: "2016",
  artUrl: "http://10.0.0.5:9790/aa/2/cover.jpg",
};
const t1 = node({ id: "t-1", title: "Lamplighter", trackNumber: 1 });
const t2 = node({ id: "t-2", title: "Undertow", trackNumber: 2 });
const t3 = node({ id: "t-3", title: "Breakwater", trackNumber: 3 });

const pools: MediaIndexPools[] = [
  {
    udn: UDN,
    serverName: "Shelf NAS",
    albums: [album, other],
    artists: [],
    tracks: [t1, t2, t3],
  },
];

function analyzed(): AudioAnalysis {
  const frames = 900;
  return {
    dr: 11,
    peakDb: -0.3,
    rmsDb: -14,
    crestDb: 13.7,
    lufs: -12.4,
    lra: 6.1,
    truePeakDb: -0.2,
    peakQ: Array.from({ length: 1200 }, () => 800),
    rmsQ: Array.from({ length: 1200 }, () => 300),
    strip: stripToStored({
      fps: 10,
      bands: new Uint8Array(frames * 6).fill(120),
      loud: Uint8Array.from({ length: frames }, (_, i) => (i >= 600 && i < 610 ? 250 : 140)),
    }),
    onsets: onsetsToStored({
      at: Float32Array.from([1, 2, 3]),
      strength: Float32Array.from([1, 0.5, 0.25]),
      type: Uint8Array.from([0, 1, 2]),
    }),
    features: featuresToStored({
      beats: { bpm: 120, confidence: 0.9, downbeat: 0, times: Float32Array.from([0.5, 1, 1.5]) },
      sections: {
        bounds: Float32Array.from([30, 60]),
        kinds: Uint8Array.from([0, 1, 0]),
        energy: Float32Array.from([0.3, 0.9, 0.4]),
      },
      chroma: null,
      key: { tonic: 9, mode: "minor", confidence: 0.8 },
      changes: Float32Array.from([4, 8]),
      stereo: null,
      timbre: null,
      silences: Float32Array.from([88, 90]),
      drops: {
        buildFrom: Float32Array.from([52]),
        at: Float32Array.from([60]),
        strength: Float32Array.from([0.7]),
        chill: Float32Array.from([1]),
        breath: Float32Array.from([0.5]),
        cut: Float32Array.from([0.1]),
      },
    }),
  };
}

const play = (at: number, secs: number): ListeningPlayEvent => ({
  v: 1,
  at,
  tzOffsetMin: 0,
  kind: "play",
  title: "Lamplighter",
  artist: "Dusk Parade",
  album: "Harbour Lights",
  playedSeconds: secs,
  duration: 90,
  codec: "FLAC",
  sampleRate: 44100,
  bitDepth: 16,
  lossless: true,
  source: "MEDIA_PLAYER",
  sourceId: null,
});

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

interface Calls {
  lyrics: boolean[];
  pictures: string[];
  started: string[];
}

function fakeEnv(
  over: Partial<ExportEnv> = {},
  calls: Calls = { lyrics: [], pictures: [], started: [] },
) {
  const playlists: Playlist[] = [
    {
      id: "p1",
      name: "Night drive",
      createdAt: 0,
      updatedAt: 0,
      items: [
        {
          title: "Lamplighter",
          artist: "Dusk Parade",
          album: "Harbour Lights",
          artUrl: null,
          serverUdn: null,
          serverName: null,
          objectId: null,
        },
      ],
    },
  ];
  let now = 0;
  const env: ExportEnv = {
    pools: () => pools,
    analysis: (n) => (n.id === "t-1" ? analyzed() : null),
    albumMeasured: () => null,
    analysisPossible: () => Promise.resolve({ ok: true }),
    startAnalysis: (_udn, id) => {
      calls.started.push(id);
      return { started: true };
    },
    lyrics: (_n, fill) => {
      calls.lyrics.push(fill);
      return Promise.resolve(
        fill
          ? {
              kind: "found",
              value: {
                plain: "first line\nthe part that comes back",
                synced: "[00:05.00] first line\n[00:35.00] the part that comes back",
                instrumental: false,
              },
            }
          : { kind: "not_asked" },
      );
    },
    credits: (_n, fill) => Promise.resolve(fill ? { kind: "none" } : { kind: "not_asked" }),
    albumNotes: () => Promise.resolve({ kind: "off" }),
    artistNotes: () => Promise.resolve({ kind: "none" }),
    artistPictures: () =>
      Promise.resolve({
        offers: [{ source: "wikipedia", url: "https://upload.wikimedia.org/x.jpg" }],
        gap: null,
      }),
    listeningOn: () => true,
    plays: () => Promise.resolve([play(1_700_000_000_000, 90), play(1_700_100_000_000, 20)]),
    favorites: () => [{ kind: "album", title: "Harbour Lights", artist: "Dusk Parade" } as never],
    playlists: () => playlists,
    presets: () => [{ id: 4, name: "Harbour", artUrl: album.artUrl }],
    picture: (url) => {
      calls.pictures.push(url);
      return Promise.resolve({ bytes: JPEG, type: "image/jpeg" });
    },
    readFile: () => null,
    audioUrl: (_u, id) => Promise.resolve(`http://10.0.0.5:9790/audio/${id}.flac`),
    audioBody: () =>
      Promise.resolve({
        body: new Blob([new Uint8Array(4096)]).stream(),
        bytes: 4096,
      }),
    localTime: (ms) => new Date(ms).toISOString(),
    now: () => new Date(2026, 10, 22, 21, 40),
    clock: () => (now += 1),
    ...over,
  };
  return { env, calls };
}

const opts = (o: Partial<ExportOptions> = {}): ExportOptions => ({
  fill: false,
  redact: false,
  plays: false,
  audio: "link",
  ...o,
});
const target = (n: MediaNode) => ({ node: n, serverUdn: UDN, serverName: "Shelf NAS" });
const root = (): string => mkdtempSync(join(tmpdir(), "tt-export-"));
const readJson = (dir: string, rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, rel), "utf-8")) as Record<string, unknown>;

describe("a track's export", () => {
  it("writes the README, the record, the analysis, the lyrics and the pictures in a dated folder", async () => {
    const { env } = fakeEnv();
    const r = await exportTrack(env, root(), target(t1), opts({ fill: true }));
    expect(r.kind).toBe("exported");
    if (r.kind !== "exported") return;
    expect(r.folder).toMatch(/Dusk Parade - Harbour Lights - Lamplighter \(2026-11-22 2140\)$/);
    const files = r.files.map((f) => f.path).sort();
    expect(files).toEqual(
      expect.arrayContaining([
        "README.md",
        "track.json",
        "analysis.json",
        "lyrics.lrc",
        "lyrics.txt",
        "pictures/sleeve.jpg",
        "pictures/artist-01.jpg",
        "pictures/shelf-01.jpg",
        "pictures/pictures.json",
      ]),
    );
    const track = readJson(r.folder, "track.json");
    expect(track["format"]).toBe("tastytunes.export/1");
    expect((track["measured"] as { key: string }).key).toBe("A minor");
    expect((track["held_by"] as { playlists: string[] }).playlists).toEqual(["Night drive"]);
    expect((track["held_by"] as { album_hearted: boolean }).album_hearted).toBe(true);
    expect(track["presets_holding_album"]).toEqual([{ slot: 4, name: "Harbour" }]);
    const timeline = track["timeline"] as { sections: Array<{ kind: string; lyrics: unknown[] }> };
    expect(timeline.sections[1]).toMatchObject({ kind: "repeated_loud" });
    expect(timeline.sections[1].lyrics).toHaveLength(1);
    const analysis = readJson(r.folder, "analysis.json");
    expect((analysis["onsets"] as { kind: string[] }).kind).toEqual(["kick", "snare", "hat"]);
    expect(JSON.stringify(analysis)).not.toMatch(/"data":|base64/);
    expect(readFileSync(join(r.folder, "lyrics.lrc"), "utf-8")).toContain(
      "[00:35.00] the part that comes back",
    );
    const pictures = readJson(r.folder, "pictures/pictures.json")["pictures"] as Array<{
      what: string;
      album?: string;
    }>;
    expect(pictures.find((p) => p.what === "shelf")?.album).toBe("Low Tide");
  });

  it("asks nothing without fill, and says what wasn't looked up and how to get it", async () => {
    const { env, calls } = fakeEnv();
    const r = await exportTrack(env, root(), target(t1), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(calls.lyrics).toEqual([false]);
    expect(r.missing.find((m) => m.what === "lyrics")).toMatchObject({
      remedy: "Export again with fill: true.",
    });
    expect(r.missing.find((m) => m.what === "album notes")?.why).toMatch(
      /Liner notes is switched off/,
    );
    // the internet picture is listed by address, never fetched, without fill
    const pictures = readJson(r.folder, "pictures/pictures.json")["pictures"] as Array<
      Record<string, unknown>
    >;
    const artist = pictures.find((p) => p["what"] === "artist");
    expect(artist?.["file"]).toBeUndefined();
    expect(artist?.["address"]).toBe("https://upload.wikimedia.org/x.jpg");
  });

  it("redacted, leaves out every address on the owner's network, the ids and the play dates", async () => {
    const { env } = fakeEnv();
    const r = await exportTrack(
      env,
      root(),
      target(t1),
      opts({ fill: true, redact: true, plays: true }),
    );
    if (r.kind !== "exported") throw new Error(r.kind);
    for (const f of r.files.filter((x) => x.path.endsWith(".json"))) {
      const text = readFileSync(join(r.folder, f.path), "utf-8");
      expect(text, f.path).not.toMatch(
        /10\.0\.0\.5|uuid:server-1|"object_id"|"server_name"|first_played|every_play/,
      );
    }
    const listening = readJson(r.folder, "track.json")["listening"] as Record<string, unknown>;
    expect(listening["plays"]).toBe(2);
    expect(readFileSync(join(r.folder, "README.md"), "utf-8")).toMatch(/This export is redacted/);
  });

  it("lists every play only with redact off and plays asked for", async () => {
    const { env } = fakeEnv();
    const plain = await exportTrack(env, root(), target(t1), opts());
    const listed = await exportTrack(env, root(), target(t1), opts({ plays: true }));
    if (plain.kind !== "exported" || listed.kind !== "exported") throw new Error("not exported");
    const l1 = readJson(plain.folder, "track.json")["listening"] as Record<string, unknown>;
    const l2 = readJson(listed.folder, "track.json")["listening"] as Record<string, unknown>;
    expect(l1).toMatchObject({ plays: 2, full_listens: 1 });
    expect(l1["every_play"]).toBeUndefined();
    expect(l2["every_play"]).toHaveLength(2);
  });

  it("with fill, starts an unanalyzed track's analysis and writes nothing yet", async () => {
    const { env, calls } = fakeEnv();
    const dir = root();
    const r = await exportTrack(env, dir, target(t2), opts({ fill: true }));
    expect(r).toMatchObject({ kind: "analyzing" });
    expect(calls.started).toEqual(["al-1"]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("copies the audio in when asked, and leaves it out past the cap", async () => {
    const { env } = fakeEnv();
    const r = await exportTrack(env, root(), target(t1), opts({ audio: "copy" }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(r.files.find((f) => f.path === "audio.flac")?.bytes).toBe(4096);
    expect((readJson(r.folder, "track.json")["audio"] as { file: string }).file).toBe("audio.flac");
  });

  it("keeps a hostile title inside the folder", async () => {
    const evil = node({ id: "t-9", title: "../../../etc/passwd", album: "../..", artist: "..." });
    const { env } = fakeEnv({ pools: () => [{ ...pools[0], tracks: [evil] }] });
    const dir = root();
    const r = await exportTrack(env, dir, target(evil), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(r.folder.startsWith(dir + sep)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("writes one export at a time", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((res) => (release = res));
    const { env } = fakeEnv({
      plays: async () => {
        await slow;
        return [];
      },
    });
    const first = exportTrack(env, root(), target(t1), opts());
    const second = await exportTrack(env, root(), target(t1), opts());
    expect(second).toMatchObject({ kind: "refused" });
    release();
    expect((await first).kind).toBe("exported");
  });
});

describe("an album's export", () => {
  it("writes album.json and a folder per track in running order, the pictures once", async () => {
    const { env } = fakeEnv();
    const r = await exportAlbum(env, root(), target(album), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    const a = readJson(r.folder, "album.json");
    const tracks = a["tracks"] as Array<{ title: string; folder: string; analyzed: boolean }>;
    expect(tracks.map((t) => t.title)).toEqual(["Lamplighter", "Undertow", "Breakwater"]);
    expect(tracks[0]).toMatchObject({ folder: "tracks/01 - Lamplighter", analyzed: true });
    expect(existsSync(join(r.folder, "tracks/02 - Undertow/track.json"))).toBe(true);
    expect(r.files.filter((f) => f.path.endsWith("sleeve.jpg"))).toHaveLength(1);
    // a gap two tracks share is said once with its count
    expect(r.missing.find((m) => m.what.startsWith("analysis"))?.what).toBe(
      "analysis (2 of 3 tracks)",
    );
  });

  it("stops the lookups when the time budget is spent and says how to carry on", async () => {
    let t = 0;
    const { env, calls } = fakeEnv({
      analysis: () => analyzed(),
      clock: () => (t += 30_000),
    });
    const r = await exportAlbum(env, root(), target(album), opts({ fill: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(calls.lyrics).toEqual([true, false, false]);
    expect(r.missing.some((m) => m.what === "lookups for the later tracks")).toBe(true);
  });
});
