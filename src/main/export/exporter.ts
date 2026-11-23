import type {
  AlbumInfo,
  ArtistInfo,
  AudioAnalysis,
  Favorite,
  ListeningPlayEvent,
  LyricsResult,
  MediaIndexPools,
  MediaNode,
  Playlist,
  TrackInfo,
} from "@shared/model";
import {
  albumTracksOf,
  currentFeatures,
  favoriteContentKey,
  playKey,
  trackPosition,
} from "@shared/model";
import { nameKey } from "@shared/keys";
import { ExportCapReached, ExportWriter, exportDirName, safeName } from "./exportFolder";
import { buildTrackRecord, EXPORT_FORMAT, type Looked, type Missing } from "./trackRecord";
import { buildAlbumRecord } from "./albumRecord";
import { exportReadme } from "./exportReadme";

/**
 * THE EXPORTER (0.17.0, export for an agent): a track or an album written to a new dated folder
 * inside the one folder the owner chose, through ExportWriter (nothing outside it, a cap on its
 * size). What each source holds comes through ExportEnv, so the rules here (what is asked, what
 * is redacted, what a gap's remedy is) are tested without the app; the agent tools build the env
 * from the app's own lookups (servers/mcp/exportTools).
 */

export interface ExportOptions {
  /** Ask for what is missing: the lookups Connections allows, and the analysis. */
  fill: boolean;
  /** Leave out what points at the owner's home: addresses, device ids, server names, play dates. */
  redact: boolean;
  /** With redact off, the dated list of every play. */
  plays: boolean;
  audio: "link" | "copy" | "none";
}

export interface PictureGot {
  bytes: Uint8Array;
  type: string;
}

export interface ArtistPictureOffer {
  source: "chosen" | "wikipedia" | "commons" | "fanart.tv";
  /** Its address on the internet, or on the owner's network for a chosen cover. */
  url: string | null;
  /** A file already on this computer (a chosen picture's kept copy). */
  file?: string | null;
  page?: string | null;
  width?: number | null;
  height?: number | null;
  /** On the owner's network (a chosen cover): fetched whether or not fill is on, never said
   *  when redacted. */
  local?: boolean;
}

export interface ExportEnv {
  pools(): readonly MediaIndexPools[];
  analysis(node: MediaNode): AudioAnalysis | null;
  albumMeasured(album: MediaNode): { dr: number; lufs?: number | null } | null;
  /** Whether this server's files can be analyzed at all (the setting, the streamer's drive). */
  analysisPossible(serverUdn: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Start the album's analysis in the window, or say why it can't be. */
  startAnalysis(serverUdn: string, albumId: string): { started: true } | { why: string };
  lyrics(node: MediaNode, fill: boolean): Promise<Looked<LyricsResult>>;
  credits(node: MediaNode, fill: boolean): Promise<Looked<TrackInfo>>;
  albumNotes(artist: string, album: string, fill: boolean): Promise<Looked<AlbumInfo>>;
  artistNotes(artist: string, fill: boolean): Promise<Looked<ArtistInfo>>;
  artistPictures(
    artist: string,
    fill: boolean,
  ): Promise<{ offers: ArtistPictureOffer[]; gap: Missing | null }>;
  listeningOn(): boolean;
  plays(): Promise<ListeningPlayEvent[]>;
  favorites(): readonly Favorite[];
  playlists(): readonly Playlist[];
  presets(): Array<{ id: number; name: string; artUrl: string | null }>;
  /** A picture through the app's one picture path. */
  picture(url: string): Promise<PictureGot | null>;
  readFile(path: string): Uint8Array | null;
  audioUrl(serverUdn: string, objectId: string): Promise<string | null>;
  audioBody(
    url: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; bytes: number | null } | null>;
  localTime(ms: number, tzOffsetMin?: number | null): string;
  now(): Date;
  /** Milliseconds, for the lookups' time budget. */
  clock(): number;
}

export interface ExportTarget {
  node: MediaNode;
  serverUdn: string;
  serverName: string | null;
}

export type ExportReply =
  | {
      kind: "exported";
      folder: string;
      files: Array<{ path: string; bytes: number }>;
      missing: Missing[];
      left_out: string[];
    }
  | { kind: "analyzing"; message: string }
  | { kind: "refused"; message: string };

/** Lookups for an album's tracks stop after this long, so the answer comes in a tool's time; what
 *  was found is cached, so the next export asks only for the rest. */
export const LOOKUP_BUDGET_MS = 45_000;
/** At most this many of the artist's pictures and other sleeves are fetched. */
const ARTIST_PICTURES_MAX = 12;
const SHELF_MAX = 24;

/** The keys a redacted export leaves out wherever they appear. */
const REDACTED = new Set([
  "server_udn",
  "object_id",
  "server_name",
  "first_played",
  "last_played",
  "every_play",
  "local_address",
]);

export function redacted<T>(v: T): T {
  if (Array.isArray(v)) return v.map(redacted) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!REDACTED.has(k)) out[k] = redacted(x);
    return out as T;
  }
  return v;
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};
const AUDIO_EXT: Record<string, string> = {
  FLAC: "flac",
  MP3: "mp3",
  AAC: "m4a",
  ALAC: "m4a",
  WAV: "wav",
  PCM: "wav",
  AIFF: "aiff",
  OGG: "ogg",
  Opus: "opus",
  DSD: "dsf",
};

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

