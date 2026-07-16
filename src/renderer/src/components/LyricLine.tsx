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
  return (
    <div data-lyric-line className="min-h-[28px] max-w-xl">
      <div
        className={cx(
          'font-display text-[17px] leading-snug line-clamp-2 transition-opacity duration-200',
          visible ? 'opacity-100' : 'opacity-0',
          placeholder ? 'text-faint' : 'text-gold/90'
        )}
      >
        {shown}
      </div>
    </div>
  )
}
