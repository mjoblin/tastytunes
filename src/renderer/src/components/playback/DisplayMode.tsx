import { useEffect, useRef, useState } from 'react'
import { Captions, Disc3, RadioTower, X } from 'lucide-react'
import { useStore } from '@/store'
import { CrossfadeArt } from '@/components/media/CrossfadeArt'
import { usePlayhead } from '@/hooks/usePlayhead'
import { useArtLoadable } from '@/hooks/useArtLoadable'
import { useFadedText, useLyrics } from '@/hooks/useLyrics'
import { useSettledSnapshot } from '@/hooks/useSettledSnapshot'
import { cx, deriveNowPlaying } from '@/lib/format'

/**
 * Full-screen "display mode" (Roon display mode / Volumio now-playing kiosk):
 * chrome-free art + metadata for a desk or wall screen. Toggled with F; the
 * cursor and close control fade out after a few idle seconds.
 */
export function DisplayMode(): React.JSX.Element {
  const playState = useStore((s) => s.playState)
  const saveSettings = useStore((s) => s.saveSettings)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const setDisplayMode = useStore((s) => s.setDisplayMode)
  const settings = useStore((s) => s.settings)
  const { position, duration } = usePlayhead()
  const [cursorIdle, setCursorIdle] = useState(false)
  const [clock, setClock] = useState(() => timeNow())
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const meta = deriveNowPlaying(playState, nowPlaying)

  // Title/artist/badges render from a SETTLED snapshot and fade as one group:
  // on track change the group fades out, and only once the metadata settles
  // does it swap and fade the new track in — so the gap never flashes
  // intermediate/empty states. (The album art crossfades independently.)
  // Signature = the track's identity only; badges ride in the snapshot but
  // never drive the settle (the bitrate badge ticks on its own — a ticking
  // signature re-arms the timer forever and the group stays invisible).
  const liveTextSig = `${meta.title ?? ''}␟${meta.subtitle ?? ''}`
  const { shown: shownText, visible: textVisible } = useSettledSnapshot(liveTextSig, () => ({
    title: meta.title,
    subtitle: meta.subtitle,
    badges: meta.badges
  }))

  // Enter OS fullscreen while mounted; leave on unmount. If the user exits
  // fullscreen (Esc), close display mode too.
  useEffect(() => {
    void document.documentElement.requestFullscreen?.().catch(() => {})
    const onChange = (): void => {
      if (!document.fullscreenElement) setDisplayMode(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [setDisplayMode])

  useEffect(() => {
    const timer = setInterval(() => setClock(timeNow()), 10_000)
    return () => clearInterval(timer)
  }, [])

  const onMouseMove = (): void => {
    setCursorIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setCursorIdle(true), 3000)
  }

  const artLoadable = useArtLoadable(meta.artUrl)
  const lyricsToggleable = settings.lyrics && !meta.isRadio && !!meta.subtitle
  const toggleLyrics = async (): Promise<void> => {
    await saveSettings({ displayLyrics: !settings.displayLyrics })
  }

  return (
    <div
      className={cx('fixed inset-0 z-40 bg-bg overflow-hidden', cursorIdle && 'cursor-hidden')}
      onMouseMove={onMouseMove}
    >
      {meta.artUrl && artLoadable && (
        <div
          aria-hidden
          className="absolute inset-0 bg-center bg-cover scale-125 blur-[110px] opacity-25 saturate-150"
          style={{ backgroundImage: `url(${meta.artUrl})` }}
        />
      )}

      <div
        className={cx(
          'absolute bottom-6 right-7 font-mono text-[13px] text-dim transition-opacity',
          cursorIdle && 'opacity-60'
        )}
      >
        {clock}
      </div>

      {/* top-RIGHT: the top-left corner belongs to macOS's (hidden but still
          click-swallowing) traffic-light zone in frameless windows */}
      {lyricsToggleable && (
        <button
          onClick={() => void toggleLyrics()}
          title={settings.displayLyrics ? 'Hide lyrics' : 'Show lyrics'}
          className={cx(
            'absolute top-4 right-16 z-20 p-2 rounded-full hover:bg-veil2 transition-opacity',
            settings.displayLyrics ? 'text-gold' : 'text-dim hover:text-ink',
            cursorIdle ? 'opacity-0' : 'opacity-100'
          )}
        >
          <Captions size={18} />
        </button>
      )}
      <button
        onClick={() => setDisplayMode(false)}
        title="Exit display mode (F)"
        className={cx(
          'absolute top-4 right-4 z-20 p-2 rounded-full text-dim hover:text-ink hover:bg-veil2 transition-opacity',
          cursorIdle ? 'opacity-0' : 'opacity-100'
        )}
      >
        <X size={18} />
      </button>

      {lyricsToggleable && settings.displayLyrics && <DisplayLyric />}

      <div className="relative h-full flex flex-col items-center justify-center px-16">
        {/* Lock the art in place across track changes: it's a fixed size, so
            we center it (nudged up to leave room for the text) and hang the
            text absolutely beneath it — a longer/shorter title, a missing
            subtitle, or a changing badge count then grow downward instead of
            re-centering the whole group and shifting the art. */}
        <div className="relative -translate-y-[7vmin]">
          <CrossfadeArt
            src={meta.artUrl}
            className="w-[46vmin] h-[46vmin] object-cover rounded-2xl art-glow"
            fallback={
              <div className="w-[46vmin] h-[46vmin] rounded-2xl bg-raised ring-1 ring-edge flex items-center justify-center">
                {meta.isRadio ? (
                  <RadioTower size={90} strokeWidth={1} className="text-faint" />
                ) : (
                  <Disc3 size={90} strokeWidth={1} className="text-faint" />
                )}
              </div>
            }
          />

          <div
            className={cx(
              'absolute top-full left-1/2 -translate-x-1/2 mt-9 w-[70vw] text-center space-y-1 transition-opacity duration-300',
              textVisible ? 'opacity-100' : 'opacity-0'
            )}
          >
            <div className="font-display font-bold text-[clamp(26px,4.5vmin,52px)] leading-tight tracking-tight text-balance">
              {shownText.title ?? 'Nothing playing'}
            </div>
            {shownText.subtitle && (
              <div className="font-display tracking-tight leading-tight text-[clamp(15px,2.2vmin,24px)] text-dim truncate">
                {shownText.subtitle}
              </div>
            )}
            {shownText.badges.length > 0 && (
              <div className="flex justify-center flex-wrap gap-1.5 pt-6">
                {shownText.badges.map((b) => (
                  <span key={b} className="badge">
                    {b}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {duration != null && duration > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-veil2">
          <div
            className="h-full bg-amber transition-[width] duration-300 ease-linear"
            style={{ width: `${Math.min(100, (position / duration) * 100)}%` }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * The current synced line, floating above the progress bar. Absolutely
 * positioned and pointer-transparent: it never nudges the centered art/text
 * column, whatever it does. Dim ♪ through LRC gaps/intros (same as the
 * Now Playing inline line); renders nothing without synced lyrics.
 */
function DisplayLyric(): React.JSX.Element | null {
  const { synced, currentIndex } = useLyrics()
  const line = synced && currentIndex >= 0 ? synced[currentIndex].text : ''
  const { shown, visible } = useFadedText(synced ? line || '♪' : '')
  if (!synced) return null
  const placeholder = shown === '♪'
  return (
    <div className="absolute inset-x-0 bottom-10 px-16 text-center pointer-events-none">
      <div
        className={cx(
          'font-display text-[clamp(17px,2.8vmin,30px)] leading-snug line-clamp-2 text-balance transition-opacity duration-200',
          visible ? 'opacity-100' : 'opacity-0',
          placeholder ? 'text-faint' : 'text-gold/90'
        )}
      >
        {shown}
      </div>
    </div>
  )
}

function timeNow(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
