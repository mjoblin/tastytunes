// Media servers and what they hold: servers, the index's status, nodes and their formats,
// the album and track rules (performers, compilations, track order, discs), artist and
// album summaries, the info lookups and queueing actions, and name and title sorting.

// ------------------------------------------------------------------ media browser

export interface MediaServerInfo {
  udn: string;
  name: string;
  model: string | null;
  /** True when this "server" is the connected streamer itself (USB storage). */
  isStreamer: boolean;
  /** True when the server answers ContentDirectory Search (non-empty SearchCaps). */
  searchable: boolean;
}

/** The streamer's own USB server, by its shape: on the device's address and
 *  Browse-only (the Evo's answers no Search). Its audio is out of reach by
 *  design, its ContentDirectory hands out device-internal file paths, so the
 *  analysis verbs refuse it up front (USB_ANALYSIS_HINT says why). */
export const usbServer = (s: Pick<MediaServerInfo, "isStreamer" | "searchable">): boolean =>
  s.isStreamer && !s.searchable;

/**
 * Per-server state of the local media index — a REBUILDABLE CACHE of server
 * metadata (never user data): built by crawling ContentDirectory, invalidated
 * wholesale when the server's SystemUpdateID moves (or a TTL passes), gone
 * without loss if deleted. Searchable servers crawl via paged Search
 * (seconds); Browse-only servers build on demand by walking containers.
 */
export interface MediaIndexStatus {
  udn: string;
  serverName: string;
  /** 'failed': the last build produced nothing (the server refused Search AND Browse — offline, or mid-scan); `failure` says why. */
  state: "none" | "building" | "ready" | "failed";
  failure?: string;
  /** While building: the app started this build on its own to keep an index it already
   *  had honest (the server's counter moved, the TTL passed, the schema changed, a stale id
   *  was revalidated before an answer was trusted). The doors show it as any build; the
   *  indexing toast never announces it (user, 2026-09-15: the streamer's USB ids rotate
   *  across every standby, and each revalidation toasted "streamer indexed · 0 tracks"). */
  quiet?: boolean;
  /** The server's counter moved since this index was built and the app will not walk
   *  it on its own (the streamer's USB server, 2026-09-16): the card offers the re-index. */
  stale?: boolean;
  /** Something someone asked for (a playlist, a favorite, Open in Library, Info, an
   *  agent's play) has waited over a second while this index is moved and checked, or
   *  walked, after the server's ids moved: the streamer's USB server after a standby or a
   *  replug (the user's Evo, 2026-10-06: about 20 s while a cold drive's folders are
   *  listed). The working toast says so. */
  waiting?: boolean;
  /** The server answers UPnP Search itself, so the Library's search box reaches it with
   *  no index; a Browse-only server (the streamer's USB stick) has no search until its
   *  index is built. The Search screen's unindexed line says which (user, 2026-09-17). */
  searchable?: boolean;
  strategy: "search" | "browse" | null;
  tracks: number;
  albums: number;
  artists: number;
  builtAt: number | null;
  updateId: number | null;
  profile?: MediaServerProfile;
  /** The server's own Recently added list (0.13.0 round 9; shared/recentlyAdded): the one in
   *  use, found by its name or chosen by the reader, or null; `recentOff` when the reader turned
   *  it off in Settings › Libraries. */
  recentList?: { title: string; chosen: boolean } | null;
  recentOff?: boolean;
  /** When the list was last read: the Library's pools are fetched again when it changes. */
  recentAt?: number | null;
}

