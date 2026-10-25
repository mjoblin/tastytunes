// WHICH COPY (0.13.0, round 1; his calls 2026-10-24 on the decision page).
//
// Favorites and the listening record know a track by its title, artist and album (playKey,
// favoriteKey), so two takes on one album (a user's two "Close Your Eyes", discs 2 and 5 of a
// box set) and two copies of one album (a CD rip and a hi-res download, the streamer's drive and
// a media server) were one track to them: one heart, one play count. This module is the one rule
// that tells them apart. A play, a heart or a library row carries a few facts about the copy it
// is (its picture's address, which server that picture is on, its length, its sample rate and
// bit depth), and those facts narrow the library's copies of the same title, artist and album,
// one fact at a time. A fact that would rule out every copy is set aside (a server that
// transcodes reports another rate; a length can be rounded differently), so nothing is ever
// lost: what is left is every copy the thing could be, and a play the facts cannot place still
// counts on all of them, as it did before.

import type { MediaNode } from "./media";

export interface CopyFacts {
  /** The picture's address without its query, where it is the copy's own: a media server's.
   *  Never the streamer's own drive's, whose addresses change with every standby. */
  art?: string | null;
  /** The server the copy is on, by udn: a library row's and a heart's (a play does not know). */
  server?: string | null;
  /** The host the picture is served from: which server the copy is on. */
  host?: string | null;
  /** The length, in seconds. */
  secs?: number | null;
  /** The sample rate, in Hz. */
  rate?: number | null;
  /** The bit depth. */
  bits?: number | null;
}

/** Within this many seconds two lengths are one track's (a server and the streamer round
 *  differently; the Open in Library landing uses the same slack). */
export const COPY_SECS_SLACK = 2;

/** An address without its query: a resizing parameter is not another picture. */
export const artAddress = (url: string | null | undefined): string | null =>
  url ? url.split("?")[0] : null;

/** The host a picture is served from, or null for an address that does not parse. */
export function artHostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

/** A library row's facts. */
export function nodeFacts(
  n: Pick<MediaNode, "artUrl" | "durationSecs" | "format" | "serverUdn">,
): CopyFacts {
  return {
    art: artAddress(n.artUrl),
    server: n.serverUdn ?? null,
    host: artHostOf(n.artUrl),
    secs: n.durationSecs,
    rate: n.format?.rate ?? null,
    bits: n.format?.bits ?? null,
  };
}

/** The rows a copy is compared with by their facts, and by the place they hold. */
export type CopyRow = Pick<
  MediaNode,
  | "title"
  | "artist"
  | "album"
  | "artUrl"
  | "durationSecs"
  | "format"
  | "serverUdn"
  | "trackNumber"
  | "discNumber"
>;

/**
 * Two rows that are one track of one copy: the same server, picture, length, place and format.
 * The album page's row and the index's entry for it are two objects (a server can even give them
 * two ids), and must not be told apart as if they were two copies; two editions alike in all but
 * their pictures stay two.
 */
export function sameCopyRow(a: CopyRow, b: CopyRow): boolean {
  return (
    a === b ||
    (a.serverUdn != null &&
      a.serverUdn === b.serverUdn &&
      artAddress(a.artUrl) === artAddress(b.artUrl) &&
      a.durationSecs === b.durationSecs &&
      a.trackNumber === b.trackNumber &&
      (a.discNumber ?? null) === (b.discNumber ?? null) &&
      (a.format?.rate ?? null) === (b.format?.rate ?? null) &&
      (a.format?.bits ?? null) === (b.format?.bits ?? null))
  );
}

type Check = (want: CopyFacts, have: CopyFacts) => boolean | null;

/** The checks, strongest first. Each answers null when either side lacks the fact (it says
 *  nothing), else whether the two agree. */
const CHECKS: Check[] = [
  (w, h) => (w.art && h.art ? w.art === h.art : null),
  (w, h) => (w.server && h.server ? w.server === h.server : null),
  (w, h) => (w.host && h.host ? w.host === h.host : null),
  (w, h) =>
    w.secs != null && h.secs != null ? Math.abs(w.secs - h.secs) <= COPY_SECS_SLACK : null,
  (w, h) => (w.rate != null && h.rate != null ? w.rate === h.rate : null),
  (w, h) => (w.bits != null && h.bits != null ? w.bits === h.bits : null),
];

/**
 * Whether two sets of facts say outright that they are different copies: another server, another
 * picture host, another length. The test for a heart when no other copy is known to compare
 * with (the library not read in this window): the sample rate and depth are left out, since a
 * server that converts reports another rate for the same copy.
 */
export function contradicts(a: CopyFacts, b: CopyFacts): boolean {
  return (
    (a.server != null && b.server != null && a.server !== b.server) ||
    (a.host != null && b.host != null && a.host !== b.host) ||
    (a.secs != null && b.secs != null && Math.abs(a.secs - b.secs) > COPY_SECS_SLACK)
  );
}

/**
 * The copies these facts could be, narrowed check by check. A copy that lacks a fact passes
 * that check; a check that would leave no copy at all is set aside. Never empty when `copies`
 * is not: the worst case is every copy, which is how the record counted before.
 */
export function copiesOf<T>(
  facts: CopyFacts,
  copies: readonly T[],
  factsOf: (t: T) => CopyFacts,
): T[] {
  if (copies.length <= 1) return [...copies];
  let pool = copies.map((c) => ({ c, f: factsOf(c) }));
  for (const check of CHECKS) {
    const kept = pool.filter(({ f }) => check(facts, f) !== false);
    if (kept.length > 0) pool = kept;
    if (pool.length === 1) break;
  }
  return pool.map(({ c }) => c);
}