let busy = false;

/** One export at a time: a second call while one runs is refused, never queued. */
async function oneAtATime(run: () => Promise<ExportReply>): Promise<ExportReply> {
  if (busy)
    return {
      kind: "refused",
      message: "An export is already being written. Call again when it is done.",
    };
  busy = true;
  try {
    return await run();
  } finally {
    busy = false;
  }
}

function writerFor(root: string, name: string, now: Date, cap?: number): ExportWriter {
  return new ExportWriter(root, exportDirName([name], now), cap);
}

/** The album a track belongs to in its pool, when the index has it. */
function albumOf(t: ExportTarget, pools: readonly MediaIndexPools[]): MediaNode | null {
  const pool = pools.find((p) => p.udn === t.serverUdn);
  if (!pool || !t.node.album) return null;
  const want = nameKey(t.node.album);
  const artist = nameKey(t.node.albumArtist ?? t.node.artist);
  return (
    pool.albums.find((a) => nameKey(a.title) === want && nameKey(a.artist) === artist) ??
    pool.albums.find((a) => nameKey(a.title) === want) ??
    null
  );
}

/** Every copy of the same song across the library (its play key), this one first. */
function copiesOf(t: ExportTarget, pools: readonly MediaIndexPools[]): ExportTarget[] {
  const k = playKey(t.node.title, t.node.artist, t.node.album);
  const out: ExportTarget[] = [];
  for (const p of pools)
    for (const n of p.tracks)
      if (
        !(p.udn === t.serverUdn && n.id === t.node.id) &&
        playKey(n.title, n.artist, n.album) === k
      )
        out.push({ node: n, serverUdn: p.udn, serverName: p.serverName });
  return out;
}

interface Shared {
  plays: ListeningPlayEvent[];
  favorites: Set<string>;
  playlists: readonly Playlist[];
  /** Whether a server's files can be analyzed, asked once per export (it reads the server list). */
  possible: (serverUdn: string) => ReturnType<ExportEnv["analysisPossible"]>;
}

async function sharedFrom(env: ExportEnv): Promise<Shared> {
  return {
    plays: env.listeningOn() ? await env.plays() : [],
    favorites: new Set(env.favorites().map((f) => favoriteContentKey(f))),
    playlists: env.playlists(),
    possible: (() => {
      const asked = new Map<string, ReturnType<ExportEnv["analysisPossible"]>>();
      return (udn: string) => {
        const was = asked.get(udn);
        if (was) return was;
        const ask = env.analysisPossible(udn);
        asked.set(udn, ask);
        return ask;
      };
    })(),
  };
}