export interface MediaNode {
  id: string;
  parentId: string | null;
  title: string;
  /**
   * The folder titles from the source's root to this node's container, the
   * container's own title last (an album's path ends with the album folder; a
   * track's is its album folder's), recorded when the media index WALKED a
   * folder tree (the streamer's USB drive, a plain-folder server). Absent for
   * search-built entities, whose views are virtual. Open in Library lands on
   * it, and the Library's browse re-walks it when the stored id has rotted.
   */
  titlePath?: string[];
  /** An album's arrival in its index (0.13.0 round 9, shared/recentlyAdded): the day the app
   *  first saw it, absent when it was there before the app began noting arrivals. */
  addedAt?: number;
  /** An album's place in its server's own Recently added list (0 first), when the list names it. */
  recentRank?: number;
  upnpClass: string;
  isContainer: boolean;
  artUrl: string | null;
  artist: string | null;
  album: string | null;
  /** Release year, when the server sends dc:date (Asset does; the USB server doesn't). */
  year: string | null;
  trackNumber: number | null;
  durationSecs: number | null;
  /**
   * upnp:originalDiscNumber / originalDiscCount, when the server sends them
   * (Asset does; it ALSO packs disc×100+track into originalTrackNumber — 212
   * for disc 2 track 12 — so read positions through trackPosition()).
   */
  discNumber?: number;
  discCount?: number;
  /**
   * PROVISIONAL, a parse's guess for the pool rule discs-from-file-names (main/media/reconcile)
   * and never kept: the disc a track's file name gives ("2-11 Close Your Eyes.flac", the second
   * number its track number), read only when the server sent no disc (MinimServer sends none,
   * 0.12.0-rc.3, a user's box sets). The rule promotes it to discNumber only when every track
   * of the album agrees, and drops it either way.
   */
  fileDisc?: number;
  /**
   * The audio format of the primary <res>, when the server describes it
   * (DLNA attributes: protocolInfo mime, bitsPerSample, sampleFrequency,
   * bitrate in BYTES/s per the UPnP spec, size). Asset sends all of them
   * (live 2026-08-15); the streamer's USB server sends duration only.
   */
  format?: MediaFormat;
  /**
   * upnp:genre values, when the server sends any (multi-valued — real tags
   * repeat the element). Raw tagger data: case-normalize before faceting.
   * Absent (not empty) when the server offers none.
   */
  genre?: string[];
  /**
   * The album artist, when the server says so (Asset: upnp:artist
   * role="AlbumArtist"). Absent otherwise. This — not `artist` — is what
   * decides whether a track belongs to an album under an artist: a featured
   * track's `artist` reads "Daft Punk; Julian Casablancas" while its album
   * artist is Daft Punk.
   */
  albumArtist?: string;
  /**
   * The performers as separate names, when `artist` packs more than one
   * ("A; B" → ["A", "B"]). Absent for a single performer — read identity
   * through a helper that falls back to [artist], never off this alone.
   */
  artists?: string[];
  /**
   * upnp:artist role="Composer", split on "; " (Asset: "Thomas Bangalter;
   * Guy-Manuel de Homem-Christo"). Not performers — never an artist row;
   * searchable, and an album that shares one composer says so in its facts.
   */
  composers?: string[];
  /**
   * Which server this node came from — stamped ONLY on cross-server search
   * results, where nodes from several servers share a listing. Everywhere
   * else the screen's own server context applies and these stay absent.
   */
  serverUdn?: string;
  serverName?: string;
}

export interface MediaFormat {
  /** Codec label from the mime type: FLAC, MP3, AAC, ALAC, WAV, PCM, AIFF, WMA, OGG, Opus, DSD — or the bare subtype. */
  codec: string;
  bits?: number;
  /** Sample rate in Hz. */
  rate?: number;
  /** Stream bitrate in kbps (the spec's bytes/s ×8 /1000). */
  kbps?: number;
  sizeBytes?: number;
  channels?: number;
}

/**
 * The codecs whose bit depth is meaningful (a lossy stream has a bitrate, not
 * a word length). ONE list (2026-08-16): the parser consults it to decide
 * whether bitsPerSample is stored at all, and formatLabel to decide whether
 * to say "16/44.1" or "320 kbps" — two copies once disagreed only by luck.
 */
export const LOSSLESS_CODECS: ReadonlySet<string> = new Set([
  "FLAC",
  "WAV",
  "PCM",
  "AIFF",
  "ALAC",
  "DSD",
  "APE",
  "WV",
]);
const LOSSLESS = LOSSLESS_CODECS;

/**
 * Hi-res, ONE definition (2026-08-16): above CD-class — more than 16 bits or
 * more than 48 kHz (48 k counts as CD-class, not hi-res) — or MQA. The Now
 * Playing signal lamp, the library's album summary and the MCP list_albums
 * filter all ask this; the lamp once carried MQA and the summary did not.
 */
export const HIRES_BITS_ABOVE = 16;
export const HIRES_RATE_ABOVE = 48_000;
export function isHiRes(f: {
  bits?: number | null;
  rate?: number | null;
  mqa?: string | null;
}): boolean {
  return (
    (f.bits ?? 0) > HIRES_BITS_ABOVE ||
    (f.rate ?? 0) > HIRES_RATE_ABOVE ||
    (f.mqa != null && f.mqa !== "none")
  );
}

/** The separator between facts on one line: EN spaces around the dot, so the items breathe (user,
 *  2026-09-01; app-wide for facts and status lines 2026-10-07) — plain double spaces would
 *  collapse in HTML. Shared so the main process's menu reads the same. Not for formatLabel below:
 *  albumFormatChips splits its " · " back into chips. */
export const FACT_SEP = "\u2002·\u2002";

/** "FLAC · 16/44.1" for lossless (bits/kHz), "MP3 · 320 kbps" for lossy; degrades to what is known. */
export function formatLabel(f: MediaFormat | undefined | null): string | null {
  if (!f) return null;
  const khz = f.rate ? `${(f.rate / 1000).toFixed(f.rate % 1000 === 0 ? 0 : 1)}` : null;
  if (LOSSLESS.has(f.codec)) {
    const detail =
      f.bits && khz ? `${f.bits}/${khz}` : khz ? `${khz} kHz` : f.bits ? `${f.bits}-bit` : null;
    return detail ? `${f.codec} · ${detail}` : f.codec;
  }
  return f.kbps ? `${f.codec} · ${f.kbps} kbps` : f.codec;
}

/**
 * An album's format at a glance: the label every track shares, or the one
 * MOST tracks share (then the odd ones out get their own note); nothing
 * when formats are genuinely mixed or unknown. Returned alongside the
 * per-track notes so a header and its rows can never disagree.
 */
