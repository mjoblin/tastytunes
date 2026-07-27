import { cx } from '@/lib/format'
import { useFadedText, useLyrics } from '@/hooks/useLyrics'

/**
 * The inline lyrics flavor: just the current synced line, under the track
 * details on Now Playing; holds a quiet ♪ through LRC empty-text gaps and
 * intros. Toggled from the screen header (captions button); the screen hides
 * it while the full panel is open. Lines crossfade as they change.
 *
 * WITHOUT synced lyrics it explains itself rather than going blank (user,
 * 2026-07-27, on an album where LRCLIB has timing for 2 of 10 tracks): with
 * captions ON the button is gold and the app looks like it is trying, so an
 * empty slot reads as broken rather than as "nobody has timed this one". The
 * note lands where the lyric would have been and mirrors the full panel's
 * wording — the panel has said this all along, but only once you open it.
 */
export function LyricLine(): React.JSX.Element | null {
  const { status, result, synced, currentIndex } = useLyrics()

  const line = synced && currentIndex >= 0 ? synced[currentIndex].text : ''
  const { shown, visible } = useFadedText(synced ? line || '♪' : '')
  if (!synced) {
    // 'loading' stays blank on purpose — a note that flashes during every
    // lookup and then vanishes is worse than the silence it replaces.
    const note =
      status === 'loading'
        ? null
        : status === 'none'
          ? 'No lyrics found for this track'
          : result?.instrumental
            ? 'Instrumental'
            : result?.plain
              ? 'No lyric timing data for this track'
              : null
    if (!note) return null
    // Same h-0 slot as the line itself: an explanation must not push the
    // vertically-centred art/details block around (see below).
    return (
      <div data-lyric-note className="h-0 max-w-xl">
        <div className="text-[12px] text-faint/65 leading-snug truncate">{note}</div>
      </div>
    )
  }

  const placeholder = shown === '♪'
  // h-0: the line must never contribute height, or the vertically-centered
  // art/details block bobs as lyrics wrap between 1 and 2 lines (and jumps
  // when synced lyrics appear at all). The text simply hangs downward;
  // line-clamp-2 bounds how far.
  return (
    <div data-lyric-line className="h-0 max-w-xl">
      <div
        className={cx(
          'font-display text-[17px] leading-snug line-clamp-2 transition-opacity duration-200',
          visible ? 'opacity-100' : 'opacity-0',
          placeholder ? 'text-faint' : 'text-gold/90 lyric-glow'
        )}
      >
        {shown}
      </div>
    </div>
  )
}