/** One track's record, its lookups made (or not) by the options and the budget left. */
async function trackRecordOf(
  env: ExportEnv,
  t: ExportTarget,
  opts: ExportOptions,
  shared: Shared,
  askOnline: boolean,
) {
  const n = t.node;
  const k = playKey(n.title, n.artist, n.album);
  const [lyrics, credits, possible] = await Promise.all([
    env.lyrics(n, askOnline),
    env.credits(n, askOnline),
    shared.possible(t.serverUdn),
  ]);
  return buildTrackRecord({
    node: n,
    serverUdn: t.serverUdn,
    serverName: t.serverName,
    copies: copiesOf(t, env.pools()),
    analysis: env.analysis(n),
    analysisPossible: possible,
    lyrics,
    credits,
    plays: shared.plays.filter((p) => playKey(p.title, p.artist, p.album) === k),
    includePlayList: !opts.redact && opts.plays,
    listeningOff: !env.listeningOn(),
    heldBy: {
      hearted: shared.favorites.has(
        favoriteContentKey({ kind: "track", title: n.title, artist: n.artist, album: n.album }),
      ),
      albumHearted: n.album
        ? shared.favorites.has(
            favoriteContentKey({
              kind: "album",
              title: n.album,
              artist: n.albumArtist ?? n.artist,
              album: null,
            }),
          )
        : false,
      playlists: shared.playlists
        .filter((pl) => pl.items.some((it) => playKey(it.title, it.artist, it.album) === k))
        .map((pl) => pl.name),
    },
    localTime: env.localTime,
  });
}

/** The pictures: the sleeve, the artist's, the shelf of the artist's other sleeves; pictures.json
 *  says which are files and which are addresses. */
async function writePictures(
  env: ExportEnv,
  w: ExportWriter,
  album: MediaNode | null,
  sleeveUrl: string | null,
  artist: string | null,
  ownTitle: string | null,
  opts: ExportOptions,
  leftOut: string[],
): Promise<Missing[]> {
  const listed: Array<Record<string, unknown>> = [];
  const missing: Missing[] = [];
  const save = (base: string, got: PictureGot): string | null => {
    const rel = `pictures/${base}.${EXT[got.type] ?? "img"}`;
    try {
      w.write(rel, got.bytes);
      return rel;
    } catch (e) {
      if (e instanceof ExportCapReached) {
        leftOut.push(`${rel}: the export reached its size cap`);
        return null;
      }
      throw e;
    }
  };

  if (sleeveUrl) {
    const got = await env.picture(sleeveUrl);
    const file = got ? save("sleeve", got) : null;
    listed.push({ what: "sleeve", source: "library", file, local_address: sleeveUrl });
    if (!got)
      missing.push({
        what: "sleeve",
        why: "The media server didn't hand over the picture.",
        remedy: "Export again while the server is up.",
      });
  } else {
    missing.push({
      what: "sleeve",
      why: "The library has no picture for this album.",
      remedy: "None from TastyTunes.",
    });
  }

  if (artist) {
    const { offers, gap } = await env.artistPictures(artist, opts.fill);
    if (gap) missing.push(gap);
    let n = 0;
    for (const o of offers) {
      const entry: Record<string, unknown> = {
        what: "artist",
        source: o.source,
        page: o.page ?? null,
        width: o.width ?? null,
        height: o.height ?? null,
      };
      if (o.local) entry["local_address"] = o.url;
      else entry["address"] = o.url;
      if (n < ARTIST_PICTURES_MAX) {
        const local = o.file ? env.readFile(o.file) : null;
        const got: PictureGot | null = local
          ? { bytes: local, type: sniffType(local) }
          : o.url && (opts.fill || o.local)
            ? await env.picture(o.url)
            : null;
        if (got) {
          n += 1;
          entry["file"] = save(`artist-${String(n).padStart(2, "0")}`, got);
        }
      }
      listed.push(entry);
    }

    const shelf = otherSleeves(env.pools(), artist, album, ownTitle);
    let s = 0;
    for (const a of shelf.slice(0, SHELF_MAX)) {
      const got = a.artUrl ? await env.picture(a.artUrl) : null;
      const file = got ? save(`shelf-${String(++s).padStart(2, "0")}`, got) : null;
      listed.push({
        what: "shelf",
        source: "library",
        album: a.title,
        year: a.year,
        file,
        local_address: a.artUrl,
      });
    }
  }
  const out = { format: EXPORT_FORMAT, pictures: listed };
  w.write("pictures/pictures.json", json(opts.redact ? redacted(out) : out));
  return missing;
}