export function albumFormat(tracks: ReadonlyArray<Pick<MediaNode, "format">>): {
  label: string | null;
  /** For each input track, the note a row should carry — null when it matches the headline. */
  notes: (string | null)[];
} {
  const labels = tracks.map((t) => formatLabel(t.format));
  const counts = new Map<string, number>();
  for (const l of labels) if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  if (counts.size === 0) return { label: null, notes: labels.map(() => null) };
  const [top, n] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
  const known = labels.filter(Boolean).length;
  // THE PREDOMINANT FORMAT HEADLINES when at least half the tracks share it,
  // and every other track says what IT is; with no predominant format the
  // headline is "mixed formats" and every track says. The user's ruling
  // (2026-08-16, after a stricter odd-one-out cut hid information they
  // wanted): the point of the row notes is to SEE the exceptions, however
  // many there are.
  if (counts.size > 1 && n * 2 < known)
    return { label: "mixed formats", notes: labels.map((l) => l ?? null) };
  return { label: top, notes: labels.map((l) => (l && l !== top ? l : null)) };
}

/**
 * How a track row names its performers INSIDE AN ALBUM under its artist:
 * the album artist, then the guests as "feat." — "Daft Punk feat. Julian
 * Casablancas". Anywhere else (search, queue, a compilation) the raw packed
 * string is the honest thing to show, so this returns it unchanged unless
 * the album artist is among the performers and there are others.
 */
export function performerLine(
  n: Pick<MediaNode, "artist" | "artists" | "albumArtist">,
  albumArtist: string | null | undefined,
): string | null {
  const names = trackArtists(n);
  if (!albumArtist || names.length < 2) return n.artist;
  const key = albumArtist.trim().toLowerCase();
  const lead = names.find((x) => x.trim().toLowerCase() === key);
  if (!lead) return n.artist;
  const guests = names.filter((x) => x !== lead);
  return guests.length > 0 ? `${lead} feat. ${guests.join(", ")}` : n.artist;
}

const VARIOUS = /^(various(\s+artists?)?|va|v\.a\.|verschiedene(\s+interpreten)?|divers)$/i;

/**
 * Is this album a COMPILATION? Named so by its album artist ("Various
 * Artists" and friends), or — when the tracks are known — credited to an
 * album artist none of its performers is (a soundtrack under a label name);
 * an album whose guests join its own artist ("Daft Punk feat. …") is NOT.
 */
export function isCompilation(
  album: Pick<MediaNode, "artist">,
  tracks?: ReadonlyArray<Pick<MediaNode, "artist" | "artists" | "albumArtist">>,
): boolean {
  const owner = album.artist?.trim() ?? "";
  if (VARIOUS.test(owner)) return true;
  if (!tracks || tracks.length < 2 || !owner) return false;
  const key = owner.toLowerCase();
  const performerSets = tracks.map((t) => trackArtists(t).map((x) => x.trim().toLowerCase()));
  const anyOwner = performerSets.some((set) => set.includes(key));
  const distinct = new Set(performerSets.map((set) => set.join("|"))).size;
  return !anyOwner && distinct >= 2;
}

/** The composers every track shares (order of first appearance), or [] when they differ or are unknown. */
export function albumComposers(tracks: ReadonlyArray<Pick<MediaNode, "composers">>): string[] {
  const known = tracks.filter((t) => t.composers && t.composers.length > 0);
  if (known.length === 0 || known.length < tracks.length) return [];
  const first = known[0].composers!.map((x) => x.trim().toLowerCase());
  const same = known.every((t) => {
    const c = t.composers!.map((x) => x.trim().toLowerCase());
    return c.length === first.length && c.every((x) => first.includes(x));
  });
  return same ? known[0].composers! : [];
}

/**
 * The tracks that belong to an album, from an index pool: same title on the
 * same server, and — when the pool holds TWIN EDITIONS (same title, same
 * artist) — sharing the album's art. In album order. THE one derivation of
 * "an album's tracks": the Info modal, MCP and the lenses' index (tracksOf:
 * the Albums lens's play tallies and Format facet, the compilations, the
 * Artists lens's album column) all read it (S13/S16 pin it).
 * WHO ELSE CLAIMS THE TITLE decides how strictly a track's credit is read
 * (0.13.0-rc.3). Where another album on the server has the same title (two
 * artists' "Greatest Hits", two copies), a track must be credited to this
 * album's artist (trackInAlbumOf). An album alone under its title takes every
 * track of that title but one whose album artist names someone else: a
 * compilation's tracks credit their own performers, and a server without an
 * AlbumArtist role sends nothing else to tell by, so the strict reading left
 * such an album with no tracks (no plays, no format).
 */
