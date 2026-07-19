import { cx } from '@/lib/format'
import { useFadedText, useLyrics } from '@/hooks/useLyrics'

/**
 * The inline lyrics flavor: just the current synced line, under the track
 * details on Now Playing. Renders nothing without synced lyrics; holds a
 * quiet ♪ through LRC empty-text gaps and intros. Toggled from the screen
 * header (captions button); the screen hides it while the full panel is open.
 * Lines crossfade as they change.
 */
export function LyricLine(): React.JSX.Element | null {
  const { synced, currentIndex } = useLyrics()

  const line = synced && currentIndex >= 0 ? synced[currentIndex].text : ''
  const { shown, visible } = useFadedText(synced ? line || '♪' : '')
  if (!synced) return null

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