/** The artist's other albums in the library with a picture, one per title, by year. */
export function otherSleeves(
  pools: readonly MediaIndexPools[],
  artist: string,
  album: MediaNode | null,
  ownTitle: string | null = null,
): MediaNode[] {
  const who = nameKey(artist);
  const own = album?.title ?? ownTitle;
  const seen = new Set<string>(own ? [nameKey(own)] : []);
  const out: MediaNode[] = [];
  for (const p of pools)
    for (const a of p.albums) {
      const t = nameKey(a.title);
      if (!a.artUrl || nameKey(a.artist) !== who || seen.has(t)) continue;
      seen.add(t);
      out.push(a);
    }
  return out.sort(
    (x, y) => (x.year ?? "9999").localeCompare(y.year ?? "9999") || x.title.localeCompare(y.title),
  );
}

function sniffType(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  return "image/jpeg";
}

/** The audio: its address, the file copied in, or nothing; said in the record either way. */
async function writeAudio(
  env: ExportEnv,
  w: ExportWriter,
  dir: string,
  t: ExportTarget,
  opts: ExportOptions,
  leftOut: string[],
): Promise<Record<string, unknown>> {
  if (opts.audio === "none") return { mode: "none" };
  const url = await env.audioUrl(t.serverUdn, t.node.id);
  if (!url) return { mode: opts.audio, note: "The media server didn't give the track's address." };
  if (opts.audio === "link")
    return opts.redact
      ? {
          mode: "link",
          note: "Left out: the export is redacted, and the address is on the owner's network.",
        }
      : {
          mode: "link",
          local_address: url,
          note: "Plays while the media server is up, from the owner's network.",
        };
  const ext =
    AUDIO_EXT[t.node.format?.codec ?? ""] ?? /\.(\w{2,4})(?:\?|$)/.exec(url)?.[1] ?? "audio";
  const rel = `${dir}audio.${ext}`;
  const got = await env.audioBody(url);
  if (!got) return { mode: "copy", note: "The media server didn't hand over the file." };
  try {
    await w.copy(rel, got.body, got.bytes ?? undefined);
    return { mode: "copy", file: rel.slice(dir.length) };
  } catch (e) {
    if (e instanceof ExportCapReached) {
      leftOut.push(`${rel}: the export reached its size cap`);
      return { mode: "copy", note: "Left out: the export reached its size cap." };
    }
    throw e;
  }
}

function lrcOf(lines: Array<{ at_seconds: number; text: string }>): string {
  const stamp = (s: number): string => {
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
  };
  return `${lines.map((l) => `[${stamp(l.at_seconds)}] ${l.text}`).join("\n")}\n`;
}

/** A track's files into `dir` ("" or "tracks/01 - Title/"): track.json, analysis.json, its lyrics. */
async function writeTrackFiles(
  env: ExportEnv,
  w: ExportWriter,
  dir: string,
  t: ExportTarget,
  opts: ExportOptions,
  rec: Awaited<ReturnType<typeof trackRecordOf>>,
  extra: Record<string, unknown>,
  leftOut: string[],
): Promise<void> {
  const audio = await writeAudio(env, w, dir, t, opts, leftOut);
  const lyrics = rec.track["lyrics"] as {
    lines?: Array<{ at_seconds: number; text: string }>;
    plain?: string | null;
  } | null;
  if (lyrics?.lines?.length) w.write(`${dir}lyrics.lrc`, lrcOf(lyrics.lines));
  if (lyrics?.plain) w.write(`${dir}lyrics.txt`, `${lyrics.plain.trim()}\n`);
  if (rec.analysis)
    w.write(`${dir}analysis.json`, json(opts.redact ? redacted(rec.analysis) : rec.analysis));
  const track = { ...rec.track, ...extra, audio, missing: rec.missing };
  w.write(`${dir}track.json`, json(opts.redact ? redacted(track) : track));
}

