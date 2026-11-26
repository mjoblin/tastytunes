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
  analysisOutdated,
  favoriteContentKey,
  isCompilation,
  playKey,
  trackPosition,
} from "@shared/model";
import { nameKey } from "@shared/keys";
import {
  CopyFailed,
  ExportCapReached,
  ExportWriter,
  exportDirName,
  safeName,
  type WriteKind,
} from "./exportFolder";
import {
  buildTrackRecord,
  cannotAsk,
  EXPORT_FORMAT,
  gapOf,
  LOOKUPS,
  type Looked,
  type Missing,
  AGAIN_FOR_THE_REST,
} from "./trackRecord";
import { buildAlbumRecord } from "./albumRecord";
import { exportReadme } from "./exportReadme";
import type { ReleaseArt } from "../lookups/releaseArt";
import { withoutMetadata } from "./pictureMeta";
import { pictureType } from "@shared/pictureType";

/**
 * THE EXPORTER (0.17.0, export for an agent): a track or an album written to a new dated folder
 * inside the one folder the owner chose, through ExportWriter (nothing outside it, a cap on its
 * size). What each source holds comes through ExportEnv, so the rules here (what is asked, what
 * is redacted, what a gap's remedy is) are tested without the app; the agent tools build the env
 * from the app's own lookups (servers/mcp/exportTools).
 *
 * - THE README FIRST, THE RECORD LAST, WHATEVER HAPPENS: a file that can't be written (a server
 *   that drops a stream, the cap) is a line in left_out and the export goes on; even a failure
 *   part-way ends with the README and track.json or album.json, which say what is there and,
 *   in left_out, what isn't. A folder without its record did not finish.
 * - THE LOOKUPS FIRST, THE PICTURES ON THEIR OWN TIME, the audio copies apart: the lookups
 *   (every track's before the release's scans and the artist's pictures are listed) stop at
 *   LOOKUP_BUDGET_MS, and missing says what a second call would add, which is quick since the
 *   app keeps what was looked up; the pictures are fetched after, on budgets of their own
 *   (writePictures), so a slow archive or a sleeping media server can't spend the tracks' time.
 * - With fill, an analysis is started once for an unchanged state: called again with nothing
 *   measured since, the export goes ahead and says what couldn't be measured.
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
  /** On the owner's network (a chosen cover): never said when redacted, and not held to the
   *  lookups' budget. */
  local?: boolean;
  /** Whether it may be fetched at all (the env's rule: fill, and the switch the window obeys). */
  fetch: boolean;
}

