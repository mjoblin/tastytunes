import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
import {
  exportAlbum,
  exportTrack,
  LIBRARY_PICTURES_MS,
  PICTURE_BUDGET_MS,
  type ExportEnv,
  type ExportOptions,
} from "./exporter";

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
    analysisRun: () => "idle",
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
    embeddedPicture: () => Promise.resolve(null),
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
    // the waveform it has is in the folder, the rest said as none
    const analysis = readJson(r.folder, "analysis.json");
    expect(analysis["waveform"]).toMatchObject({ points: 1200 });
    expect(analysis["tempo"]).toBeNull();
    expect((readJson(r.folder, "track.json")["measured"] as { details: string }).details).toBe(
      "analysis.json",
    );
  });

  it("answers 'analyzing' while the window measures, then exports and says what was tried", async () => {
    let run: "running" | "idle" | "closed" = "idle";
    const { env, calls } = fakeEnv({ analysis: () => null, analysisRun: () => run });
    const first = await exportTrack(env, root(), target(t3), opts({ fill: true }));
    expect(first.kind).toBe("analyzing");
    // called again at once, with nothing measured yet: still at it, not "measured nothing"
    run = "running";
    const again = await exportTrack(env, root(), target(t3), opts({ fill: true }));
    expect(again.kind).toBe("analyzing");
    if (again.kind !== "analyzing") return;
    expect(again.message).toMatch(
      /^Still analyzing "Harbour Lights": this track isn't measured yet\. Call again/,
    );
    // the window's run has ended: what it couldn't measure, it can't
    run = "idle";
    const second = await exportTrack(env, root(), target(t3), opts({ fill: true }));
    expect(second.kind).toBe("exported");
    expect(calls.started).toEqual(["al-1"]);
    if (second.kind !== "exported") return;
    const gap = second.missing.find((m) => m.what === "analysis");
    expect(gap?.why).toMatch(/ran for it and measured nothing/);
    expect(gap?.remedy).toMatch(/^Call analyze_album/);
  });

  it("says a track isn't analyzed yet when the window closed before its run ended", async () => {
    let run: "running" | "idle" | "closed" = "idle";
    const t9 = node({ id: "t-9", title: "Lantern", album: "Tidewater" });
    const tide = node({ id: "al-9", title: "Tidewater", isContainer: true });
    const { env } = fakeEnv({
      analysis: () => null,
      analysisRun: () => run,
      startAnalysis: () => (run === "closed" ? { why: "closed" } : { started: true }),
      pools: () => [{ ...pools[0], albums: [tide], tracks: [t9] }],
    });
    expect((await exportTrack(env, root(), target(t9), opts({ fill: true }))).kind).toBe(
      "analyzing",
    );
    run = "closed";
    const r = await exportTrack(env, root(), target(t9), opts({ fill: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(r.missing.find((m) => m.what === "analysis")?.why).toBe("Not analyzed yet.");
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

  it("types a picture by its bytes, so a server's wrong type is named and stripped as what it is", async () => {
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
    const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const { env } = fakeEnv({
      // the sleeve said as image/jpg, the shelf's PNG said as a JPEG
      picture: (url) =>
        Promise.resolve(
          url.includes("/aa/1/")
            ? { bytes: exif, type: "image/jpg" }
            : { bytes: PNG, type: "image/jpeg" },
        ),
    });
    const r = await exportTrack(env, root(), target(t1), opts({ redact: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    const files = r.files.map((f) => f.path);
    expect(files).toContain("pictures/sleeve.jpg");
    expect(files).toContain("pictures/shelf-01.png");
    expect(readFileSync(join(r.folder, "pictures/sleeve.jpg")).toString("latin1")).not.toContain(
      "Exif",
    );
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

  it("says a copy the media server gave no address for in left_out, a link only in its note", async () => {
    const { env } = fakeEnv({ audioUrl: () => Promise.resolve(null) });
    const copied = await exportTrack(env, root(), target(t1), opts({ audio: "copy" }));
    const linked = await exportTrack(env, root(), target(t1), opts({ audio: "link" }));
    if (copied.kind !== "exported" || linked.kind !== "exported") throw new Error("not exported");
    const line = "audio.flac: The media server didn't give the track's address.";
    expect(copied.left_out).toEqual([line]);
    expect(readJson(copied.folder, "track.json")["left_out"]).toEqual([line]);
    expect(linked.left_out).toEqual([]);
    expect(readJson(linked.folder, "track.json")["audio"]).toEqual({
      mode: "link",
      note: "The media server didn't give the track's address.",
    });
  });

  it("says why a file couldn't be written without naming where the export is", async () => {
    const dir = root();
    const { env } = fakeEnv({
      plays: () => {
        // a folder where the sleeve goes, so its write fails as a disk's would
        const [made] = readdirSync(dir);
        mkdirSync(join(dir, made, "pictures", "sleeve.jpg", "taken"), { recursive: true });
        return Promise.resolve([]);
      },
    });
    const r = await exportTrack(env, dir, target(t1), opts({ redact: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(r.left_out).toHaveLength(1);
    expect(r.left_out[0]).toMatch(/^pictures\/sleeve\.jpg: E[A-Z]+: /);
    expect(r.left_out[0]).not.toContain(dir);
    expect(readJson(r.folder, "track.json")["left_out"]).toEqual(r.left_out);
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

  it("says how many scans the archive didn't hand over, each still listed by its address", async () => {
    const { env } = fakeEnv({
      analysis: () => analyzed(),
      albumNotes: () => Promise.resolve(notes as never),
      releaseArt: () => Promise.resolve({ kind: "found", value: scans }),
      picture: (url) =>
        Promise.resolve(url.includes("/2-1200") ? null : { bytes: JPEG, type: "image/jpeg" }),
    });
    const r = await exportAlbum(env, root(), target(album), opts({ fill: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(r.missing.find((m) => m.what.startsWith("release scans"))).toEqual({
      what: "release scans (1 of 3 listed by address only)",
      why: "The Cover Art Archive didn't hand them over.",
      remedy:
        "Export again in a moment with fill: true. The new export's folder will have them, and this one stays as it is.",
    });
    const listed = readJson(r.folder, "pictures/pictures.json")["pictures"] as Array<
      Record<string, unknown>
    >;
    expect(listed.filter((p) => p["what"] === "release")[1]).toMatchObject({
      address: "https://coverartarchive.org/release/r-1/2-1200.jpg",
      file: null,
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

  it("are named in the README, with every other field and kind of picture", async () => {
    const { env } = fakeEnv({
      analysis: () => analyzed(),
      albumNotes: () => Promise.resolve(notes as never),
      releaseArt: () => Promise.resolve({ kind: "found", value: scans }),
      artistPictures: () =>
        Promise.resolve({
          offers: [
            {
              source: "commons",
              url: "https://upload.wikimedia.org/c.jpg",
              page: "https://commons.wikimedia.org/wiki/File:c.jpg",
              width: 3000,
              height: 2000,
              fetch: true,
            },
            {
              source: "chosen",
              url: "http://10.0.0.5:9790/aa/9/cover.jpg",
              local: true,
              fetch: true,
            },
          ],
          gap: null,
        }),
    });
    const r = await exportAlbum(env, root(), target(album), opts({ fill: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    const readme = readFileSync(join(r.folder, "README.md"), "utf-8");
    const listed = readJson(r.folder, "pictures/pictures.json")["pictures"] as Array<
      Record<string, unknown>
    >;
    expect(new Set(listed.map((p) => p["what"]))).toEqual(
      new Set(["sleeve", "artist", "release", "shelf"]),
    );
    const named = [
      ...listed.flatMap((p) => Object.keys(p)),
      ...listed.flatMap((p) => [p["what"], p["source"]]),
    ];
    expect([...new Set(named)].filter((k) => !readme.includes(`\`${String(k)}\``))).toEqual([]);
  });
});

describe("the sleeve", () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  // the same library with no picture on the album or its tracks
  const bare: MediaIndexPools[] = [
    {
      ...pools[0],
      albums: [{ ...album, artUrl: null }, other],
      tracks: [t1, t2, t3].map((t) => ({ ...t, artUrl: null })),
    },
  ];
  const bareT1 = { ...t1, artUrl: null };
  const listedSleeve = (folder: string): Record<string, unknown> | undefined =>
    (readJson(folder, "pictures/pictures.json")["pictures"] as Array<Record<string, unknown>>).find(
      (p) => p["what"] === "sleeve",
    );

  it("comes from the audio file, in its own format, when the media server has none", async () => {
    const asked: string[] = [];
    const { env } = fakeEnv({
      pools: () => bare,
      embeddedPicture: (_udn, id) => {
        asked.push(id);
        return Promise.resolve({ bytes: PNG, type: "image/png" });
      },
    });
    const r = await exportTrack(env, root(), target(bareT1), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(asked).toEqual(["t-1"]);
    expect(readFileSync(join(r.folder, "pictures/sleeve.png"))).toEqual(Buffer.from(PNG));
    expect(listedSleeve(r.folder)).toEqual({
      what: "sleeve",
      source: "audio file",
      file: "pictures/sleeve.png",
    });
    expect(r.missing.find((m) => m.what === "sleeve")).toBeUndefined();
  });

  it("is the media server's when it has one, and the file isn't read", async () => {
    let asked = 0;
    const { env } = fakeEnv({
      embeddedPicture: () => {
        asked += 1;
        return Promise.resolve({ bytes: PNG, type: "image/png" });
      },
    });
    const r = await exportTrack(env, root(), target(t1), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(asked).toBe(0);
    expect(listedSleeve(r.folder)).toMatchObject({
      source: "library",
      file: "pictures/sleeve.jpg",
    });
  });

  it("comes from the file when the server's picture doesn't come", async () => {
    const { env } = fakeEnv({
      picture: (url) =>
        Promise.resolve(url.includes("/aa/1/") ? null : { bytes: JPEG, type: "image/jpeg" }),
      embeddedPicture: () => Promise.resolve({ bytes: PNG, type: "image/png" }),
    });
    const r = await exportTrack(env, root(), target(t1), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(listedSleeve(r.folder)).toMatchObject({ source: "audio file" });
    expect(r.missing.find((m) => m.what === "sleeve")).toBeUndefined();
  });

  it("names the setting when reading pictures from audio files is off", async () => {
    const { env } = fakeEnv({ pools: () => bare, embeddedPicture: () => Promise.resolve("off") });
    const r = await exportTrack(env, root(), target(bareT1), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(listedSleeve(r.folder)).toBeUndefined();
    expect(r.missing.find((m) => m.what === "sleeve")?.remedy).toBe(
      "Turn on Settings › Appearance › Album art from audio files, then export again.",
    );
  });

  it("says none was found when neither the server nor the files have one", async () => {
    const { env } = fakeEnv({ pools: () => bare });
    const r = await exportTrack(env, root(), target(bareT1), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(r.missing.find((m) => m.what === "sleeve")).toEqual({
      what: "sleeve",
      why: "The library has no picture for this album, and none was found in its audio files.",
      remedy: "None from TastyTunes.",
    });
  });

  it("is read from an album's first track for an album's export", async () => {
    const asked: string[] = [];
    const { env } = fakeEnv({
      pools: () => bare,
      embeddedPicture: (_udn, id) => {
        asked.push(id);
        return Promise.resolve({ bytes: PNG, type: "image/png" });
      },
    });
    const r = await exportAlbum(env, root(), target({ ...album, artUrl: null }), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(asked).toEqual(["t-1"]);
    expect(r.files.filter((f) => f.path === "pictures/sleeve.png")).toHaveLength(1);
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
    const readme = readFileSync(join(r.folder, "README.md"), "utf-8");
    expect(readme).toContain("## album.json");
    expect(readme).toContain("It is format `tastytunes.export/1`,");
    expect(readme).toMatch(/Wikipedia's text, under\s+the CC BY-SA license/);
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

  it("says the artist's pictures came after the budget, not that fill was off", async () => {
    // the track's lyrics take the whole budget; the artist's pictures come after
    let t = 0;
    const pictures: Array<{ fill: boolean; late?: boolean }> = [];
    const base = fakeEnv().env;
    const { env } = fakeEnv({
      analysis: () => analyzed(),
      clock: () => t,
      lyrics: (n, fill) => {
        if (fill) t += 60_000;
        return base.lyrics(n, fill);
      },
      artistPictures: (artist, fill, late) => {
        pictures.push({ fill, late });
        return base.artistPictures(artist, fill, late);
      },
    });
    const r = await exportTrack(env, root(), target(t1), opts({ fill: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(pictures).toEqual([{ fill: false, late: true }]);
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
    // the records say it too: the album's every line, a track's its own
    expect(readJson(r.folder, "album.json")["left_out"]).toEqual(r.left_out);
    expect(readJson(r.folder, "tracks/02 - Undertow/track.json")["left_out"]).toEqual([
      "tracks/02 - Undertow/audio.flac: connection reset.",
    ]);
    expect(readJson(r.folder, "tracks/03 - Breakwater/track.json")["left_out"]).toEqual([]);
    expect(readdirSync(join(r.folder, "tracks/02 - Undertow"))).not.toContain("audio.flac.part");
  });

  it("names a track it couldn't export in album.json's left_out", async () => {
    const { env } = fakeEnv({
      analysis: (n) => {
        if (n.id === "t-2") throw new Error("the stored analysis couldn't be read");
        return analyzed();
      },
    });
    const r = await exportAlbum(env, root(), target(album), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    const a = readJson(r.folder, "album.json");
    expect((a["tracks"] as Array<{ title: string }>).map((t) => t.title)).toEqual([
      "Lamplighter",
      "Breakwater",
    ]);
    expect(a["left_out"]).toEqual([
      "tracks/02 - Undertow: not exported, its record couldn't be made (the stored analysis couldn't be read)",
    ]);
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

  it("keeps room for its sleeve when the copies would fill the cap", async () => {
    // the pictures first (the sleeve and a shelf picture, 200,000 bytes each), then the copies:
    // three of 950,000 bytes would pass the 3,000,000 the pictures and the copies may use, so the
    // third is left out and the sleeve is in
    const sleeve = new Uint8Array(200_000);
    sleeve.set(JPEG);
    const { env } = fakeEnv({
      analysis: () => null,
      capBytes: 4_000_000,
      picture: () => Promise.resolve({ bytes: sleeve, type: "image/jpeg" }),
      audioBody: () =>
        Promise.resolve({ body: new Blob([new Uint8Array(950_000)]).stream(), bytes: 950_000 }),
    });
    const r = await exportAlbum(env, root(), target(album), opts({ audio: "copy" }));
    if (r.kind !== "exported") throw new Error(r.kind);
    const files = r.files.map((f) => f.path);
    expect(files).toContain("tracks/02 - Undertow/audio.flac");
    expect(files).not.toContain("tracks/03 - Breakwater/audio.flac");
    expect(r.left_out).toEqual([
      "tracks/03 - Breakwater/audio.flac: the export reached its size cap.",
    ]);
    expect(files).toContain("pictures/sleeve.jpg");
  });

  it("keeps every copy an album just under the cap has room for", async () => {
    // the pictures (400,000 bytes) and three copies of 850,000 fit the 3,000,000 media may use,
    // where a third copy once stopped 500,000 short of it, the folder well under its cap
    const sleeve = new Uint8Array(200_000);
    sleeve.set(JPEG);
    const { env } = fakeEnv({
      analysis: () => null,
      capBytes: 4_000_000,
      picture: () => Promise.resolve({ bytes: sleeve, type: "image/jpeg" }),
      audioBody: () =>
        Promise.resolve({ body: new Blob([new Uint8Array(850_000)]).stream(), bytes: 850_000 }),
    });
    const r = await exportAlbum(env, root(), target(album), opts({ audio: "copy" }));
    if (r.kind !== "exported") throw new Error(r.kind);
    const files = r.files.map((f) => f.path);
    for (const f of [
      "pictures/sleeve.jpg",
      "pictures/shelf-01.jpg",
      "tracks/01 - Lamplighter/audio.flac",
      "tracks/02 - Undertow/audio.flac",
      "tracks/03 - Breakwater/audio.flac",
      "album.json",
    ])
      expect(files, f).toContain(f);
    expect(r.left_out).toEqual([]);
    // the pictures went first, the copies after them
    const at = (f: string): number => files.indexOf(f);
    expect(at("pictures/sleeve.jpg")).toBeLessThan(at("tracks/01 - Lamplighter/audio.flac"));
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

  it("says a compilation has no one artist, never that MusicBrainz has no such artist", async () => {
    const asked: string[] = [];
    const comp = { ...album, id: "al-9", title: "Night Songs", artist: "Various Artists" };
    const a1 = node({ id: "c-1", title: "One", album: "Night Songs", artist: "Dusk Parade" });
    const a2 = node({ id: "c-2", title: "Two", album: "Night Songs", artist: "Low Harbour" });
    const { env } = fakeEnv({
      pools: () => [{ ...pools[0], albums: [comp], tracks: [a1, a2] }],
      artistNotes: (artist) => {
        asked.push(artist);
        return Promise.resolve({ kind: "none" });
      },
    });
    const r = await exportAlbum(env, root(), target(comp), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(asked).toEqual([]);
    expect(r.missing.filter((m) => /artist/.test(m.what)).map((m) => m.why)).toEqual([
      "A compilation has no one artist.",
    ]);
  });

  it("says a lookup an untagged track can't make, never the service's none", async () => {
    const bare = node({ id: "t-8", title: "Untitled 8", artist: null, album: null });
    const { env } = fakeEnv({ pools: () => [{ ...pools[0], tracks: [bare] }] });
    const r = await exportTrack(env, root(), target(bare), opts({ fill: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(r.missing.find((m) => m.what === "album notes")).toEqual({
      what: "album notes",
      why: "The track has no album tag, so it can't be looked up.",
      remedy: "None from TastyTunes: the file's tags would need an album.",
    });
    expect(r.missing.find((m) => m.what === "artist notes")?.why).toBe(
      "The track has no artist tag, so it can't be looked up.",
    );
  });
});

describe("the order of an export's asking", () => {
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
    images: Array.from({ length: 24 }, (_, i) => ({
      types: ["Booklet"],
      comment: null,
      url: `https://coverartarchive.org/release/r-1/${i + 1}-1200.jpg`,
    })),
  };

  it("asks every track's lookups before the scans, the artist's pictures fetched before them", async () => {
    // the archive answers slowly, ten seconds a scan; nothing else takes time
    let t = 0;
    const order: string[] = [];
    const base = fakeEnv().env;
    const { env } = fakeEnv({
      analysis: () => analyzed(),
      clock: () => t,
      albumNotes: () => Promise.resolve(notes as never),
      lyrics: (n, fill) => {
        order.push(`lyrics ${n.id} ${fill}`);
        return base.lyrics(n, fill);
      },
      releaseArt: (_g, _n, fill) => {
        order.push(`scans listed ${fill}`);
        return Promise.resolve({ kind: "found", value: scans });
      },
      picture: (url) => {
        if (url.includes("coverartarchive")) t += 10_000;
        order.push(
          url.includes("coverartarchive") ? "scan" : url.includes("wikimedia") ? "artist" : "lib",
        );
        return Promise.resolve({ bytes: JPEG, type: "image/jpeg" });
      },
    });
    const r = await exportAlbum(env, root(), target(album), opts({ fill: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(order.slice(0, 4)).toEqual([
      "lyrics t-1 true",
      "lyrics t-2 true",
      "lyrics t-3 true",
      "scans listed true",
    ]);
    expect(order.indexOf("artist")).toBeLessThan(order.indexOf("scan"));
    // the scans stop at the pictures' own time, and the rest are listed by their address
    const fetched = PICTURE_BUDGET_MS / 10_000;
    expect(order.filter((o) => o === "scan")).toHaveLength(fetched);
    expect(r.missing.find((m) => m.what.startsWith("pictures ("))).toEqual({
      what: `pictures (${24 - fetched} listed by address only)`,
      why: "Not fetched: this export's time for pictures ran out first.",
      remedy: "Fetch each from its address in pictures/pictures.json.",
    });
    expect(r.missing.some((m) => m.what === "lookups for the later tracks")).toBe(false);
    // the library's pictures have their own time: the slow archive left the shelf alone
    expect(r.files.map((f) => f.path)).toContain("pictures/shelf-01.jpg");
  });

  it("holds the library's pictures to their own time without fill, for a server slow to answer", async () => {
    // a media server asleep: each picture comes only at its timeout
    let t = 0;
    const shelf = Array.from({ length: 5 }, (_, i) => ({
      ...other,
      id: `al-s${i}`,
      title: `Shelf ${i}`,
      artUrl: `http://10.0.0.5:9790/aa/s${i}/cover.jpg`,
    }));
    const calls: Calls = { lyrics: [], pictures: [], started: [] };
    const base = fakeEnv({}, calls).env;
    const { env } = fakeEnv(
      {
        pools: () => [{ ...pools[0], albums: [album, ...shelf] }],
        clock: () => t,
        picture: (url) => {
          t += 15_000;
          return base.picture(url);
        },
      },
      calls,
    );
    const r = await exportTrack(env, root(), target(t1), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    // the sleeve, then shelf pictures until the time is spent
    const asked = Math.ceil(LIBRARY_PICTURES_MS / 15_000);
    expect(calls.pictures).toHaveLength(asked);
    expect(calls.pictures[0]).toBe(album.artUrl);
    expect(r.missing.find((m) => m.what.startsWith("pictures from the library"))).toEqual({
      what: `pictures from the library (${6 - asked} not fetched)`,
      why: "Not fetched: the media server was slow to hand over pictures, and this export's time for them ran out.",
      remedy: "Export again while the server is up.",
    });
    const listed = readJson(r.folder, "pictures/pictures.json")["pictures"] as Array<
      Record<string, unknown>
    >;
    expect(listed.filter((p) => p["what"] === "shelf" && p["file"] === null)).toHaveLength(
      6 - asked,
    );
  });
});

describe("the README", () => {
  /** The keys not named in the README as code. */
  const unnamed = (readme: string, keys: string[]): string[] =>
    [...new Set(keys)].filter((k) => !readme.includes(`\`${k}\``));
  const keysOf = (v: unknown): string[] => (v && typeof v === "object" ? Object.keys(v) : []);

  it("names every field a track's export writes, and says its record comes last", async () => {
    const { env } = fakeEnv();
    const copied = await exportTrack(
      env,
      root(),
      target(t1),
      opts({ fill: true, plays: true, audio: "copy" }),
    );
    const linked = await exportTrack(env, root(), target(t1), opts({ fill: true, plays: true }));
    if (copied.kind !== "exported" || linked.kind !== "exported") throw new Error("not exported");
    const readme = readFileSync(join(copied.folder, "README.md"), "utf-8");
    const track = readJson(copied.folder, "track.json");
    const moments = (track["timeline"] as { moments: Array<{ what: string }> }).moments.map(
      (m) => m.what,
    );
    const plays = (track["listening"] as { every_play: unknown[] }).every_play;
    expect(new Set(moments).size).toBe(8);
    expect(
      unnamed(readme, [
        ...keysOf(track),
        ...["measured", "lyrics", "listening", "audio"].flatMap((k) => keysOf(track[k])),
        ...keysOf(readJson(linked.folder, "track.json")["audio"]),
        ...keysOf(plays[0]),
        ...moments,
        ...keysOf(readJson(copied.folder, "analysis.json")),
      ]),
    ).toEqual([]);
    expect(readme).toContain(
      "`track.json` is written last, so a folder without it did not finish.",
    );
    expect(readme).toMatch(
      /A listen is a play that ran for at least half its track, or 4 minutes, whichever is shorter\.\s+A play of a track under 30 seconds never counts\./,
    );
  });

  it("names every field an album's export writes, its tracks' records included", async () => {
    const { env } = fakeEnv();
    const r = await exportAlbum(env, root(), target(album), opts());
    if (r.kind !== "exported") throw new Error(r.kind);
    const readme = readFileSync(join(r.folder, "README.md"), "utf-8");
    const track = readJson(r.folder, "tracks/01 - Lamplighter/track.json");
    expect(
      unnamed(readme, [...keysOf(readJson(r.folder, "album.json")), ...keysOf(track)]),
    ).toEqual([]);
    // what the album shares is in album.json once, never said to be in each track's
    expect(track["album_notes"]).toBeUndefined();
    expect(readme).not.toMatch(/as a single-track export has them/);
    expect(readme).not.toContain("`presets_holding_album` names the streamer's presets");
  });

  it("promises the redaction only for the pictures it strips", async () => {
    const { env } = fakeEnv();
    const r = await exportTrack(env, root(), target(t1), opts({ redact: true }));
    if (r.kind !== "exported") throw new Error(r.kind);
    expect(readFileSync(join(r.folder, "README.md"), "utf-8")).toMatch(
      /its JPEG, PNG and WebP pictures carry none of the details a camera or an editor wrote into them \(a GIF or an SVG is copied as it came\)/,
    );
  });
});