export function albumTracksOf(
  album: Pick<MediaNode, "title" | "artist" | "artUrl">,
  pool: {
    albums: ReadonlyArray<Pick<MediaNode, "title" | "artist">>;
    tracks: ReadonlyArray<MediaNode>;
  },
): MediaNode[] {
  const title = album.title.trim().toLowerCase();
  const owner = (album.artist ?? "").trim().toLowerCase();
  const peers = pool.albums.filter((a) => a.title.trim().toLowerCase() === title);
  const twins = peers.filter((a) => (a.artist ?? "").trim().toLowerCase() === owner).length > 1;
  const credited = (t: MediaNode): boolean =>
    peers.length > 1
      ? trackInAlbumOf(t, album.artist ?? null)
      : album.artist == null || !t.albumArtist || t.albumArtist.trim().toLowerCase() === owner;
  return orderTracks(
    pool.tracks.filter(
      (t) =>
        (t.album ?? "").trim().toLowerCase() === title &&
        credited(t) &&
        (!twins || sameArt(t.artUrl, album.artUrl)),
    ),
  );
}

/**
 * The album node a pool track belongs to — the inverse of albumTracksOf:
 * same title, and the track's performers pass trackInAlbumOf against the
 * album's credited artist (twin editions fall back to the first match).
 * Null when the index holds no such album. Content identity, no network:
 * the Tracks lens's album link enters the album through the lens crumb.
 */
export function albumOfTrack(
  track: Pick<MediaNode, "album" | "artist" | "artists" | "albumArtist">,
  pool: { albums: MediaNode[] },
): MediaNode | null {
  if (!track.album) return null;
  const want = track.album.trim().toLowerCase();
  const matches = pool.albums.filter((a) => a.title.trim().toLowerCase() === want);
  return matches.find((a) => trackInAlbumOf(track, a.artist)) ?? matches[0] ?? null;
}

/**
 * The index's own entry for an album that arrived with only its id and title (Open in Library,
 * Go to album, a favorite: the Library's stand-in node, 0.12.0-rc.2): the album with that id on
 * the server, else the one album of that title there. Its artist, art and year make the album's
 * keys (DR, sweep, art, favorite) the ones the Albums lens uses for the same album. Null when the
 * index cannot say (two albums of that title, or none).
 */
export function indexAlbumFor(
  album: Pick<MediaNode, "id" | "title">,
  pool: { albums: MediaNode[] },
): MediaNode | null {
  const byId = pool.albums.find((a) => a.id === album.id);
  if (byId) return byId;
  const want = album.title.trim().toLowerCase();
  const same = pool.albums.filter((a) => a.title.trim().toLowerCase() === want);
  return same.length === 1 ? same[0] : null;
}

/**
 * How many tracks share a track's disc on its album, as the index knows it: the "of 12" of the
 * Info modal's "track 4 of 12" (0.12.0). A track's number counts within its disc, so the count
 * does too; an album with no disc numbers counts whole. Null when the index holds no album.
 */
export function discTrackCount(
  track: Pick<MediaNode, "album" | "artist" | "artists" | "albumArtist" | "discNumber">,
  pool: { albums: MediaNode[]; tracks: ReadonlyArray<MediaNode> },
): number | null {
  const album = albumOfTrack(track, pool);
  return album ? discCountIn(track, albumTracksOf(album, pool)) : null;
}

/** The same count from an album's own listing (a browsed album, which has no index pools).
 *  Null, so no "of", when the album has no disc numbers and its track numbers repeat: the
 *  numbers count within discs the server never named, and the whole album's count would say
 *  "track 11 of 143" of a box set's eleventh track (0.12.0-rc.3, a user's MinimServer). */
export function discCountIn(
  track: Pick<MediaNode, "discNumber">,
  albumTracks: ReadonlyArray<Pick<MediaNode, "discNumber" | "trackNumber">>,
): number | null {
  const disc = track.discNumber ?? null;
  if (disc == null) {
    const seen = new Set<number>();
    for (const t of albumTracks) {
      const pos = trackPosition(t);
      if (pos == null) continue;
      if (seen.has(pos)) return null;
      seen.add(pos);
    }
  }
  const onDisc =
    disc == null ? albumTracks : albumTracks.filter((t) => (t.discNumber ?? 1) === disc);
  return onDisc.length > 0 ? onDisc.length : null;
}

/**
 * Order an album's tracks: by (disc, position) when that key is UNIQUE across
 * the list, otherwise the LISTING ORDER stands. minidlna (rig-verified
 * 2026-08-16) sends no disc number and per-disc track numbers — a two-disc
 * set is 1, 2, 1, 2 — but its Browse order is disc-then-track; sorting by the
 * numbers alone interleaved the discs (d1t1, d2t1, d1t2, …). Duplicate keys
 * mean the numbers cannot say more than the server already has; the sort
 * cannot improve on the listing and can only scramble it. Every sort of an
 * album's tracks goes through here (leaf, lens, albumTracksOf).
 */