export interface ExportEnv {
  pools(): readonly MediaIndexPools[];
  analysis(node: MediaNode): AudioAnalysis | null;
  albumMeasured(album: MediaNode): { dr: number; lufs?: number | null } | null;
  /** Whether this server's files can be analyzed at all (the setting, the streamer's drive). */
  analysisPossible(serverUdn: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Start the album's analysis in the window, or say why it can't be. */
  startAnalysis(serverUdn: string, albumId: string): { started: true } | { why: string };
  /** Whether the window is analyzing the album now, has no analysis of it going, or is closed
   *  (main/app/analysisRuns). */
  analysisRun(serverUdn: string, albumId: string): "running" | "idle" | "closed";
  lyrics(node: MediaNode, fill: boolean): Promise<Looked<LyricsResult>>;
  credits(node: MediaNode, fill: boolean): Promise<Looked<TrackInfo>>;
  albumNotes(artist: string, album: string, fill: boolean): Promise<Looked<AlbumInfo>>;
  artistNotes(artist: string, fill: boolean): Promise<Looked<ArtistInfo>>;
  /** One release's scans on the Cover Art Archive (back cover, booklet...), chosen from the
   *  album's release group by its track count. */
  releaseArt(
    releaseGroup: string,
    tracks: number | null,
    fill: boolean,
  ): Promise<Looked<ReleaseArt>>;
  /** `late`: fill was asked for, and the call's time for lookups ran out before these. */
  artistPictures(
    artist: string,
    fill: boolean,
    late?: boolean,
  ): Promise<{ offers: ArtistPictureOffer[]; gap: Missing | null }>;
  listeningOn(): boolean;
  plays(): Promise<ListeningPlayEvent[]>;
  favorites(): readonly Favorite[];
  playlists(): readonly Playlist[];
  presets(): Array<{ id: number; name: string; artUrl: string | null }>;
  /** A picture through the app's one picture path. */
  picture(url: string): Promise<PictureGot | null>;
  /** The picture inside the track's audio file, or its album's other tracks', as the tags hold
   *  it (main/lookups/embeddedArt); "off" while Album art from audio files is off. */
  embeddedPicture(serverUdn: string, objectId: string): Promise<PictureGot | "off" | null>;
  readFile(path: string): Uint8Array | null;
  /** The track's address as the media server gives it, and that server's own host. */
  audioUrl(
    serverUdn: string,
    objectId: string,
  ): Promise<{ url: string; serverHost: string } | null>;
  /** The file's body, only from the media server's own host, as audio; or why not. */
  audioBody(
    url: string,
    serverHost: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; bytes: number | null } | { why: string }>;
  localTime(ms: number, tzOffsetMin?: number | null): string;
  now(): Date;
  /** Milliseconds, for the lookups' time budget. */
  clock(): number;
  /** The most one export may write; EXPORT_CAP_BYTES unless a test says less. */
  capBytes?: number;
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

/** A call's lookups stop after this long of asking, so the answer comes in a tool's time; what was
 *  found is cached, so the next export asks only for the rest. */
export const LOOKUP_BUDGET_MS = 45_000;
/** The pictures from the internet (the artist's, the release's scans) stop after this long of
 *  fetching, under fill. They are not kept between exports, so a second export would spend it
 *  the same way: what is left is listed by its address. */
export const PICTURE_BUDGET_MS = 30_000;
/** The library's own pictures (the sleeve, the one in its audio file, the shelf) stop after this
 *  long, with fill or without: a media server asleep answers each only at its timeout. */
export const LIBRARY_PICTURES_MS = 20_000;
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

/** The export being written, if one is: a second call is refused, never queued, and told where
 *  the first is going (a client that timed out can find it there). */
let busy: { folder: string | null } | null = null;

async function oneAtATime(run: () => Promise<ExportReply>): Promise<ExportReply> {
  if (busy)
    return {
      kind: "refused",
      message: busy.folder
        ? `An export is already being written, into ${busy.folder}. Call again when it is done.`
        : "An export is already being written. Call again when it is done.",
    };
  busy = { folder: null };
  try {
    return await run();
  } finally {
    busy = null;
  }
}

function writerFor(env: ExportEnv, root: string, parts: Array<string | null>): ExportWriter {
  const w = new ExportWriter(root, exportDirName(parts, env.now()), env.capBytes);
  if (busy) busy.folder = w.dir;
  return w;
}

/** The album a track belongs to in its pool, when the index has it: by title and artist, else
 *  the one of that title holding the track (two "Greatest Hits" are two albums), else the only
 *  one of that title. */
export function albumOf(t: ExportTarget, pools: readonly MediaIndexPools[]): MediaNode | null {
  const pool = pools.find((p) => p.udn === t.serverUdn);
  if (!pool || !t.node.album) return null;
  const want = nameKey(t.node.album);
  const artist = nameKey(t.node.albumArtist ?? t.node.artist);
  const titled = pool.albums.filter((a) => nameKey(a.title) === want);
  return (
    titled.find((a) => nameKey(a.artist) === artist) ??
    titled.find((a) => albumTracksOf(a, pool).some((n) => n.id === t.node.id)) ??
    (titled.length === 1 ? titled[0] : null)
  );
}

/** The artist a track's notes, pictures and shelf are for: its album's, unless the album is a
 *  compilation ("Various Artists"), then its own. */
function performerOf(n: MediaNode): string | null {
  const albumArtist = n.albumArtist ?? n.artist;
  return albumArtist && isCompilation({ artist: albumArtist }) ? n.artist : albumArtist;
}

/**
 * A TIME BUDGET: the time spent asking against its limit (the call's lookups' LOOKUP_BUDGET_MS,
 * or one of the pictures' own). Each ask is timed, and the limit is checked before an ask, never
 * during one (each has its own timeout); once spent, nothing more is asked and a lookup that
 * would have been is said as "ran out first" (Looked's late).
 */
class Budget {
  private spent = 0;
  private lateLooks = 0;
  constructor(
    private readonly clock: () => number,
    /** Whether this budget asks at all: the lookups and the internet's pictures only with fill. */
    private readonly asks: boolean,
    private readonly limit = LOOKUP_BUDGET_MS,
  ) {}
  /** Whether it may still ask. */
  get open(): boolean {
    return this.asks && this.spent < this.limit;
  }
  /** Whether it was asked to ask, and the budget then stopped it. */
  get ranOut(): boolean {
    return this.asks && this.spent >= this.limit;
  }
  /** How many lookups were said as late. */
  get late(): number {
    return this.lateLooks;
  }
  async time<T>(run: () => Promise<T>): Promise<T> {
    const at = this.clock();
    try {
      return await run();
    } finally {
      this.spent += this.clock() - at;
    }
  }
  /** A lookup asked under the budget: with fill and time left it may ask; with fill and none
   *  left, its "not asked" is said as late. */
  async look<T>(ask: (fill: boolean) => Promise<Looked<T>>): Promise<Looked<T>> {
    const may = this.open;
    const got = await this.time(() => ask(may));
    if (!this.asks || may || got.kind !== "not_asked") return got;
    this.lateLooks += 1;
    return { kind: "not_asked", late: true };
  }
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
  budget: Budget,
  tried: ReadonlySet<string>,
) {
  const n = t.node;
  const k = playKey(n.title, n.artist, n.album);
  const [lyrics, credits, possible] = await Promise.all([
    budget.look((fill) => env.lyrics(n, fill)),
    budget.look((fill) => env.credits(n, fill)),
    shared.possible(t.serverUdn),
  ]);
  return buildTrackRecord({
    node: n,
    serverUdn: t.serverUdn,
    serverName: t.serverName,
    copies: copiesOf(t, env.pools()),
    analysis: env.analysis(n),
    analysisPossible: possible,
    analysisTried: tried.has(n.id),
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

/** Writes that never stop an export: a file that can't be written (the cap, a disk error) is a
 *  line in left_out, and the export goes on to its record. */
interface Put {
  (rel: string, data: string | Uint8Array, kind?: WriteKind): boolean;
  leftOut: string[];
}

function putter(w: ExportWriter): Put {
  const leftOut: string[] = [];
  const put = ((rel, data, kind = "media") => {
    try {
      w.write(rel, data, kind);
      return true;
    } catch (e) {
      leftOut.push(
        e instanceof ExportCapReached
          ? `${rel}: the export reached its size cap`
          : `${rel}: ${(e as Error).message}`,
      );
      return false;
    }
  }) as Put;
  put.leftOut = leftOut;
  return put;
}

/** A picture's type by its own bytes, the declared one only when they say nothing: a server's
 *  "image/jpg", or a PNG it calls a JPEG, is named and stripped as what it is. */
const typeOf = (got: PictureGot): string => pictureType(got.bytes) ?? got.type;

/** A picture's bytes as the export writes them: without their metadata when redacted (a JPEG, a
 *  PNG or a WebP; anything else goes as it came). */
const pictureBytes = (got: PictureGot, type: string, opts: ExportOptions): Uint8Array =>
  opts.redact ? withoutMetadata(got.bytes, type) : got.bytes;

/** The pictures: the sleeve, the artist's, the release's scans, the shelf of the artist's other
 *  sleeves; pictures.json says which are files and which are addresses. The artist's pictures
 *  are listed under the call's lookups (`budget`); every picture is fetched on the pictures' own
 *  time: the internet's under fill until PICTURE_BUDGET_MS is spent, the artist's before the
 *  scans, and the library's until LIBRARY_PICTURES_MS is, with fill or without. The sleeve is
 *  always asked for. */
async function writePictures(
  env: ExportEnv,
  put: Put,
  album: MediaNode | null,
  sleeveUrl: string | null,
  /** The track whose audio file (or its album's) may hold the sleeve when the server has none. */
  sleeveTrack: { serverUdn: string; objectId: string } | null,
  artist: string | null,
  ownTitle: string | null,
  opts: ExportOptions,
  budget: Budget,
  release: Looked<ReleaseArt> | null,
): Promise<Missing[]> {
  const listed: Array<Record<string, unknown>> = [];
  const missing: Missing[] = [];
  const library = new Budget(env.clock, true, LIBRARY_PICTURES_MS);
  const online = new Budget(env.clock, opts.fill, PICTURE_BUDGET_MS);
  const save = (base: string, got: PictureGot): string | null => {
    const type = typeOf(got);
    const rel = `pictures/${base}.${EXT[type] ?? "img"}`;
    return put(rel, pictureBytes(got, type, opts)) ? rel : null;
  };
  const fetch = (on: Budget, url: string): Promise<PictureGot | null> =>
    on.time(() => env.picture(url).catch(() => null));
  let lateOnline = 0;
  let lateLibrary = 0;

  // THE SLEEVE: the media server's picture first, then the one inside the audio file, as
  // get_album_art and the window's own art fall through (lib/bestArt)
  const fromServer = sleeveUrl ? await fetch(library, sleeveUrl) : null;
  const fromFile =
    fromServer || !sleeveTrack || !library.open
      ? null
      : await library.time(() =>
          env.embeddedPicture(sleeveTrack.serverUdn, sleeveTrack.objectId).catch(() => null),
        );
  const inFile = fromFile && fromFile !== "off" ? fromFile : null;
  if (fromServer || !inFile) {
    if (sleeveUrl) {
      const file = fromServer ? save("sleeve", fromServer) : null;
      listed.push({ what: "sleeve", source: "library", file, local_address: sleeveUrl });
    }
  } else listed.push({ what: "sleeve", source: "audio file", file: save("sleeve", inFile) });
  if (!fromServer && !inFile)
    missing.push(
      sleeveUrl
        ? {
            what: "sleeve",
            why: "The media server didn't hand over the picture.",
            remedy: "Export again while the server is up.",
          }
        : fromFile === "off"
          ? {
              what: "sleeve",
              why: "The library has no picture for this album, and reading one from its audio files is off.",
              remedy:
                "Turn on Settings › Appearance › Album art from audio files, then export again.",
            }
          : {
              what: "sleeve",
              why: "The library has no picture for this album, and none was found in its audio files.",
              remedy: "None from TastyTunes.",
            },
    );

  // THE ARTIST'S PICTURES, before the scans: a chosen cover from the owner's network, the rest
  // from the internet
  if (artist) {
    const may = budget.open;
    const { offers, gap } = await budget.time(() => env.artistPictures(artist, may, budget.ranOut));
    if (gap) missing.push(gap);
    let n = 0;
    const seen = new Set<string>();
    for (const o of offers) {
      // the same photo offered twice (an article's and its Commons page) is listed once
      if (o.url && seen.has(o.url)) continue;
      if (o.url) seen.add(o.url);
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
        let got: PictureGot | null = local
          ? { bytes: local, type: pictureType(local) ?? "image/jpeg" }
          : null;
        if (!got && o.url && o.fetch) {
          const on = o.local ? library : online;
          if (on.open) got = await fetch(on, o.url);
          else if (o.local) lateLibrary += 1;
          else lateOnline += 1;
        }
        if (got) {
          const file = save(`artist-${String(n + 1).padStart(2, "0")}`, got);
          if (file) {
            n += 1;
            entry["file"] = file;
          }
        }
      }
      listed.push(entry);
    }
  }

  // THE RELEASE'S SCANS (the Cover Art Archive step): files under fill and the pictures' time,
  // listed by address otherwise; the release they come from is named on each
  if (release) {
    const gap = gapOf(release, LOOKUPS.releaseArt);
    if (gap) missing.push(gap);
    if (release.kind === "found") {
      const r = release.value;
      let asked = 0;
      let refused = 0;
      for (const [i, img] of r.images.entries()) {
        let file: string | null = null;
        if (opts.fill && online.open) {
          const got = await fetch(online, img.url);
          asked += 1;
          if (!got) refused += 1;
          const kind = safeName(img.types[0].toLowerCase()).replace(/\s+/g, "-");
          file = got ? save(`release-${String(i + 1).padStart(2, "0")}-${kind}`, got) : null;
        } else if (opts.fill) lateOnline += 1;
        listed.push({
          what: "release",
          source: "Cover Art Archive",
          types: img.types,
          comment: img.comment,
          release: r.release,
          release_country: r.country,
          release_date: r.date,
          release_formats: r.formats,
          address: img.url,
          file,
        });
      }
      if (refused > 0)
        missing.push({
          what: `release scans (${refused} of ${asked} listed by address only)`,
          why: "The Cover Art Archive didn't hand them over.",
          remedy:
            "Export again in a moment with fill: true. The new export's folder will have them, and this one stays as it is.",
        });
    }
  }

  // THE SHELF: the library's own pictures, last
  if (artist) {
    const shelf = otherSleeves(env.pools(), artist, album, ownTitle);
    let s = 0;
    for (const a of shelf.slice(0, SHELF_MAX)) {
      let file: string | null = null;
      if (a.artUrl && library.open) {
        const got = await fetch(library, a.artUrl);
        file = got ? save(`shelf-${String(++s).padStart(2, "0")}`, got) : null;
      } else if (a.artUrl) lateLibrary += 1;
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
  if (lateOnline > 0)
    missing.push({
      what: `pictures (${lateOnline} listed by address only)`,
      why: "Not fetched: this export's time for pictures ran out first.",
      remedy: "Fetch each from its address in pictures/pictures.json.",
    });
  if (lateLibrary > 0)
    missing.push({
      what: `pictures from the library (${lateLibrary} not fetched)`,
      why: "Not fetched: the media server was slow to hand over pictures, and this export's time for them ran out.",
      remedy: "Export again while the server is up.",
    });
  const out = { format: EXPORT_FORMAT, pictures: listed };
  put("pictures/pictures.json", json(opts.redact ? redacted(out) : out), "record");
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

/** The audio: its address, the file copied in, or nothing; said in the record either way. A copy
 *  that fails (the cap, a server that stops or sends short) is a line in left_out, never a file
 *  kept half-written. */
async function writeAudio(
  env: ExportEnv,
  w: ExportWriter,
  put: Put,
  dir: string,
  t: ExportTarget,
  opts: ExportOptions,
): Promise<Record<string, unknown>> {
  if (opts.audio === "none") return { mode: "none" };
  const at = await env.audioUrl(t.serverUdn, t.node.id).catch(() => null);
  if (!at) return { mode: opts.audio, note: "The media server didn't give the track's address." };
  const url = at.url;
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
  const got = await env.audioBody(url, at.serverHost).catch(() => ({
    why: "The media server didn't hand over the file.",
  }));
  if ("why" in got) {
    put.leftOut.push(`${rel}: ${got.why}`);
    return { mode: "copy", note: got.why };
  }
  try {
    await w.copy(rel, got.body, got.bytes ?? undefined);
    return {
      mode: "copy",
      file: rel.slice(dir.length),
      ...(opts.redact
        ? {
            note: "The file carries its own tags (as a bought file can carry its buyer's name), which the redaction doesn't touch.",
          }
        : {}),
    };
  } catch (e) {
    const why =
      e instanceof ExportCapReached
        ? "Left out: the export reached its size cap."
        : e instanceof CopyFailed
          ? `Left out: ${e.message}.`
          : `Left out: ${(e as Error).message}.`;
    put.leftOut.push(`${rel}: ${why.replace(/^Left out: /, "")}`);
    return { mode: "copy", note: why };
  }
}

function lrcOf(lines: Array<{ at_seconds: number; text: string }>): string {
  const stamp = (s: number): string => {
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
  };
  return `${lines.map((l) => `[${stamp(l.at_seconds)}] ${l.text}`).join("\n")}\n`;
}

/** A track's files into `dir` ("" or "tracks/01 - Title/"): its lyrics, analysis.json and audio
 *  first, track.json last, whatever happened before it, with what of its own was left out.
 *  `kind`: "final" for a track's own export, whose last file it is. */
async function writeTrackFiles(
  env: ExportEnv,
  w: ExportWriter,
  put: Put,
  dir: string,
  t: ExportTarget,
  opts: ExportOptions,
  rec: Awaited<ReturnType<typeof trackRecordOf>>,
  extra: Record<string, unknown>,
  kind: WriteKind,
): Promise<void> {
  let audio: Record<string, unknown> = { mode: opts.audio };
  try {
    const lyrics = rec.track["lyrics"] as {
      lines?: Array<{ at_seconds: number; text: string }>;
      plain?: string | null;
    } | null;
    if (lyrics?.lines?.length) put(`${dir}lyrics.lrc`, lrcOf(lyrics.lines), "record");
    if (lyrics?.plain) put(`${dir}lyrics.txt`, `${lyrics.plain.trim()}\n`, "record");
    if (rec.analysis)
      put(
        `${dir}analysis.json`,
        json(opts.redact ? redacted(rec.analysis) : rec.analysis),
        "record",
      );
    audio = await writeAudio(env, w, put, dir, t, opts);
  } catch (e) {
    put.leftOut.push(`${dir || "the track"}: stopped early, ${(e as Error).message}`);
  }
  const leftOut = put.leftOut.filter((l) => l.startsWith(dir));
  const track = { ...rec.track, ...extra, audio, missing: rec.missing, left_out: leftOut };
  put(`${dir}track.json`, json(opts.redact ? redacted(track) : track), kind);
}

/** The album's release group on MusicBrainz, from its notes' address. */
const releaseGroupOf = (notes: Looked<AlbumInfo>): string | null =>
  notes.kind === "found"
    ? (/\/release-group\/([0-9a-f-]{36})/.exec(notes.value.musicbrainzUrl ?? "")?.[1] ?? null)
    : null;

/** The release's scans for an album whose notes name its release group; null with no notes. */
function releaseArtOf(
  env: ExportEnv,
  notes: Looked<AlbumInfo>,
  tracks: number | null,
  budget: Budget,
): Promise<Looked<ReleaseArt>> | null {
  const group = releaseGroupOf(notes);
  return group ? budget.look((fill) => env.releaseArt(group, tracks, fill)) : null;
}

/** Notes on the album and the artist, when known or asked for under the budget; with no name to
 *  ask with (an untagged track), said as a lookup that can't be made, never as MusicBrainz's
 *  none. */
async function notesOf(
  env: ExportEnv,
  albumArtist: string | null,
  album: string | null,
  artist: string | null,
  of: "track" | "album",
  budget: Budget,
) {
  const [albumNotes, artistNotes] = await Promise.all([
    !album
      ? Promise.resolve<Looked<AlbumInfo>>(cannotAsk(of, "album"))
      : !albumArtist
        ? Promise.resolve<Looked<AlbumInfo>>(cannotAsk(of, "artist"))
        : budget.look((fill) => env.albumNotes(albumArtist, album, fill)),
    artist
      ? budget.look((fill) => env.artistNotes(artist, fill))
      : Promise.resolve<Looked<ArtistInfo>>(cannotAsk(of, "artist")),
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

/** The analysis an earlier call started, by album and the tracks asked about: the tracks' state
 *  when it was asked for (or when the run was seen to end), and whether it has ended. Called
 *  again while the window is still at it, the export answers "analyzing" again (how far it has
 *  got, never since when: another run, analyze_album's, may have started since); called once the
 *  run has ended, it goes ahead, and a track the run couldn't measure is said to be one (an AAC
 *  file measures its waveform only; DSD can't be decoded) instead of "analyzing" for good. */
const startedFor = new Map<string, { state: string; ended: boolean }>();
const stateOf = (an: AudioAnalysis | null): string =>
  an == null ? "none" : analysisOutdated(an) ? "outdated" : "current";

/** With fill, an album with tracks to measure starts its analysis and answers "call again" until
 *  the window's run ends, once for each state of its tracks; `tried` gets the tracks a finished
 *  run couldn't measure. */
async function analysisFirst(
  env: ExportEnv,
  serverUdn: string,
  album: MediaNode | null,
  tracks: MediaNode[],
  tried: Set<string>,
): Promise<ExportReply | null> {
  if (!album) return null;
  const unmeasured = tracks.filter((n) => !isCurrent(env.analysis(n)));
  if (unmeasured.length === 0) return null;
  // by the tracks asked about too: a track's export and its album's are separate questions
  const key = `${serverUdn}|${album.id}|${tracks.map((n) => n.id).join(",")}`;
  const state = tracks.map((n) => `${n.id}:${stateOf(env.analysis(n))}`).join(",");
  const prior = startedFor.get(key);
  const run = env.analysisRun(serverUdn, album.id);
  if (prior && run === "running") {
    const measured = tracks.length - unmeasured.length;
    const sofar =
      tracks.length === 1
        ? "this track isn't measured yet"
        : `${measured} of ${tracks.length} tracks measured`;
    return {
      kind: "analyzing",
      message: `Still analyzing "${album.title}": ${sofar}. Call again in a few minutes with the same arguments; get_track_analysis says when each track is measured.`,
    };
  }
  // the run it started has ended: what it couldn't measure, it can't
  if (prior && run === "idle" && (!prior.ended || prior.state === state)) {
    startedFor.set(key, { state, ended: true });
    for (const n of unmeasured) tried.add(n.id);
    return null;
  }
  const possible = await env.analysisPossible(serverUdn);
  if (!possible.ok) return null;
  if ("why" in env.startAnalysis(serverUdn, album.id)) return null;
  startedFor.set(key, { state, ended: false });
  return {
    kind: "analyzing",
    message: `Analyzing "${album.title}" first (${unmeasured.length} ${unmeasured.length === 1 ? "track" : "tracks"} to measure, one at a time, in the TastyTunes window). Call again in a few minutes with the same arguments; get_track_analysis says when each track is measured.`,
  };
}

/** Measured as far as it can be, by the window's own rule (shared/model analysisOutdated): a file
 *  read only for its waveform is settled, not waiting. */
const isCurrent = (an: AudioAnalysis | null): boolean => an != null && !analysisOutdated(an);

/** The reply: the folder, its files, what is missing, what was left out. */
function replyOf(w: ExportWriter, put: Put, missing: Missing[]): ExportReply {
  return { kind: "exported", folder: w.dir, files: w.files(), missing, left_out: put.leftOut };
}

export function exportTrack(
  env: ExportEnv,
  root: string,
  t: ExportTarget,
  opts: ExportOptions,
): Promise<ExportReply> {
  return oneAtATime(async () => {
    const pools = env.pools();
    const album = albumOf(t, pools);
    const tried = new Set<string>();
    if (opts.fill) {
      const wait = await analysisFirst(env, t.serverUdn, album, [t.node], tried);
      if (wait) return wait;
    }
    const w = writerFor(env, root, [t.node.artist, t.node.album, t.node.title]);
    const put = putter(w);
    put("README.md", exportReadme("track", opts), "final");
    const budget = new Budget(env.clock, opts.fill);
    const missing: Missing[] = [];
    const extra: Record<string, unknown> = {
      exported_at: env.localTime(env.now().getTime()),
      redacted: opts.redact,
    };
    let rec: Awaited<ReturnType<typeof trackRecordOf>> | null = null;
    try {
      const shared = await sharedFrom(env);
      rec = await trackRecordOf(env, t, opts, shared, budget, tried);
      missing.push(...rec.missing);
      const albumArtist = t.node.albumArtist ?? t.node.artist;
      const artist = performerOf(t.node);
      const notes = await notesOf(env, albumArtist, t.node.album, artist, "track", budget);
      missing.push(
        ...[
          gapOf(notes.albumNotes, LOOKUPS.albumNotes),
          gapOf(notes.artistNotes, LOOKUPS.artistNotes),
        ].filter((m): m is Missing => m != null),
      );
      const pool = env.pools().find((p) => p.udn === t.serverUdn);
      const albumTracks = album && pool ? albumTracksOf(album, pool).length || null : null;
      const release = await releaseArtOf(env, notes.albumNotes, albumTracks, budget);
      missing.push(
        ...(await writePictures(
          env,
          put,
          album,
          album?.artUrl ?? t.node.artUrl,
          { serverUdn: t.serverUdn, objectId: t.node.id },
          artist,
          t.node.album,
          opts,
          budget,
          release,
        )),
      );
      const presets = album?.artUrl ? env.presets().filter((p) => p.artUrl === album.artUrl) : [];
      Object.assign(extra, {
        album_notes: notes.albumOut,
        artist_notes: notes.artistOut,
        presets_holding_album: presets.map((p) => ({ slot: p.id, name: p.name })),
        pictures: "pictures/pictures.json",
      });
    } catch (e) {
      put.leftOut.push(`the export stopped early: ${(e as Error).message}`);
    }
    if (rec) await writeTrackFiles(env, w, put, "", t, opts, { ...rec, missing }, extra, "final");
    else {
      const partial = { format: EXPORT_FORMAT, ...extra, missing, left_out: [...put.leftOut] };
      put("track.json", json(opts.redact ? redacted(partial) : partial), "final");
    }
    return replyOf(w, put, missing);
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
    const tried = new Set<string>();
    if (opts.fill) {
      const wait = await analysisFirst(env, a.serverUdn, a.node, tracks, tried);
      if (wait) return wait;
    }
    const w = writerFor(env, root, [a.node.artist, a.node.title]);
    const put = putter(w);
    put("README.md", exportReadme("album", opts), "final");
    const budget = new Budget(env.clock, opts.fill);
    const missing: Missing[] = [];
    const done: Array<{
      folder: string;
      node: MediaNode;
      record: Awaited<ReturnType<typeof trackRecordOf>>;
    }> = [];
    const compilation = isCompilation(a.node, tracks);
    const artist = compilation ? null : a.node.artist;
    let notes: Awaited<ReturnType<typeof notesOf>> | null = null;
    let shared: Shared | null = null;
    let tracksLate = false;
    try {
      shared = await sharedFrom(env);
      // the album's notes, then every track's lookups, and only then the release's scans and the
      // artist's pictures, listed after them and fetched on their own time: a slow archive can't
      // spend the tracks' lyrics and credits, and the next export, the lookups kept, gets further
      notes = await notesOf(env, a.node.artist, a.node.title, artist, "album", budget);
      if (compilation)
        missing.push({
          what: "artist notes and pictures",
          why: "A compilation has no one artist.",
          remedy: "Export one of its tracks for its artist's.",
        });
      else {
        const artistGap = gapOf(notes.artistNotes, LOOKUPS.artistNotes);
        if (artistGap) missing.push(artistGap);
      }
      for (const [i, n] of tracks.entries()) {
        const t = { node: n, serverUdn: a.serverUdn, serverName: a.serverName };
        const folder = `tracks/${String(i + 1).padStart(2, "0")} - ${safeName(n.title)}/`;
        try {
          const rec = await trackRecordOf(env, t, opts, shared, budget, tried);
          await writeTrackFiles(
            env,
            w,
            put,
            folder,
            t,
            opts,
            rec,
            { position: trackPosition(n) },
            "record",
          );
          done.push({ folder: folder.slice(0, -1), node: n, record: rec });
        } catch (e) {
          // not in album.json's tracks, so said here
          put.leftOut.push(
            `${folder.slice(0, -1)}: not exported, its record couldn't be made (${(e as Error).message})`,
          );
        }
      }
      tracksLate = budget.late > 0;
      const release = await releaseArtOf(env, notes.albumNotes, tracks.length, budget);
      missing.push(
        ...(await writePictures(
          env,
          put,
          a.node,
          a.node.artUrl,
          tracks[0] ? { serverUdn: a.serverUdn, objectId: tracks[0].id } : null,
          artist,
          a.node.title,
          opts,
          budget,
          release,
        )),
      );
    } catch (e) {
      put.leftOut.push(`the export stopped early: ${(e as Error).message}`);
    }
    const albumRec = buildAlbumRecord({
      album: a.node,
      serverUdn: a.serverUdn,
      serverName: a.serverName,
      tracks: done,
      notes: notes?.albumNotes ?? { kind: "not_asked" },
      measured: env.albumMeasured(a.node),
      hearted:
        shared?.favorites.has(
          favoriteContentKey({
            kind: "album",
            title: a.node.title,
            artist: a.node.artist,
            album: null,
          }),
        ) ?? false,
    });
    missing.unshift(...albumRec.missing);
    if (tracksLate)
      missing.push({
        what: "lookups for the later tracks",
        why: `The lookups stopped after ${LOOKUP_BUDGET_MS / 1000} seconds of asking, so the answer comes in time.`,
        remedy: AGAIN_FOR_THE_REST,
      });
    const presets = a.node.artUrl ? env.presets().filter((p) => p.artUrl === a.node.artUrl) : [];
    const album = {
      ...albumRec.album,
      artist_notes: notes?.artistOut ?? null,
      presets_holding_album: presets.map((p) => ({ slot: p.id, name: p.name })),
      pictures: "pictures/pictures.json",
      exported_at: env.localTime(env.now().getTime()),
      redacted: opts.redact,
      missing,
      left_out: [...put.leftOut],
    };
    put("album.json", json(opts.redact ? redacted(album) : album), "final");
    return replyOf(w, put, missing);
  });
}
