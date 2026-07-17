import { useEffect, useRef, useState } from 'react'
import { Disc3, ExternalLink, RotateCw, UserRound, X } from 'lucide-react'
import type { AlbumInfo, ArtistInfo } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { deriveNowPlaying } from '@/lib/format'
import { usePanelWidth } from '@/hooks/usePanelWidth'
import { PanelResizeHandle } from '@/components/PanelResizeHandle'
import { Segmented } from '@/components/Segmented'

type Status = 'loading' | 'ready' | 'none'
type Tab = 'artist' | 'album'

/**
 * Context drawer on Now Playing — Artist | Album tabs. Artist: a MusicBrainz-
 * matched artist with a Wikipedia summary. Album: release-group facts (year,
 * type, label, genre tags, release-level credits) plus a Wikipedia summary
 * when one is linked. Same shell as the lyrics drawer; the two drawers are
 * mutually exclusive (the store's setters enforce it). Each tab fetches only
 * while active — the disk cache makes revisits instant.
 */
export function ArtistPanel(): React.JSX.Element {
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const setArtistOpen = useStore((s) => s.setArtistOpen)
  const contextTab = useStore((s) => s.contextTab)
  const setContextTab = useStore((s) => s.setContextTab)

  const meta = deriveNowPlaying(playState, nowPlaying)
  const artist = meta.isRadio ? null : meta.subtitle
  const album = meta.isRadio ? null : meta.album
  const tab: Tab = album ? contextTab : 'artist'
  const { width, dragging, snapped, handleProps } = usePanelWidth()

  const [artistStatus, setArtistStatus] = useState<Status>('loading')
  const [artistInfo, setArtistInfo] = useState<ArtistInfo | null>(null)
  const [albumStatus, setAlbumStatus] = useState<Status>('loading')
  const [albumInfo, setAlbumInfo] = useState<AlbumInfo | null>(null)
  const [fetchNonce, setFetchNonce] = useState(0)
  const forceRef = useRef(false)

  useEffect(() => {
    if (tab !== 'artist') return
    if (!artist) {
      setArtistStatus('none')
      setArtistInfo(null)
      return
    }
    const force = forceRef.current
    forceRef.current = false
    let stale = false
    setArtistStatus('loading')
    void tt
      .fetchArtistInfo(artist, force)
      .then((res) => {
        if (stale) return
        setArtistInfo(res)
        setArtistStatus(res ? 'ready' : 'none')
      })
      .catch(() => {
        if (!stale) setArtistStatus('none')
      })
    return () => {
      stale = true
    }
  }, [tab, artist, fetchNonce])

  useEffect(() => {
    if (tab !== 'album') return
    if (!artist || !album) {
      setAlbumStatus('none')
      setAlbumInfo(null)
      return
    }
    const force = forceRef.current
    forceRef.current = false
    let stale = false
    setAlbumStatus('loading')
    void tt
      .fetchAlbumInfo(artist, album, force)
      .then((res) => {
        if (stale) return
        setAlbumInfo(res)
        setAlbumStatus(res ? 'ready' : 'none')
      })
      .catch(() => {
        if (!stale) setAlbumStatus('none')
      })
    return () => {
      stale = true
    }
  }, [tab, artist, album, fetchNonce])

  const refresh = (): void => {
    forceRef.current = true
    setFetchNonce((n) => n + 1)
  }

  const status = tab === 'artist' ? artistStatus : albumStatus
  const TabIcon = tab === 'artist' ? UserRound : Disc3
  const facts =
    albumInfo == null ? '' : [albumInfo.year, albumInfo.type, albumInfo.label].filter(Boolean).join(' · ')
  const footerInfo = tab === 'artist' ? artistInfo : albumInfo

  return (
    <aside
      style={{ width }}
      className="no-drag absolute inset-y-0 right-0 z-10 max-w-[60%] flex flex-col bg-panel/60 backdrop-blur-md border-l border-edge"
    >
      <PanelResizeHandle dragging={dragging} snapped={snapped} handleProps={handleProps} />
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <div className="microlabel text-ink/80 flex items-center gap-2">
          <TabIcon size={13} />
          {tab}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            disabled={status === 'loading'}
            aria-label={`Refresh ${tab} details`}
            data-tip={`Refresh ${tab} details`}
            className="tip-bottom tip-end p-1.5 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all disabled:opacity-40 disabled:pointer-events-none"
          >
            <RotateCw size={13} />
          </button>
          <button
            onClick={() => setArtistOpen(false)}
            aria-label="Close context panel"
            className="p-1.5 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {album && (
        <div className="px-6 pb-3">
          <Segmented<Tab>
            value={tab}
            onChange={setContextTab}
            options={[
              { value: 'artist', label: 'Artist' },
              { value: 'album', label: 'Album' }
            ]}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
        {status === 'loading' && (
          <div className="text-[13px] text-dim pt-2 motion-safe:animate-pulse">
            Retrieving {tab} details…
          </div>
        )}

        {status === 'none' && (
          <div className="text-[13px] text-faint pt-2">
            {tab === 'artist'
              ? artist
                ? `Nothing found for ${artist}.`
                : 'Artist info needs track metadata — not available for this source.'
              : album
                ? `Nothing found for ${album}.`
                : 'Album info needs track metadata — not available for this source.'}
          </div>
        )}

        {tab === 'artist' && artistStatus === 'ready' && artistInfo && (
          <div className="space-y-3 py-1">
            <div className="font-display font-bold text-[19px] tracking-tight">
              {artistInfo.name}
            </div>
            {artistInfo.summary ? (
              <p className="text-[13.5px] leading-relaxed text-dim whitespace-pre-wrap">
                {artistInfo.summary}
              </p>
            ) : (
              <p className="text-[13px] text-faint">
                Matched on MusicBrainz, but no Wikipedia summary is linked.
              </p>
            )}
          </div>
        )}

        {tab === 'album' && albumStatus === 'ready' && albumInfo && (
          <div className="space-y-3 py-1" data-album-tab>
            <div>
              <div className="font-display font-bold text-[19px] tracking-tight">
                {albumInfo.title}
              </div>
              {facts && <div className="text-[12.5px] text-dim pt-1">{facts}</div>}
            </div>
            {albumInfo.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {albumInfo.genres.map((g) => (
                  <span
                    key={g}
                    className="microlabel px-2 py-0.5 rounded-full ring-1 ring-edge bg-panel/70 text-faint"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}
            {albumInfo.summary ? (
              <p className="text-[13.5px] leading-relaxed text-dim whitespace-pre-wrap">
                {albumInfo.summary}
              </p>
            ) : (
              <p className="text-[13px] text-faint">
                Matched on MusicBrainz, but no Wikipedia summary is linked.
              </p>
            )}
            {albumInfo.credits.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="microlabel text-ink/80">credits</div>
                {albumInfo.credits.map((c) => (
                  <div key={`${c.role}|${c.name}`} className="text-[13px]">
                    <span className="text-faint">{c.role}</span>{' '}
                    <span className="text-dim">{c.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {status === 'ready' && footerInfo && (
        <div className="px-6 py-3 border-t border-edge flex flex-wrap items-center gap-x-4 gap-y-2">
          {footerInfo.wikipediaUrl && (
            <button
              onClick={() => void tt.openExternal(footerInfo.wikipediaUrl!)}
              className="microlabel flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
            >
              wikipedia <ExternalLink size={10} />
            </button>
          )}
          {footerInfo.musicbrainzUrl && (
            <button
              onClick={() => void tt.openExternal(footerInfo.musicbrainzUrl!)}
              className="microlabel flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
            >
              musicbrainz <ExternalLink size={10} />
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
