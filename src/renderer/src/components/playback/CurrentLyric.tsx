import { cx } from "@/lib/format";
import { useFadedText, useLyrics } from "@/hooks/useLyrics";
import { useReducedMotion } from "@/hooks/useReducedMotion";

/**
 * THE CURRENT LYRIC LINE BEYOND NOW PLAYING (0.17.0): one small line under the track's title and
 * artist, in the playback bar, the mini player and the menu bar panel, each place its own switch
 * (settings.lyricsLineBar, lyricsLineMini, lyricsLinePanel). THE ROOM FOLLOWS THE SWITCH, NEVER
 * THE SONG: the place keeps this line's room while its switch is on, so the title and artist never
 * move with the music. A synced line is shown; a gap or an intro in a song with synced lyrics is
 * "♪", so the line doesn't blink out between verses; a track without synced lyrics (radio, idle,
 * plain lyrics, the moment while they load) leaves the room empty, with no note (a note here would
 * be clutter; Now Playing's line explains). Cut with an ellipsis, never scrolled: a line that
 * changes every few seconds should not also move sideways. Smaller and fainter than the artist
 * line; under reduced motion lines swap without the fade. The caller decides where it mounts (the
 * bar leaves it out on Now Playing) and what a click on it does.
 */
export function CurrentLyric({ className }: { className?: string }): React.JSX.Element {
  const { synced, currentIndex } = useLyrics();
  const reduced = useReducedMotion();
  const line = synced && currentIndex >= 0 ? synced[currentIndex].text : "";
  const { shown, visible } = useFadedText(synced ? line || "♪" : "", !reduced);
  // gold, as Now Playing's line: the lyric is the music, and gold is the app's color for what's
  // playing; the "♪" between lines stays faint
  return (
    <div
      data-current-lyric
      className={cx(
        "truncate leading-tight",
        !reduced && "transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0",
        shown === "♪" ? "text-faint" : "text-gold/90 lyric-glow",
        className,
      )}
    >
      {shown || " "}
    </div>
  );
}