export function orderTracks<T extends Pick<MediaNode, "trackNumber" | "discNumber">>(
  tracks: ReadonlyArray<T>,
): T[] {
  const seen = new Set<string>();
  let repeats = false;
  for (const t of tracks) {
    const pos = trackPosition(t);
    if (pos == null) continue;
    const key = `${t.discNumber ?? 1}:${pos}`;
    if (seen.has(key)) {
      repeats = true;
      break;
    }
    seen.add(key);
  }
  if (!repeats) return [...tracks].sort(compareTrackOrder);
  // Repeats: the listing order stands ONLY when it reads as discs — ascending
  // runs, each restarting lower than the last position (Browse of a minidlna
  // or MinimServer album). A search-built index lists by title (Gerbera,
  // Minim) and that order says nothing about discs; sort by position then,
  // interleaved but ordered (survey 2026-08-17: OKNOTOK came out alphabetical).
  const positions = tracks.map(trackPosition);
  let ascendingRuns = true;
  let restarts = 0;
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i - 1];
    const b = positions[i];
    if (a == null || b == null) continue;
    if (b < a) restarts++;
    else if (b === a) {
      ascendingRuns = false;
      break;
    }
  }
  if (ascendingRuns && restarts > 0 && restarts < positions.length / 2) return [...tracks];
  return [...tracks].sort(compareTrackOrder);
}

/** Everything an album's tracks add up to — the leaf's facts, the lens heading, the Info modal and MCP all read this. */
export function albumSummary(
  album: Pick<MediaNode, "artist">,
  tracks: MediaNode[],
): {
  tracks: number;
  discs: number;
  runtimeSecs: number;
  sizeBytes: number;
  format: string | null;
  /** how many tracks differ from the format headline */
  formatOdd: number;
  hires: boolean;
  composers: string[];
  isCompilation: boolean;
} {
  const fmt = albumFormat(tracks);
  return {
    tracks: tracks.length,
    discs: discGroups(tracks).filter((g) => g.disc != null).length || (tracks.length > 0 ? 1 : 0),
    runtimeSecs: tracks.reduce((a, t) => a + (t.durationSecs ?? 0), 0),
    sizeBytes: tracks.reduce((a, t) => a + (t.format?.sizeBytes ?? 0), 0),
    format: fmt.label,
    formatOdd: fmt.notes.filter(Boolean).length,
    hires: tracks.some((t) => t.format != null && isHiRes(t.format)),
    composers: albumComposers(tracks),
    isCompilation: isCompilation(album, tracks),
  };
}

/** 940 MB, 1.2 GB — for album/playlist size sums. */
export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * A track's performers as separate names — the ONLY way to ask "who is on
 * this track": `artists` when the server packed several, else the single
 * `artist`. Never key identity on the packed string ("A; B" is two people).
 */
export function trackArtists(n: Pick<MediaNode, "artist" | "artists">): string[] {
  if (n.artists && n.artists.length > 0) return n.artists;
  return n.artist ? [n.artist] : [];
}

/**
 * Does this track belong to an album credited to `albumArtist`? The album
 * artist wins when the server sends one (a featured track's performers are
 * "Daft Punk; Julian Casablancas"; its album is Daft Punk's); otherwise any
 * performer matching counts (servers without an AlbumArtist role — the USB
 * stick); a track with no artist at all is not held against the album.
 */
export function trackInAlbumOf(
  n: Pick<MediaNode, "artist" | "artists" | "albumArtist">,
  albumArtist: string | null,
): boolean {
  if (albumArtist == null) return true;
  const want = albumArtist.trim().toLowerCase();
  if (n.albumArtist) return n.albumArtist.trim().toLowerCase() === want;
  const names = trackArtists(n);
  if (names.length === 0) return true;
  return names.some((a) => a.trim().toLowerCase() === want);
}

/**
 * The track's position WITHIN ITS DISC — the number a row should show. Asset
 * packs disc×100+track into originalTrackNumber for multi-disc albums (live:
 * 113 = disc 1 track 13, 212 = disc 2 track 12); when the disc number agrees
 * with that packing the hundreds are the disc, not the track. Servers that
 * send a plain track number alongside the disc are returned as-is.
 */
export function trackPosition(n: Pick<MediaNode, "trackNumber" | "discNumber">): number | null {
  const t = n.trackNumber;
  if (t == null) return null;
  // a packed number is never a multiple of 100 (no track 0): track 100 of a long disc 1 is 100
  if (n.discNumber != null && t >= 100 && t % 100 !== 0 && Math.floor(t / 100) === n.discNumber)
    return t % 100;
  return t;
}

/**
 * Album order: disc, then position. Tracks without a disc sort as disc 1;
 * without a position they keep their listing order after the numbered ones.
 */
export function compareTrackOrder(
  a: Pick<MediaNode, "trackNumber" | "discNumber">,
  b: Pick<MediaNode, "trackNumber" | "discNumber">,
): number {
  const da = a.discNumber ?? 1;
  const db = b.discNumber ?? 1;
  if (da !== db) return da - db;
  const pa = trackPosition(a);
  const pb = trackPosition(b);
  if (pa == null && pb == null) return 0;
  if (pa == null) return 1;
  if (pb == null) return -1;
  return pa - pb;
}

