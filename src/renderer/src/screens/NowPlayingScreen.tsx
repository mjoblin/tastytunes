import { Captions, Disc3, Maximize2, MicVocal, RadioTower, UserRound } from 'lucide-react'
import { useStore } from '@/store'
import { cx, deriveNowPlaying } from '@/lib/format'
import { SignalLamp } from '@/components/SignalLamp'
import { ArtImage } from '@/components/ArtImage'
import { LyricsPanel } from '@/components/LyricsPanel'
import { LyricLine } from '@/components/LyricLine'
import { EmptyState } from '@/components/EmptyState'
import { ArtistPanel } from '@/components/ArtistPanel'

const ALIGN_H = { left: 'justify-start', center: 'justify-center', right: 'justify-end' } as const
const ALIGN_V = { top: 'items-start', center: 'items-center', bottom: 'items-end' } as const

export function NowPlayingScreen(): React.JSX.Element {
  const playState = useStore((s) => s.playState)
  const saveSettings = useStore((s) => s.saveSettings)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const setDisplayMode = useStore((s) => s.setDisplayMode)
  const lyricsOpen = useStore((s) => s.lyricsOpen)
  const setLyricsOpen = useStore((s) => s.setLyricsOpen)
  const artistOpen = useStore((s) => s.artistOpen)
  const setArtistOpen = useStore((s) => s.setArtistOpen)
  const {
    nowPlayingAlignH,
    nowPlayingAlignV,
    lyrics: lyricsEnabled,
    lyricsLine
  } = useStore((s) => s.settings)
  const meta = deriveNowPlaying(playState, nowPlaying)
  // Right placement mirrors the pair: art anchors the right edge, text grows leftward.
  const mirrored = nowPlayingAlignH === 'right'

  // Lyrics need real track metadata — hidden for radio and title-only sources.
  const lyricsAvailable = lyricsEnabled && !meta.isRadio && !!meta.title && !!meta.subtitle
  const { artistInfo: artistEnabled } = useStore((s) => s.settings)
  const artistAvailable = artistEnabled && !meta.isRadio && !!meta.subtitle

  const toggleLyricLine = async (): Promise<void> => {
    await saveSettings({ lyricsLine: !lyricsLine })
  }

  const sourceName = nowPlaying?.source?.name ?? null
  const queueIndex = playState?.queue_index
  const queueLength = playState?.queue_length
  const state = playState?.state

  const empty = !meta.title && !meta.subtitle

  // Titleless top band: preserves the header's vertical rhythm (and houses the
  // display-mode button) so the art/text sit where they did with a title.
  const header = (
    // relative z-20 keeps the header's buttons clickable above the drawers
    // (z-10) — but pointer-events-none on the strip itself, restored per
    // button, so the empty band never eats the drawer ✕ beneath it. Window
    // dragging is unaffected: app-region is a native hit-test, not CSS.
    <header className="drag-region relative z-20 pointer-events-none flex items-center justify-end px-8 pt-8 pb-4 min-h-[83px]">
      {/* while a drawer is open the header goes quiet entirely — the panel's
          own ✕ (or Escape) is the one way out */}
      {lyricsAvailable && !lyricsOpen && !artistOpen && (
        <button
          onClick={() => void toggleLyricLine()}
          data-tip={lyricsLine ? 'Hide current lyric line' : 'Show current lyric line'}
          aria-label="Current lyric line"
          className={cx(
            'no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full hover:bg-veil2 motion-safe:active:scale-90 transition-all',
            lyricsLine ? 'text-gold hover:text-ink' : 'text-faint hover:text-ink'
          )}
        >
          <Captions size={16} />
        </button>
      )}
      {lyricsAvailable && !artistOpen && !lyricsOpen && (
        <button
          onClick={() => setLyricsOpen(true)}
          data-tip="Lyrics"
          aria-label="Lyrics"
          className="no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
        >
          <MicVocal size={16} />
        </button>
      )}
      {artistAvailable && !lyricsOpen && !artistOpen && (
        <button
          onClick={() => setArtistOpen(true)}
          data-tip="About the artist"
          aria-label="About the artist"
          className="no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
        >
          <UserRound size={16} />
        </button>
      )}
      {!lyricsOpen && !artistOpen && (
        <button
          onClick={() => setDisplayMode(true)}
          data-tip="Full-screen display mode (F)"
          aria-label="Full-screen display mode (F)"
          className="no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
        >
          <Maximize2 size={16} />
        </button>
      )}
    </header>
  )

  if (empty) {
    return (
      <div className="h-full flex flex-col">
        {header}
        <EmptyState
          icon={Disc3}
          title="Nothing playing"
          caption="Start playback from a queue, recall a preset, or stream to the device from another app."
        />
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-hidden flex flex-col">
      {/* ambient art backdrop is rendered app-wide by AmbientBackdrop in App */}
      {header}

      {lyricsAvailable && lyricsOpen && <LyricsPanel />}
      {artistAvailable && artistOpen && <ArtistPanel />}

      {/* fixed alignment (settings-chosen) so the layout doesn't shift as track lengths change.
          The art+text pair is one inner unit: text always tops-out level with the art
          (items-start), and right placement mirrors the pair so the art anchors the right
          edge while text grows leftward. */}
      <div
        className={cx(
          'relative flex-1 min-h-0 flex px-8 pb-10',
          ALIGN_H[nowPlayingAlignH],
          ALIGN_V[nowPlayingAlignV]
        )}
      >
        <div className={cx('flex gap-8 items-start min-w-0', mirrored && 'flex-row-reverse')}>
        <div className="shrink-0">
          <ArtImage
            src={meta.artUrl}
            className="w-[340px] h-[340px] xl:w-[400px] xl:h-[400px] object-cover rounded-2xl art-glow"
            fallback={
              <div className="w-[340px] h-[340px] xl:w-[400px] xl:h-[400px] rounded-2xl bg-raised ring-1 ring-edge flex items-center justify-center">
                {meta.isRadio ? (
                  <RadioTower size={72} strokeWidth={1} className="text-faint" />
                ) : (
                  <Disc3 size={72} strokeWidth={1} className="text-faint" />
                )}
              </div>
            }
          />
        </div>

        <div className={cx('min-w-0 max-w-xl space-y-5', mirrored && 'text-right')}>
          <div className={cx('flex items-center gap-3', mirrored && 'justify-end')}>
            {sourceName && <span className="badge">{sourceName}</span>}
            {state && state !== 'play' && (
              <span className={cx('microlabel', state === 'pause' ? 'text-amber' : '')}>
                {state === 'pause' ? 'paused' : state}
              </span>
            )}
          </div>

          <div className="space-y-1">
            <h1 className="font-display font-bold text-[clamp(28px,4vw,46px)] leading-[1.08] tracking-tight text-balance">
              {meta.title}
            </h1>
            {meta.subtitle && <div className="text-lg text-ink/80 truncate">{meta.subtitle}</div>}
            {meta.album && <div className="text-[14px] text-dim truncate">{meta.album}</div>}
          </div>

          {meta.badges.length > 0 && (
            <div className={cx('flex flex-wrap items-center gap-1.5', mirrored && 'justify-end')}>
              {meta.badges.map((b) => (
                <span key={b} className="badge">
                  {b}
                </span>
              ))}
              <SignalLamp />
            </div>
          )}

          {meta.isRadio && nowPlaying?.display?.line3 && (
            <div className="text-[13px] text-dim">{nowPlaying.display.line3}</div>
          )}

          {queueIndex != null && queueLength != null && queueLength > 0 && (
            <div className="microlabel">
              track {queueIndex + 1} of {queueLength}
            </div>
          )}

          {/* inline lyric flavor — never alongside the full panel */}
          {lyricsAvailable && lyricsLine && !lyricsOpen && <LyricLine />}
        </div>
        </div>
      </div>
    </div>
  )
}
