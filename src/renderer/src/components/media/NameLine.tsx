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
/**
 * ONE name, one link — the primitive NameLine and Now Playing both render.
 * The artist navigates by NAME (the Artists lens focused on it); the album by
 * the row's REF through openRefInLibrary (content-resolved, the track flashed).
 * `name` is the identity to navigate by; `children` is what to show when the
 * two differ (Now Playing shows the settled readout while navigating by the
 * queue entry). An album with no ref is not a link — render text instead.
 */
export function NameLink({
  kind,
  name,
  ref,
  className,
  children,
}: {
  kind: "artist" | "album";
  name: string;
  ref?: MediaRef | null;
  className?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      data-tip={kind === "artist" ? "Go to artist" : "Go to album"}
      data-name-link={kind}
      aria-label={`Go to ${kind} ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        if (kind === "artist") openArtistInLibrary(name);
        else if (ref) void openRefInLibrary(ref);
      }}
      className={cx("tip-bottom transition-colors", className)}
    >
      {children ?? name}
    </button>
  );
}

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
    "hover:underline underline-offset-2",
    tone === "dim" ? "hover:text-ink" : "hover:text-dim",
  );
  return (
    <>
      {artist && <NameLink kind="artist" name={artist} className={link} />}
      {album &&
        (ref ? (
          <>
            {artist ? sep : ""}
            <NameLink kind="album" name={album} ref={ref} className={link} />
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