/** Consecutive runs of one disc, for the quiet "Disc N" dividers — only when the list actually spans discs. */
export function discGroups<T extends Pick<MediaNode, "discNumber">>(
  tracks: T[],
): { disc: number | null; tracks: T[] }[] {
  // "no disc" IS disc 1 (that is how compareTrackOrder sorts it too) — an
  // album where some tracks say disc 1 and the rest say nothing is one disc,
  // not an alternation of dividers (two GUNSHIP editions, 2026-08-16)
  const discs = new Set(tracks.map((t) => t.discNumber ?? 1));
  if (discs.size < 2) return [{ disc: null, tracks }];
  const out: { disc: number | null; tracks: T[] }[] = [];
  for (const t of tracks) {
    const d = t.discNumber ?? 1;
    const last = out[out.length - 1];
    if (last && last.disc === d) last.tracks.push(t);
    else out.push({ disc: d, tracks: [t] });
  }
  return out;
}

/**
 * Same album ART? The way to tell two EDITIONS of one album apart when
 * title, artist and year all agree (16/44.1 and 24/44.1 GUNSHIP folders,
 * 2026-08-16): Asset stamps every track with its album folder's cover id,
 * so a track belongs to the edition whose art it shares. Compared without
 * the size query, unknown on either side counts as a match.
 */
export function sameArt(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  return a.split("?")[0] === b.split("?")[0];
}

/** An artist as the library knows them — the Info modal's artist page and MCP's get_media_info share it. */
export interface ArtistSummary {
  name: string;
  /** Albums credited to them (album artist), newest first, with a format headline when known. */
  albums: {
    title: string;
    year: string | null;
    format: string | null;
    tracks: number;
    objectId: string;
    serverUdn?: string;
  }[];
  /** Tracks they perform on (headliner or guest). */
  trackCount: number;
  /** Tracks they GUEST on — performer, but not the album artist. */
  guestOn: { title: string; album: string | null; albumArtist: string | null; objectId: string }[];
  /** Tracks they wrote (role=Composer). */
  composed: { title: string; album: string | null; objectId: string }[];
  /** Genres across their albums, most common first. */
  genres: string[];
  /** Earliest and latest album year. */
  years: [string, string] | null;
  artUrl: string | null;
}

/**
 * Everything the index says about an artist by NAME (case-insensitive) — the
 * album-artist credits, the performer credits (guest spots included), the
 * composer credits. Names that exist only as credits (a featured singer with
 * no albums of their own) get a page too.
 */
export function artistSummary(
  name: string,
  pool: { albums: ReadonlyArray<MediaNode>; tracks: ReadonlyArray<MediaNode> },
): ArtistSummary {
  const key = name.trim().toLowerCase();
  const same = (v: string | null | undefined): boolean => (v ?? "").trim().toLowerCase() === key;
  const albums = pool.albums
    .filter((a) => same(a.artist))
    .map((a) => {
      const tracks = albumTracksOf(a, pool);
      return {
        title: a.title,
        year: a.year,
        format: albumFormat(tracks).label,
        tracks: tracks.length,
        objectId: a.id,
        ...(a.serverUdn ? { serverUdn: a.serverUdn } : {}),
        artUrl: a.artUrl,
      };
    })
    .sort((x, y) => (y.year ?? "").localeCompare(x.year ?? "") || x.title.localeCompare(y.title));
  const performs = pool.tracks.filter((t) => trackArtists(t).some(same));
  // a GUEST spot is a track on someone else's album: the album owner (the
  // track's album artist, else the album's credited artist) is known and is
  // not them — a loose single with no album is simply theirs
  const ownerOf = (t: MediaNode): string | null =>
    t.albumArtist ??
    pool.albums.find(
      (a) => t.album && a.title.trim().toLowerCase() === t.album.trim().toLowerCase(),
    )?.artist ??
    null;
  const guestOn = performs
    .filter((t) => {
      const owner = ownerOf(t);
      return owner != null && !same(owner);
    })
    .map((t) => ({
      title: t.title,
      album: t.album ?? null,
      albumArtist: ownerOf(t),
      objectId: t.id,
    }));
  const composed = pool.tracks
    .filter((t) => (t.composers ?? []).some(same))
    .map((t) => ({ title: t.title, album: t.album ?? null, objectId: t.id }));
  const genreCount = new Map<string, number>();
  for (const a of pool.albums.filter((x) => same(x.artist)))
    for (const g of a.genre ?? []) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
  const genres = [...genreCount.entries()].sort((x, y) => y[1] - x[1]).map(([g]) => g);
  const yearsList = albums
    .map((a) => a.year)
    .filter((y): y is string => !!y)
    .sort();
  return {
    name: name.trim(),
    albums: albums.map(({ artUrl: _a, ...rest }) => rest),
    trackCount: performs.length,
    guestOn,
    composed,
    genres,
    years: yearsList.length > 0 ? [yearsList[0], yearsList[yearsList.length - 1]] : null,
    artUrl: albums.find((a) => a.artUrl)?.artUrl ?? null,
  };
}

/**
 * What the Info modal is looking at: a node, plus — for an album — the tracks
 * the caller already knows belong to it (the album leaf's listing, or the
 * lens's index-matched tracks), so runtime/size/format/composers can be
 * summed without a lookup. `serverName` names the source when the node
 * itself isn't stamped (screen-scoped browsing).
 */
