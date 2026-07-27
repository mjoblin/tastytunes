import { useEffect, useRef, useState } from 'react'
import { Captions, Disc3, Heart, ListOrdered, Maximize2, MicVocal, RadioTower, UserRound } from 'lucide-react'
import { favoriteKey, type Favorite, type FavoriteMedia } from '@shared/model'
import { tt } from '@/api'
import { useStore } from '@/store'
import { toggleFavorite } from '@/lib/favorites'
import { cx, deriveNowPlaying } from '@/lib/format'
import { useSettledSnapshot } from '@/hooks/useSettledSnapshot'
import { useDecodedArt } from '@/hooks/useDecodedArt'
import { AddToPlaylistPanel } from '@/components/overlays/AddToPlaylistPanel'
import { SignalLamp } from '@/components/device/SignalLamp'
import { ArtImage } from '@/components/media/ArtImage'
import { LyricsPanel } from '@/components/overlays/LyricsPanel'
import { LyricLine } from '@/components/playback/LyricLine'
import { EmptyState } from '@/components/chrome/EmptyState'
import { ArtistPanel } from '@/components/overlays/ArtistPanel'

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

  // Title/artist/album/badges render from a SETTLED snapshot and fade as one
  // group on track change (same idea as display mode): fade out, wait for the
  // metadata to settle, then adopt + fade the new track in — so the gap never
  // flashes intermediate/empty states. The album art crossfades independently.
  //
  // The signature is the TRACK'S IDENTITY only. Badges ride along in the
  // snapshot (they swap with the group) but must never drive the settle: the
  // bitrate badge can tick on its own, and a signature that ticks re-arms the
  // timer forever — which held the whole block at opacity 0 for as long as the
  // ticking lasted. Queue position is deliberately NOT snapshotted: it moves
  // for reasons that have nothing to do with the track (adding, removing or
  // reordering the queue), so it renders live and merely fades with the group.
  const liveTrackSig = `${meta.title ?? ''}␟${meta.subtitle ?? ''}␟${meta.album ?? ''}`
  const { shown: shownTrack, visible: trackVisible } = useSettledSnapshot(liveTrackSig, () => ({
    title: meta.title,
    subtitle: meta.subtitle,
    album: meta.album,
    badges: meta.badges
  }))
  // Right placement mirrors the pair: art anchors the right edge, text grows leftward.
  const mirrored = nowPlayingAlignH === 'right'

  // Lyrics need real track metadata — hidden for radio and title-only sources.
  const lyricsAvailable = lyricsEnabled && !meta.isRadio && !!meta.title && !!meta.subtitle
  const { artistInfo: artistEnabled } = useStore((s) => s.settings)
  const artistAvailable = artistEnabled && !meta.isRadio && !!meta.subtitle

  // The heart: content-only favoriting of whatever is playing. Tracks need
  // title+artist (the lyrics gating); radio needs a URL to replay, which
  // play_state never carries — so a stream is heartable only when TT started
  // it this session (lastStation) or it's already a favorite (unheart).
  const favorites = useStore((s) => s.favorites)
  const lastStation = useStore((s) => s.lastStation)
  const md = playState?.metadata
  const stationName = meta.isRadio ? ((md?.station ?? md?.name)?.trim() ?? null) : null
  const stationFav = stationName
    ? (favorites.find(
        (f) => f.kind === 'station' && f.name.trim().toLowerCase() === stationName.toLowerCase()
      ) ?? null)
    : null
  const lastMatches =
    stationName != null &&
    lastStation != null &&
    lastStation.name.trim().toLowerCase() === stationName.toLowerCase()
  const trackFav: Omit<FavoriteMedia, 'addedAt'> | null =
    !meta.isRadio && meta.title && meta.subtitle
      ? {
          kind: 'track',
          title: meta.title,
          artist: meta.subtitle,
          album: meta.album ?? null,
          artUrl: meta.artUrl ?? null,
          serverUdn: null,
          serverName: null,
          objectId: null,
          titlePath: null,
          durationSecs: md?.duration ?? null
        }
      : null
  const heartActive = trackFav
    ? favorites.some((f) => favoriteKey(f) === favoriteKey(trackFav as Favorite))
    : stationFav != null
  const heartAvailable = trackFav != null || stationFav != null || lastMatches
  const toggleHeart = (): void => {
    if (trackFav) void toggleFavorite(trackFav)
    else if (stationFav) void tt.favoriteRemove(favoriteKey(stationFav))
    else if (lastStation && lastMatches)
      void tt.favoriteAdd({
        kind: 'station',
        addedAt: Date.now(),
        name: lastStation.name,
        url: lastStation.url,
        favicon: lastStation.favicon,
        radioBrowserUuid: lastStation.radioBrowserUuid
      })
  }

  const toggleLyricLine = async (): Promise<void> => {
    await saveSettings({ lyricsLine: !lyricsLine })
  }

  const sourceName = nowPlaying?.source?.name ?? null
  const state = playState?.state
  // The tile renders the last DECODED cover (see useDecodedArt) — a hard swap
  // between two real images, never a swap to an empty box mid-download.
  const { art: tileArt } = useDecodedArt(meta.artUrl)
  // Live, not snapshotted — the queue moves independently of the track.
  const queueIndex = playState?.queue_index
  const queueLength = playState?.queue_length

  // Only surface "buffering" once it has persisted a beat — brief buffers on a
  // seek or track change shouldn't flash a label. Other states show at once.
  //
  // 800ms, not 2s (user call 2026-07-24): long enough to swallow seek and
  // track-change blips, short enough that a genuinely slow radio start gets
  // named while you're still wondering. The playback bar's `busy` LED stays
  // INSTANT on purpose — the two do different jobs. The LED says "something is
  // happening", which is ambient and belongs immediately; the label NAMES a
  // state, which is a statement and earns a threshold.
  const [bufferingSettled, setBufferingSettled] = useState(false)
  useEffect(() => {
    if (state !== 'buffering') {
      setBufferingSettled(false)
      return
    }
    const t = setTimeout(() => setBufferingSettled(true), 800)
    return () => clearTimeout(t)
  }, [state])

  // Adding what's playing is the other half of "add from wherever you see
  // music". Tracks only — a radio stream can't hold a position in an ordered
  // list, so the button simply isn't offered for one.
  const playlistBtn = useRef<HTMLButtonElement | null>(null)
  const [playlistAt, setPlaylistAt] = useState<{ x: number; y: number } | null>(null)
  const playlistAvailable = !meta.isRadio && !!meta.title

  const empty = !meta.title && !meta.subtitle
  /** Every header button hides on this pair; naming it once also stopped the two
   *  lyrics buttons from spelling the same condition in two different orders. */
  const drawersClosed = !lyricsOpen && !artistOpen

  // Titleless top band: preserves the header's vertical rhythm (and houses the
  // display-mode button) so the art/text sit where they did with a title.
  const header = (
    // relative z-20 keeps the header's buttons clickable above the drawers
    // (z-10) — but pointer-events-none on the strip itself, restored per
    // button, so the empty band never eats the drawer ✕ beneath it. Window
    // dragging is unaffected: app-region is a native hit-test, not CSS.
    <header className="drag-region relative z-20 pointer-events-none flex items-center justify-end gap-6 px-8 pt-8 pb-4 min-h-[83px]">
      {/* TWO GROUPS, told apart by a gap (user call 2026-07-24). The strip ran
          six buttons at one even spacing, but they do two different jobs: the
          first pair WRITES to stored collections, the rest only change what
          you're LOOKING at. Grouped by proximity rather than a hairline rule —
          proximity is already the app's grouping device (see the row-action
          clusters), a rule would be the loudest thing in a strip meant to sit
          quietly over album art, and since every button here is conditional a
          divider would need its own logic to avoid floating with nothing left
          to separate. A gap between two groups just collapses.
          gap-6 here against the Queue header's gap-4 on purpose: these are bare
          icons and those are ringed chips, which already separate themselves.
          The aim is equal PERCEIVED separation, not equal pixels.
          While a drawer is open the header goes quiet entirely — the panel's
          own ✕ (or Escape) is the one way out. */}
      {drawersClosed && (playlistAvailable || heartAvailable) && (
        <div data-np-group="write" className="flex items-center">
          {playlistAvailable && (
            <button
              ref={playlistBtn}
              onClick={() => {
                const r = playlistBtn.current?.getBoundingClientRect()
                setPlaylistAt({ x: r ? r.left : 0, y: r ? r.bottom + 6 : 0 })
              }}
              data-tip="Add to playlist"
              aria-label="Add to playlist"
              className="no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
            >
              <ListOrdered size={18} />
            </button>
          )}
          {heartAvailable && (
            <button
              onClick={toggleHeart}
              data-tip={heartActive ? 'Remove from favorites' : 'Add to favorites'}
              aria-label={heartActive ? 'Remove from favorites' : 'Add to favorites'}
              data-np-heart={heartActive ? 'on' : 'off'}
              className={cx(
                'no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full hover:bg-veil2 motion-safe:active:scale-90 transition-all',
                heartActive ? 'text-gold hover:text-ink' : 'text-faint hover:text-ink'
              )}
            >
              <Heart size={16} fill={heartActive ? 'currentColor' : 'none'} />
            </button>
          )}
        </div>
      )}
      {drawersClosed && (
        <div data-np-group="view" className="flex items-center">
          {lyricsAvailable && (
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
          {lyricsAvailable && (
            <button
              onClick={() => setLyricsOpen(true)}
              data-tip="Lyrics"
              aria-label="Lyrics"
              className="no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
            >
              <MicVocal size={16} />
            </button>
          )}
          {artistAvailable && (
            <button
              onClick={() => setArtistOpen(true)}
              data-tip="About the artist"
              aria-label="About the artist"
              className="no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
            >
              <UserRound size={16} />
            </button>
          )}
          <button
            onClick={() => setDisplayMode(true)}
            data-tip="Full-screen display mode (F)"
            aria-label="Full-screen display mode (F)"
            className="no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
          >
            <Maximize2 size={16} />
          </button>
        </div>
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

      {playlistAt && (
        <AddToPlaylistPanel
          label={meta.title ?? 'this track'}
          at={playlistAt}
          onClose={() => setPlaylistAt(null)}
          resolve={async () => [
            {
              title: meta.title ?? '',
              artist: meta.subtitle ?? null,
              album: meta.album ?? null,
              artUrl: meta.artUrl ?? null,
              // play_state carries no library ids — content IS the identity,
              // and activation resolves it fresh against whatever server has it
              serverUdn: null,
              serverName: null,
              objectId: null,
              durationSecs: md?.duration ?? null
            }
          ]}
        />
      )}
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
          {/* three width tiers — compact windows get genuinely small art
              (260) instead of the old two-step 340/400 (user pass) */}
          {/* Art swaps straight over on a track change — no crossfade here (user
              call 2026-07-24: the text settling and the art dissolving at the
              same time read as mushy). Display mode keeps its crossfade. The
              swap is off the DECODED url, so the tile goes cover-to-cover
              rather than emptying while a slow remote fetch finishes. */}
          <ArtImage
            src={tileArt}
            className="w-[260px] h-[260px] lg:w-[340px] lg:h-[340px] xl:w-[400px] xl:h-[400px] object-cover rounded-2xl art-glow"
            fallback={
              <div className="w-[260px] h-[260px] lg:w-[340px] lg:h-[340px] xl:w-[400px] xl:h-[400px] rounded-2xl bg-raised ring-1 ring-edge flex items-center justify-center">
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
            {state &&
              state !== 'play' &&
              (state !== 'buffering' || bufferingSettled) && (
                <span className={cx('microlabel', state === 'pause' ? 'text-amber' : '')}>
                  {state === 'pause' ? 'paused' : state}
                </span>
              )}
          </div>

          <div
            className={cx(
              'space-y-1 transition-opacity duration-300',
              trackVisible ? 'opacity-100' : 'opacity-0'
            )}
          >
            <h1 className="font-display font-bold text-[clamp(28px,4vw,46px)] leading-[1.08] tracking-tight text-balance">
              {shownTrack.title}
            </h1>
            {shownTrack.subtitle && (
              <div className="font-display text-[23px] leading-tight tracking-tight text-ink/80 truncate">
                {shownTrack.subtitle}
              </div>
            )}
            {shownTrack.album && <div className="text-[14px] text-dim truncate">{shownTrack.album}</div>}
          </div>

          {shownTrack.badges.length > 0 && (
            <div
              className={cx(
                'flex flex-wrap items-center gap-1.5 transition-opacity duration-300',
                trackVisible ? 'opacity-100' : 'opacity-0',
                mirrored && 'justify-end'
              )}
            >
              {shownTrack.badges.map((b) => (
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
            <div
              className={cx(
                'microlabel transition-opacity duration-300',
                trackVisible ? 'opacity-100' : 'opacity-0'
              )}
            >
              track {queueIndex + 1} of {queueLength}
            </div>
          )}

          {/* inline lyric flavor — never alongside the full panel; fades with
              the track group so it doesn't pop on a change */}
          {lyricsAvailable && lyricsLine && !lyricsOpen && (
            <div
              className={cx(
                'transition-opacity duration-300',
                trackVisible ? 'opacity-100' : 'opacity-0'
              )}
            >
              <LyricLine />
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  )
}
