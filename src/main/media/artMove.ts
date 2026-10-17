/**
 * THE USB SERVER'S PICTURES MOVE WITH ITS IDS (2026-10-11, the user's Evo: after a wake the
 * Albums lens and the album page showed no art for the drive's albums). The streamer serves a
 * drive's pictures at URLs it re-mints on every wake ("album-art-e548?id=70:3" came back as
 * "album-art-2e42?id=12:3" for the same cover, the old URL a 404), and the heal moved the
 * index's ids onto the new mount but kept the old URLs. The move is learned from the heal's own
 * checks, which read each object afresh: a picture's stored and fresh URLs share their ends, and
 * what differs at the front is the move. It must explain every check's picture, and every
 * picture in the index must start with the stored front, or there is no move and the heal
 * walks. Pure, so the shapes it must accept and refuse are unit-tested.
 */

/** Every picture URL that starts with `from` starts with `to` instead. */
export interface ArtMove {
  from: string;
  to: string;
}

/** The move that explains every check's picture, or why there is none. A pair is one check's
 *  stored URL and the URL the server gives the same object now. */
export function learnArtMove(
  pairs: ReadonlyArray<readonly [stored: string | null, fresh: string | null]>,
): ArtMove | string {
  let move: ArtMove | null = null;
  for (const [stored, fresh] of pairs) {
    if (stored == null && fresh == null) continue;
    if (stored == null) return `a picture appeared (${fresh})`;
    if (fresh == null) return `a picture went (${stored})`;
    if (!move) {
      // the longest shared end; what precedes it is the move (the whole URL when nothing moved)
      let k = 0;
      while (
        k < stored.length &&
        k < fresh.length &&
        stored[stored.length - 1 - k] === fresh[fresh.length - 1 - k]
      )
        k++;
      move = { from: stored.slice(0, stored.length - k), to: fresh.slice(0, fresh.length - k) };
    }
    if (moveArt(stored, move) !== fresh) return `a picture moved otherwise (${stored} → ${fresh})`;
  }
  return move ?? { from: "", to: "" };
}

/** The URL after the move; undefined when it does not start where the move starts. */
export function moveArt(url: string, move: ArtMove): string | undefined {
  if (move.from === move.to) return url;
  return url.startsWith(move.from) ? move.to + url.slice(move.from.length) : undefined;
}