export interface MediaInfoTarget {
  node: MediaNode;
  tracks?: MediaNode[];
  serverName?: string | null;
  /** The server the node lives on when the node itself carries no stamp —
   *  browse listings hold theirs in the screen's state (nodeUdn), and the
   *  Info modal's waveform needs it to find the file. */
  serverUdn?: string | null;
  /** A caveat to show — e.g. the item wasn't found in any library index and this is only what the list knew. */
  note?: string | null;
  /** For an artist: their library page (albums, credits) — from artistSummary. */
  artist?: ArtistSummary;
  /** For what is playing NOW: the stream as the streamer reports it (source-agnostic — radio, AirPlay, local media alike). */
  stream?: StreamInfo;
  /** What the index learned about the server this came from — how it was crawled and every reconciliation that changed something. */
  serverProfile?: MediaServerProfile;
  /** For a track: how many tracks share its disc on its album (discTrackCount), when known. */
  discTrackCount?: number;
}

/**
 * The stream the streamer is decoding right now — its own account, distinct
 * from the library's file facts (a transcode, or Asset's decoded reporting,
 * makes the two differ, and that is worth seeing).
 */
export interface StreamInfo {
  source: string | null;
  playbackSource: string | null;
  playbackClass: string | null;
  codec: string | null;
  sampleFormat: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  /** bits per second, as the streamer reports it */
  bitrate: number | null;
  encoding: string | null;
  lossless: boolean | null;
  mqa: string | null;
  station: string | null;
  radioId: string | null;
  queuePosition: number | null;
  queueLength: number | null;
  presettable: boolean | null;
  /** the transport verbs this source honours (now_playing.controls) */
  controls: string[];
}

/**
 * What a MediaRef surface (queue, favorites, playlists, recents, search)
 * can say about a thing when asking main to find its node: identity hints
 * first (server + object id), then content (title / artist / album).
 */
/**
 * Why a library lookup asks. "show": for an item's details (the waveform, Liner notes, the
 * Info modal, the resume offer), where an answer from a stale index is still right by
 * content. "act": for its id (Open in Library), which must answer on the server now. Only
 * an act confirms a Browse-built index against the device, and confirming can rebuild it:
 * the streamer's USB ids are all new after a standby, and a rebuild the user never asked
 * for was the "building…" a CXN V2 owner saw on the first track after the streamer woke
 * (user report, 2026-09-25). Required at every call, so a new caller has to choose.
 */
export type LookupPurpose = "show" | "act";

export interface MediaInfoQuery {
  kind: "track" | "album" | "artist";
  title: string;
  artist?: string | null;
  album?: string | null;
  serverUdn?: string | null;
  objectId?: string | null;
  /** See ContentRef.artUrl — the playing server, when the query has no hint. */
  artUrl?: string | null;
  /** When given, a content match must also last as long (within CONTENT_DURATION_SLACK_SECS,
   *  main/media/mediaInfo): a disc's track finding its twin in the library (0.12.0). */
  durationSecs?: number | null;
}

/** One server's slice of a cross-server (all ready indexes) search. */
export interface MediaSearchAllGroup {
  udn: string;
  serverName: string;
  /** Matches, each stamped with serverUdn/serverName. */
  items: MediaNode[];
  total: number;
}

/**
 * What the index learned about a server while crawling it — the SHAPE of its
 * answers, never its brand (2026-08-17, the UPnP server survey). Chosen from
 * what the server just did, recorded so the app can say why something looks
 * the way it does (Info › Source, MCP list_media_servers) instead of leaving
 * the user to guess: "albums synthesised from tracks — this server exposes no
 * album containers" is a sentence, not a bug report.
 */
export interface MediaServerProfile {
  /** How the index was built: paged Search, or a walk of the container tree. */
  strategy: "search" | "browse";
  /** Where the albums came from: the class search, a browse walk (search yielded no albums), or built from the tracks (no album containers anywhere). */
  albumsFrom: "search" | "browse" | "tracks";
  /** How the server answered class searches: leaf classes ('leaf'), everything as the bare base class ('generalized' — Asset), nothing derived from the asked class ('unhonoured' — Emby, UMS), or no Search at all ('unavailable'). */
  classSearch: "leaf" | "generalized" | "unhonoured" | "unavailable";
  /** Every reconciliation that changed something — FACTS, not prose: the words are made at display time by describeProfileNote(), so wording can change without re-indexing. */
  notes: ProfileNote[];
}

/** One thing the index did while reading a server. `count` where it applies. */
export type ProfileNote =
  | { kind: "navigation-entries-left-out"; what: "albums" | "artists" | "tracks"; count: number }
  | { kind: "albums-found-by-browsing"; count: number }
  | { kind: "albums-assembled-from-tracks"; count: number }
  | { kind: "duplicate-albums-merged"; count: number }
  | { kind: "years-from-tracks"; count: number }
  | { kind: "albums-from-their-tracks"; count: number }
  | { kind: "discs-from-file-names"; count: number }
  | { kind: "search-failed-browsed-instead" }
  | { kind: "search-paged-smaller" }
  | { kind: "browse-capped"; count: number };

/**
 * The words for a ProfileNote — user-facing (Info › Source, MCP), plain, no
 * UPnP vocabulary; a note exists only when something needed handling, so a
 * healthy server shows none. One home for the wording (renderer and MCP both
 * call this); changing a sentence here needs no re-index.
 */