/** Notes on the album and the artist, when known or asked for. */
async function notesOf(env: ExportEnv, artist: string | null, album: string | null, ask: boolean) {
  const [albumNotes, artistNotes] = await Promise.all([
    artist && album
      ? env.albumNotes(artist, album, ask)
      : Promise.resolve<Looked<AlbumInfo>>({ kind: "none" }),
    artist ? env.artistNotes(artist, ask) : Promise.resolve<Looked<ArtistInfo>>({ kind: "none" }),
  ]);
  const artistOut =
    artistNotes.kind === "found"
      ? {
          name: artistNotes.value.name,
          summary: artistNotes.value.summary,
          wikipedia: artistNotes.value.wikipediaUrl,
          musicbrainz: artistNotes.value.musicbrainzUrl,
        }
      : null;
  const albumOut =
    albumNotes.kind === "found"
      ? {
          title: albumNotes.value.title,
          year: albumNotes.value.year,
          type: albumNotes.value.type,
          label: albumNotes.value.label,
          genres: albumNotes.value.genres,
          credits: albumNotes.value.credits,
          summary: albumNotes.value.summary,
          wikipedia: albumNotes.value.wikipediaUrl,
          musicbrainz: albumNotes.value.musicbrainzUrl,
        }
      : null;
  return { albumNotes, artistNotes, albumOut, artistOut };
}

function notesGaps(l: Looked<unknown>, what: string): Missing[] {
  if (l.kind === "not_asked")
    return [
      {
        what,
        why: "Not looked up: the export was made without fill.",
        remedy: "Export again with fill: true.",
      },
    ];
  if (l.kind === "off")
    return [
      {
        what,
        why: "Liner notes is switched off in Settings › Connections.",
        remedy:
          "Ask the user to turn on Liner notes in Settings › Connections, then export again with fill: true.",
      },
    ];
  if (l.kind === "unreachable")
    return [
      { what, why: "MusicBrainz or Wikipedia didn't answer.", remedy: "Export again in a moment." },
    ];
  return [];
}

/** With fill, an album with tracks to measure starts its analysis and answers "call again". */
async function analysisFirst(
  env: ExportEnv,
  serverUdn: string,
  album: MediaNode | null,
  tracks: MediaNode[],
): Promise<ExportReply | null> {
  if (!album) return null;
  const unmeasured = tracks.filter((n) => !isCurrent(env.analysis(n)));
  if (unmeasured.length === 0) return null;
  const possible = await env.analysisPossible(serverUdn);
  if (!possible.ok) return null;
  if ("why" in env.startAnalysis(serverUdn, album.id)) return null;
  return {
    kind: "analyzing",
    message: `Analyzing "${album.title}" first (${unmeasured.length} ${unmeasured.length === 1 ? "track" : "tracks"} to measure, one at a time, in the TastyTunes window). Call again in a few minutes with the same arguments; get_track_analysis says when each track is measured.`,
  };
}

/** The record's own rule for a current analysis (decodedAnalysis), read without decoding. */
const isCurrent = (an: AudioAnalysis | null): boolean => currentFeatures(an?.features) != null;

export function exportTrack(
  env: ExportEnv,
  root: string,
  t: ExportTarget,
  opts: ExportOptions,
): Promise<ExportReply> {
  return oneAtATime(async () => {
    const pools = env.pools();
    const album = albumOf(t, pools);
    if (opts.fill) {
      const wait = await analysisFirst(env, t.serverUdn, album, [t.node]);
      if (wait) return wait;
    }
    const w = writerFor(
      root,
      [t.node.artist, t.node.album, t.node.title].filter(Boolean).join(" - "),
      env.now(),
    );
    const leftOut: string[] = [];
    const shared = await sharedFrom(env);
    const rec = await trackRecordOf(env, t, opts, shared, opts.fill);
    const artist = t.node.albumArtist ?? t.node.artist;
    const notes = await notesOf(env, artist, t.node.album, opts.fill);
    const missing = [
      ...rec.missing,
      ...notesGaps(notes.albumNotes, "album notes"),
      ...notesGaps(notes.artistNotes, "artist notes"),
    ];
    const pictureGaps = await writePictures(
      env,
      w,
      album,
      album?.artUrl ?? t.node.artUrl,
      artist,
      t.node.album,
      opts,
      leftOut,
    );
    missing.push(...pictureGaps);
    const presets = album?.artUrl ? env.presets().filter((p) => p.artUrl === album.artUrl) : [];
    await writeTrackFiles(
      env,
      w,
      "",
      t,
      opts,
      { ...rec, missing },
      {
        album_notes: notes.albumOut,
        artist_notes: notes.artistOut,
        presets_holding_album: presets.map((p) => ({ slot: p.id, name: p.name })),
        pictures: "pictures/pictures.json",
        exported_at: env.localTime(env.now().getTime()),
        redacted: opts.redact,
      },
      leftOut,
    );
    w.write("README.md", exportReadme("track", opts));
    return { kind: "exported", folder: w.dir, files: w.files(), missing, left_out: leftOut };
  });
}

