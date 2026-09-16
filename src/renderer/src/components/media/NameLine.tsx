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
 * ONE name, one link — the primitive NameLine, Now Playing and the Library's
 * rows and album header all render. The artist navigates by NAME (the Artists
 * lens focused on it); the album by the row's REF through openRefInLibrary
 * (content-resolved, the track flashed). `onGo` replaces that navigation for
 * the Library's own rows, which resolve through the same library's pools
 * instead (2026-09-10: the link markup has one owner, the resolve stays
 * theirs). `name` is the identity to navigate by; `children` is what to show
 * when the two differ (Now Playing shows the settled readout while navigating
 * by the queue entry). An album with no ref is not a link — render text
 * instead. Any data-* attribute passes through to the button (the album
 * header's data-album-artist-link).
 */
export function NameLink({
  kind,
  name,
  ref,
  onGo,
  className,
  children,
  ...data
}: {
  kind: "artist" | "album";
  name: string;
  ref?: MediaRef | null;
  onGo?: () => void;
  className?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      {...data}
      data-tip={kind === "artist" ? "Go to artist" : "Go to album"}
      data-name-link={kind}
      aria-label={`Go to ${kind} ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        if (onGo) onGo();
        else if (kind === "artist") openArtistInLibrary(name);
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
  artistText,
  album,
  ref,
  onArtist,
  onAlbum,
  tone = "dim",
  sep = " — ",
}: {
  artist?: string | null;
  /** What the artist reads as when it differs from the name navigated by (the
   *  Library's performerLine); the link still goes by `artist`. */
  artistText?: string | null;
  album?: string | null;
  /** The row's ref; when it and `album` are present the album name links. */
  ref?: MediaRef | null;
  /** The Library's own resolve for each name: a callback replaces the app-wide
   *  navigation, null shows the name as text (no link offered there). */
  onArtist?: (() => void) | null;
  onAlbum?: (() => void) | null;
  /** The line's resting tone, which picks the hover step. */
  tone?: "dim" | "faint";
  sep?: string;
}): React.JSX.Element | null {
  if (!artist && !album) return null;
  const link = cx(
    "hover:underline underline-offset-2",
    tone === "dim" ? "hover:text-ink" : "hover:text-dim",
  );
  const shown = artistText ?? artist;
  return (
    <>
      {artist &&
        (onArtist === null ? (
          shown
        ) : (
          <NameLink kind="artist" name={artist} onGo={onArtist} className={link}>
            {shown}
          </NameLink>
        ))}
      {album && (
        <>
          {artist ? sep : ""}
          {onAlbum !== null && (onAlbum || ref) ? (
            <NameLink kind="album" name={album} ref={ref} onGo={onAlbum} className={link} />
          ) : (
            album
          )}
        </>
      )}
    </>
  );
}