export function describeProfileNote(note: ProfileNote): string {
  const n = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`;
  switch (note.kind) {
    case "navigation-entries-left-out":
      return note.what === "albums"
        ? `${n(note.count, "entry", "entries")} the server adds for navigation (such as “- All Albums -”) left out of the albums`
        : note.what === "artists"
          ? `${n(note.count, "navigation entry", "navigation entries")} left out of the artists`
          : `${n(note.count, "entry", "entries")} that ${note.count === 1 ? "was" : "were"} not a track left out of the tracks`;
    case "albums-found-by-browsing":
      return `the server's album search returned nothing, so ${n(note.count, "album was", "albums were")} found by browsing instead`;
    case "albums-assembled-from-tracks":
      return `this server doesn't list albums, so TastyTunes assembled them from its ${n(note.count, "track", "tracks")}`;
    case "duplicate-albums-merged":
      return `${n(note.count, "duplicate album entry", "duplicate album entries")} merged, because the server lists some albums more than once`;
    case "years-from-tracks":
      return note.count === 1
        ? "1 album with no year took the year from its tracks"
        : `${note.count} albums with no year took the year from their tracks`;
    case "albums-from-their-tracks":
      return note.count === 1
        ? "1 album listed without an artist took its artist and name from its tracks"
        : `${note.count} albums listed without an artist took their artist and name from their tracks`;
    case "discs-from-file-names":
      return note.count === 1
        ? "1 album with no disc numbers took them from its file names"
        : `${note.count} albums with no disc numbers took them from their file names`;
    case "search-failed-browsed-instead":
      return "the server's search failed, so the library was indexed by browsing instead";
    case "search-paged-smaller":
      return "the server's search failed on large pages, so it was read in smaller pages instead";
    case "browse-capped":
      return `browsing stopped after ${note.count} folders, so a very large library may be only partly indexed`;
  }
}

/** One READY index's full pools, nodes stamped — the library lenses' feedstock. */
export interface MediaIndexPools {
  udn: string;
  serverName: string;
  albums: MediaNode[];
  artists: MediaNode[];
  tracks: MediaNode[];
  profile?: MediaServerProfile;
}

/** Queue-write verbs of /smoip/queue/add (semantics per vibin's reverse-engineering). */
export type MediaQueueAction = "REPLACE" | "APPEND" | "PLAY_NEXT" | "PLAY_NOW" | "PLAY_FROM_HERE";

/**
 * A container verb over this many tracks asks first, from every surface (the
 * guard lives in main's queueAdd). Filed after Play from here on a search
 * scope queued 2,528 tracks on the user's Evo (2026-09-04): a box set
 * queues without a prompt, a library-sized container never does.
 */
export const LARGE_QUEUE_TRACKS = 200;

// ---------------------------------------------------------------- names and titles

/**
 * A multi-volume set member: "Nature's Best 2 [Disc 1]", "Symphonies Vol. 3",
 * "Anthology, Part 2". Base + volume when the title carries a trailing
 * disc/volume/part marker; null otherwise. Same FULL title twice (two
 * editions of one album) is deliberately NOT a set — no marker, no match.
 */
const VOLUME_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const VOLUME_ROMAN: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
  xiii: 13,
  xiv: 14,
  xv: 15,
  xvi: 16,
  xvii: 17,
  xviii: 18,
  xix: 19,
  xx: 20,
};

export function albumVolume(title: string): { base: string; volume: number } | null {
  // The value can be digits, a spelled-out word (one–twenty) or a Roman
  // numeral (I–XX) — real servers produce all three. The keyword is still
  // required, so "Rocky IV" and "Formula One" never parse; a candidate that
  // is not a real word or numeral (e.g. "Part Time") resolves to null. The keyword starts a
  // word, after a space, a dash, a colon, a comma or a bracket, so "Concept 2", "Script Two"
  // and "Counterpart 3" are titles, not volumes (found by the unit tests, 2026-09-25).
  const m =
    /^(.*?)(?:[\s\-–—:,]+|[\s\-–—:,]*[[(])\s*(?:disc|disk|cd|vol(?:ume)?\.?|part|pt\.?)\s*(\d+|[a-z]+)\s*[\])]?\s*$/i.exec(
      title.trim(),
    );
  if (!m || !m[1].trim()) return null;
  const raw = m[2].toLowerCase();
  const volume = /^\d+$/.test(raw) ? Number(raw) : (VOLUME_WORDS[raw] ?? VOLUME_ROMAN[raw] ?? null);
  if (volume == null) return null;
  return { base: m[1].trim(), volume };
}

/**
 * Sort key for an artist name: a leading "The " files under what follows (The
 * Cure under C) — display never changes, only ordering and the A–Z rail.
 * Deliberately ONLY "The": stripping "A "/"An" is where conventions disagree
 * (A Tribe Called Quest divides rooms), so we take the unambiguous case and
 * stop. Titles keep their articles; this is for people and groups.
 */
export function nameSortKey(name: string): string {
  return /^the /i.test(name) ? name.slice(4) : name;
}