export function exportAlbum(
  env: ExportEnv,
  root: string,
  a: ExportTarget,
  opts: ExportOptions,
): Promise<ExportReply> {
  return oneAtATime(async () => {
    const pools = env.pools();
    const pool = pools.find((p) => p.udn === a.serverUdn);
    if (!pool)
      return {
        kind: "refused",
        message: "That server's index isn't ready. Use list_media_servers.",
      };
    const tracks = albumTracksOf(a.node, pool);
    if (tracks.length === 0)
      return { kind: "refused", message: `The index holds no tracks for "${a.node.title}".` };
    if (opts.fill) {
      const wait = await analysisFirst(env, a.serverUdn, a.node, tracks);
      if (wait) return wait;
    }
    const w = writerFor(root, [a.node.artist, a.node.title].filter(Boolean).join(" - "), env.now());
    const leftOut: string[] = [];
    const shared = await sharedFrom(env);
    const started = env.clock();
    const done: Array<{
      folder: string;
      node: MediaNode;
      record: Awaited<ReturnType<typeof trackRecordOf>>;
    }> = [];
    let budgetSpent = false;
    for (const [i, n] of tracks.entries()) {
      // the lookups stop when the budget is spent; what is cached is still read
      const ask = opts.fill && env.clock() - started < LOOKUP_BUDGET_MS;
      if (opts.fill && !ask) budgetSpent = true;
      const t = { node: n, serverUdn: a.serverUdn, serverName: a.serverName };
      const rec = await trackRecordOf(env, t, opts, shared, ask);
      const pos = trackPosition(n);
      const folder = `tracks/${String(i + 1).padStart(2, "0")} - ${safeName(n.title)}/`;
      await writeTrackFiles(env, w, folder, t, opts, rec, { position: pos }, leftOut);
      done.push({ folder: folder.slice(0, -1), node: n, record: rec });
    }
    const artist = a.node.artist;
    const notes = await notesOf(env, artist, a.node.title, opts.fill);
    const albumRec = buildAlbumRecord({
      album: a.node,
      serverUdn: a.serverUdn,
      serverName: a.serverName,
      tracks: done,
      notes: notes.albumNotes,
      measured: env.albumMeasured(a.node),
      hearted: shared.favorites.has(
        favoriteContentKey({
          kind: "album",
          title: a.node.title,
          artist: a.node.artist,
          album: null,
        }),
      ),
    });
    const missing = [...albumRec.missing, ...notesGaps(notes.artistNotes, "artist notes")];
    if (budgetSpent)
      missing.push({
        what: "lookups for the later tracks",
        why: `The lookups stopped after ${LOOKUP_BUDGET_MS / 1000} seconds, so the answer comes in time.`,
        remedy:
          "Export again with fill: true; what was found is kept, so it carries on from there.",
      });
    missing.push(
      ...(await writePictures(env, w, a.node, a.node.artUrl, artist, a.node.title, opts, leftOut)),
    );
    const presets = a.node.artUrl ? env.presets().filter((p) => p.artUrl === a.node.artUrl) : [];
    const album = {
      ...albumRec.album,
      artist_notes: notes.artistOut,
      presets_holding_album: presets.map((p) => ({ slot: p.id, name: p.name })),
      pictures: "pictures/pictures.json",
      exported_at: env.localTime(env.now().getTime()),
      redacted: opts.redact,
      missing,
    };
    w.write("album.json", json(opts.redact ? redacted(album) : album));
    w.write("README.md", exportReadme("album", opts));
    return { kind: "exported", folder: w.dir, files: w.files(), missing, left_out: leftOut };
  });
}
