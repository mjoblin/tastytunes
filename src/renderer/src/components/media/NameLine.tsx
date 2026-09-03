import { openArtistInLibrary, openRefInLibrary } from "@/lib/mediaActions";
import type { MediaRef } from "@/lib/mediaRef";
import { cx } from "@/lib/format";

/**
 * The "artist — album" line of a row, with each NAME a link (ruled
 * 2026-09-01 in the Tracks lens round, extended to every row view
 * 2026-09-02: the Queue, Playlists, Favorites and Recently Played rows).
 *
 * One home for the grammar: the row itself keeps the app-wide click contract
 * (a track row plays), the names inside it navigate — the artist to the
 * Artists lens focused on that name, the album to the track's album in the
 * Library with the track scrolled to and flashed (openRefInLibrary, the same
 * resolve "Open in Library" uses, so a stale server id can't strand the
 * link). Hover is ONE STEP up from the line's own tone and an underline,
 * never the title's brightness: a dim line lifts to ink, a faint one to dim.
 * Clicks stop at the link so the row beneath never plays.
 *
 * Renders nothing when there is neither name, so a caller can compose it
 * with trailing facts ("· server is offline") without a stray separator.
 */
export function NameLine({
  artist,
  album,
  ref,
  tone = "dim",
  sep = " — ",
}: {
  artist?: string | null;
  album?: string | null;
  /** The row's ref; when it and `album` are present the album name links. */
  ref?: MediaRef | null;
  /** The line's resting tone, which picks the hover step. */
  tone?: "dim" | "faint";
  sep?: string;
}): React.JSX.Element | null {
  if (!artist && !album) return null;
  const link = cx(
    "tip-bottom hover:underline underline-offset-2 transition-colors",
    tone === "dim" ? "hover:text-ink" : "hover:text-dim",
  );
  return (
    <>
      {artist && (
        <button
          data-tip="Go to artist"
          data-name-link="artist"
          aria-label={`Go to artist ${artist}`}
          onClick={(e) => {
            e.stopPropagation();
            openArtistInLibrary(artist);
          }}
          className={link}
        >
          {artist}
        </button>
      )}
      {album &&
        (ref ? (
          <>
            {artist ? sep : ""}
            <button
              data-tip="Go to album"
              data-name-link="album"
              aria-label={`Go to album ${album}`}
              onClick={(e) => {
                e.stopPropagation();
                void openRefInLibrary(ref);
              }}
              className={link}
            >
              {album}
            </button>
          </>
        ) : (
          <>
            {artist ? sep : ""}
            {album}
          </>
        ))}
    </>
  );
}
