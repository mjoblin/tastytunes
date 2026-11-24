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
    loudHist: [0, 3, 9, 4],
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
    releaseArt: () => Promise.resolve({ kind: "none" }),
    artistNotes: () => Promise.resolve({ kind: "none" }),
    artistPictures: (_artist, fill) =>
      Promise.resolve({
        offers: [{ source: "wikipedia", url: "https://upload.wikimedia.org/x.jpg", fetch: fill }],
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
    audioUrl: (_u, id) =>
      Promise.resolve({ url: `http://10.0.0.5:9790/audio/${id}.flac`, serverHost: "10.0.0.5" }),
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

describe("a track's export, when things go wrong", () => {
  it("goes ahead for a file measured as far as it can be, and says why it has only a waveform", async () => {
    const { env, calls } = fakeEnv({
      analysis: () => ({
        ...analyzed(),
        dr: 0,
        lufs: null,
        loudHist: null,
        strip: null,
        onsets: null,
        features: null,
      }),
    });
    const r = await exportTrack(env, root(), target(t2), opts({ fill: true }));
    expect(r.kind).toBe("exported");
    expect(calls.started).toEqual([]);
    if (r.kind !== "exported") return;
    expect(r.missing.find((m) => m.what === "analysis")?.why).toMatch(/at its own sample rate/);
  });

  it("answers 'analyzing' once for an unchanged state, then exports and says what was tried", async () => {
    const { env, calls } = fakeEnv({ analysis: () => null });
    const first = await exportTrack(env, root(), target(t3), opts({ fill: true }));
    expect(first.kind).toBe("analyzing");
    const second = await exportTrack(env, root(), target(t3), opts({ fill: true }));
    expect(second.kind).toBe("exported");
    expect(calls.started).toEqual(["al-1"]);
    if (second.kind !== "exported") return;
    expect(second.missing.find((m) => m.what === "analysis")?.why).toMatch(/measured nothing/);
  });

  it("keeps the date and the title of a long name", async () => {
    const long = node({
      id: "t-long",
      title: "The Great Gig in the Sky (Live at the Empire Pool, Wembley, 1974) [Remastered]",
      album: "The Dark Side of the Moon",
    });
    const { env } = fakeEnv({ pools: () => [{ ...pools[0], tracks: [long] }] });
    const r = await exportTrack(env, root(), target(long), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    const name = r.folder.split(sep).at(-1)!;
    expect(name).toMatch(/ \(2026-11-22 2140\)$/);
    expect(name.length).toBeLessThanOrEqual(98);
  });

  it("says a settled none, a record switched off, and what each would need", async () => {
    const { env } = fakeEnv({ listeningOn: () => false });
    const r = await exportTrack(env, root(), target(t1), opts({ fill: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(r.missing.find((m) => m.what === "credits")?.why).toBe(
      "MusicBrainz has no credits for this recording.",
    );
    expect(r.missing.find((m) => m.what === "artist notes")?.why).toBe(
      "MusicBrainz has no such artist.",
    );
    expect(r.missing.find((m) => m.what === "listening")?.why).toMatch(/switched off/);
  });

  it("redacted, takes a picture's own metadata out and says a copied file keeps its tags", async () => {
    const exif = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe1,
      0,
      12,
      ...[..."Exif\0\0home"].map((c) => c.charCodeAt(0)),
      0xff,
      0xda,
      0,
      2,
      1,
      2,
      0xff,
      0xd9,
    ]);
    const { env } = fakeEnv({
      picture: () => Promise.resolve({ bytes: exif, type: "image/jpeg" }),
    });
    const r = await exportTrack(env, root(), target(t1), opts({ redact: true, audio: "copy" }));
    if (r.kind !== "exported") throw new Error(r.kind);
    const sleeve = readFileSync(join(r.folder, "pictures/sleeve.jpg"));
    expect(sleeve.toString("latin1")).not.toContain("Exif");
    const audio = readJson(r.folder, "track.json")["audio"] as { note?: string };
    expect(audio.note).toMatch(/carries its own tags/);
  });

  it("copies audio only as the media server's own answer", async () => {
    const { env } = fakeEnv({
      audioBody: () => Promise.resolve({ why: "The media server sent text/html, not audio." }),
    });
    const r = await exportTrack(env, root(), target(t1), opts({ audio: "copy" }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(r.files.some((f) => f.path.startsWith("audio."))).toBe(false);
    expect(r.left_out.join(" ")).toMatch(/not audio/);
  });

  it("refuses a second export, naming the folder the first is writing", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((res) => (release = res));
    const { env } = fakeEnv({
      artistPictures: async () => {
        await slow;
        return { offers: [], gap: null };
      },
    });
    const first = exportTrack(env, root(), target(t1), opts());
    await new Promise((r) => setTimeout(r, 20));
    const second = await exportTrack(env, root(), target(t1), opts());
    expect(second.kind === "refused" && second.message).toMatch(/into .*Lamplighter/);
    release();
    expect((await first).kind).toBe("exported");
  });
});

describe("the release's scans (the Cover Art Archive step)", () => {
  const RG = "b1392450-e666-3926-a536-22c65f834433";
  const notes = {
    kind: "found" as const,
    value: {
      title: "Harbour Lights",
      year: "2019",
      type: "Album",
      label: null,
      genres: [],
      credits: [],
      summary: null,
      wikipediaUrl: null,
      musicbrainzUrl: `https://musicbrainz.org/release-group/${RG}`,
    },
  };
  const scans = {
    release: "https://musicbrainz.org/release/r-1",
    country: "GB",
    date: "2019-03-01",
    formats: ["CD"],
    tracks: 3,
    images: [
      {
        types: ["Front"],
        comment: null,
        url: "https://coverartarchive.org/release/r-1/1-1200.jpg",
      },
      { types: ["Back"], comment: null, url: "https://coverartarchive.org/release/r-1/2-1200.jpg" },
      {
        types: ["Booklet"],
        comment: "pages 2-3",
        url: "https://coverartarchive.org/release/r-1/3-1200.jpg",
      },
    ],
  };

  it("with fill, copies the chosen release's scans in, each named for what it is", async () => {
    const asked: Array<[string, number | null, boolean]> = [];
    const { env } = fakeEnv({
      analysis: () => analyzed(),
      albumNotes: () => Promise.resolve(notes as never),
      releaseArt: (group, tracks, fill) => {
        asked.push([group, tracks, fill]);
        return Promise.resolve(fill ? { kind: "found", value: scans } : { kind: "not_asked" });
      },
    });
    const r = await exportAlbum(env, root(), target(album), opts({ fill: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(asked).toEqual([[RG, 3, true]]);
    const files = r.files.map((f) => f.path);
    for (const f of [
      "pictures/release-01-front.jpg",
      "pictures/release-02-back.jpg",
      "pictures/release-03-booklet.jpg",
    ])
      expect(files).toContain(f);
    const listed = readJson(r.folder, "pictures/pictures.json")["pictures"] as Array<
      Record<string, unknown>
    >;
    expect(listed.filter((p) => p["what"] === "release")[2]).toMatchObject({
      types: ["Booklet"],
      comment: "pages 2-3",
      release: "https://musicbrainz.org/release/r-1",
      file: "pictures/release-03-booklet.jpg",
    });
  });

  it("without fill asks nothing and says how to get them; with no notes, nothing is asked", async () => {
    const { env } = fakeEnv({
      albumNotes: () => Promise.resolve(notes as never),
      releaseArt: (_g, _t, fill) =>
        Promise.resolve(fill ? { kind: "found", value: scans } : { kind: "not_asked" }),
    });
    const r = await exportTrack(env, root(), target(t1), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(r.files.some((f) => f.path.includes("release-"))).toBe(false);
    expect(r.missing.find((m) => m.what.startsWith("the release's scans"))?.remedy).toBe(
      "Export again with fill: true.",
    );
    let asked = 0;
    const { env: bare } = fakeEnv({
      releaseArt: () => {
        asked++;
        return Promise.resolve({ kind: "none" });
      },
    });
    await exportTrack(bare, root(), target(t1), opts({ fill: true }));
    expect(asked).toBe(0);
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
    // LRCLIB answers slowly, thirty seconds a track; nothing else takes time
    let t = 0;
    const calls: Calls = { lyrics: [], pictures: [], started: [] };
    const base = fakeEnv({}, calls).env;
    const { env } = fakeEnv(
      {
        analysis: () => analyzed(),
        clock: () => t,
        lyrics: (n, fill) => {
          if (fill) t += 30_000;
          return base.lyrics(n, fill);
        },
      },
      calls,
    );
    const r = await exportAlbum(env, root(), target(album), opts({ fill: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(calls.lyrics).toEqual([true, true, false]);
    expect(r.missing.some((m) => m.what === "lookups for the later tracks")).toBe(true);
    const late = readJson(r.folder, "tracks/03 - Breakwater/track.json")["missing"] as Array<{
      what: string;
      why: string;
    }>;
    expect(late.find((m) => m.what === "lyrics")?.why).toMatch(/time for lookups ran out first/);
  });

  it("ends with its README and record when a track's copy fails part-way", async () => {
    const { env } = fakeEnv({
      analysis: () => analyzed(),
      audioBody: (url) =>
        Promise.resolve({
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array(1000));
              if (url.includes("t-2")) c.error(new Error("connection reset"));
              else c.close();
            },
          }),
          bytes: 1000,
        }),
    });
    const r = await exportAlbum(env, root(), target(album), opts({ audio: "copy" }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(existsSync(join(r.folder, "README.md"))).toBe(true);
    expect(existsSync(join(r.folder, "album.json"))).toBe(true);
    expect(existsSync(join(r.folder, "tracks/02 - Undertow/track.json"))).toBe(true);
    expect(existsSync(join(r.folder, "tracks/02 - Undertow/audio.flac"))).toBe(false);
    expect(existsSync(join(r.folder, "tracks/03 - Breakwater/audio.flac"))).toBe(true);
    expect(r.left_out.join(" ")).toMatch(/02 - Undertow\/audio\.flac: connection reset/);
  });

  it("keeps room for its records when the cap is reached by the copies", async () => {
    const { env } = fakeEnv({
      analysis: () => analyzed(),
      capBytes: 2_000_000,
      audioBody: () =>
        Promise.resolve({ body: new Blob([new Uint8Array(600_000)]).stream(), bytes: 600_000 }),
    });
    const r = await exportAlbum(env, root(), target(album), opts({ audio: "copy" }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(r.left_out.some((l) => /audio\.flac: the export reached its size cap/.test(l))).toBe(
      true,
    );
    for (const f of ["README.md", "album.json", "tracks/03 - Breakwater/track.json"])
      expect(existsSync(join(r.folder, f)), f).toBe(true);
  });

  it("redacted, leaves the owner's network out of every file of an album", async () => {
    const { env } = fakeEnv({ analysis: () => analyzed() });
    const r = await exportAlbum(
      env,
      root(),
      target(album),
      opts({ fill: true, redact: true, plays: true }),
    );
    if (r.kind !== "exported") throw new Error(r.kind);
    const texts = r.files.filter((f) => /\.(json|md|lrc|txt)$/.test(f.path));
    expect(texts.length).toBeGreaterThan(8);
    for (const f of texts)
      expect(readFileSync(join(r.folder, f.path), "utf-8"), f.path).not.toMatch(
        /10\.0\.0\.5|uuid:server-1|Shelf NAS|"object_id"|first_played|last_played|every_play/,
      );
  });

  it("finds a compilation's artist in each track, never 'Various Artists'", async () => {
    const asked: string[] = [];
    const comp = { ...album, id: "al-9", title: "Night Songs", artist: "Various Artists" };
    const a1 = node({
      id: "c-1",
      title: "One",
      album: "Night Songs",
      albumArtist: "Various Artists",
      artist: "Dusk Parade",
    });
    const { env } = fakeEnv({
      pools: () => [{ ...pools[0], albums: [comp], tracks: [a1] }],
      artistNotes: (artist) => {
        asked.push(artist);
        return Promise.resolve({ kind: "none" });
      },
    });
    const r = await exportTrack(env, root(), target(a1), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(asked).toEqual(["Dusk Parade"]);
  });
});
