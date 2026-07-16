import { useEffect, useRef, useState } from 'react'
import { ExternalLink, RotateCw, UserRound, X } from 'lucide-react'
import type { ArtistInfo } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { deriveNowPlaying } from '@/lib/format'
import { usePanelWidth } from '@/hooks/usePanelWidth'
import { PanelResizeHandle } from '@/components/PanelResizeHandle'

type Status = 'loading' | 'ready' | 'none'

/**
 * Artist-context drawer on Now Playing: MusicBrainz-matched artist with a
 * Wikipedia summary. Same shell as the lyrics drawer; the two are mutually
 * exclusive (the store's setters enforce it).
 */
export function ArtistPanel(): React.JSX.Element {
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const setArtistOpen = useStore((s) => s.setArtistOpen)

  const meta = deriveNowPlaying(playState, nowPlaying)
  const artist = meta.isRadio ? null : meta.subtitle
  const { width, dragging, snapped, handleProps } = usePanelWidth()

  const [status, setStatus] = useState<Status>('loading')
  const [info, setInfo] = useState<ArtistInfo | null>(null)
  const [fetchNonce, setFetchNonce] = useState(0)
  const forceRef = useRef(false)

  useEffect(() => {
    if (!artist) {
      setStatus('none')
      setInfo(null)
      return
    }
    const force = forceRef.current
    forceRef.current = false
    let stale = false
    setStatus('loading')
    void tt
      .fetchArtistInfo(artist, force)
      .then((res) => {
        if (stale) return
        setInfo(res)
        setStatus(res ? 'ready' : 'none')
      })
      .catch(() => {
        if (!stale) setStatus('none')
      })
    return () => {
      stale = true
    }
  }, [artist, fetchNonce])

  const refresh = (): void => {
    forceRef.current = true
    setFetchNonce((n) => n + 1)
  }

  return (
    <aside
      style={{ width }}
      className="no-drag absolute inset-y-0 right-0 z-10 max-w-[45%] flex flex-col bg-panel/60 backdrop-blur-md border-l border-edge"
    >
      <PanelResizeHandle dragging={dragging} snapped={snapped} handleProps={handleProps} />
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <div className="microlabel text-ink/80 flex items-center gap-2">
          <UserRound size={13} />
          artist
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            disabled={status === 'loading'}
            aria-label="Refresh artist details"
            data-tip="Refresh artist details"
            className="tip-bottom tip-end p-1.5 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all disabled:opacity-40 disabled:pointer-events-none"
          >
            <RotateCw size={13} />
          </button>
          <button
            onClick={() => setArtistOpen(false)}
            aria-label="Close artist panel"
            className="p-1.5 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
        {status === 'loading' && (
          <div className="text-[13px] text-dim pt-2 motion-safe:animate-pulse">
            Retrieving artist details…
          </div>
        )}

        {status === 'none' && (
          <div className="text-[13px] text-faint pt-2">
            {artist
              ? `Nothing found for ${artist}.`
              : 'Artist info needs track metadata — not available for this source.'}
          </div>
        )}

        {status === 'ready' && info && (
          <div className="space-y-3 py-1">
            <div className="font-display font-bold text-[19px] tracking-tight">{info.name}</div>
            {info.summary ? (
              <p className="text-[13.5px] leading-relaxed text-dim whitespace-pre-wrap">
                {info.summary}
              </p>
            ) : (
              <p className="text-[13px] text-faint">
                Matched on MusicBrainz, but no Wikipedia summary is linked.
              </p>
            )}
          </div>
        )}
      </div>

      {status === 'ready' && info && (
        <div className="px-6 py-3 border-t border-edge flex items-center gap-4">
          {info.wikipediaUrl && (
            <button
              onClick={() => void tt.openExternal(info.wikipediaUrl!)}
              className="microlabel flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
            >
              wikipedia <ExternalLink size={10} />
            </button>
          )}
          {info.musicbrainzUrl && (
            <button
              onClick={() => void tt.openExternal(info.musicbrainzUrl!)}
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
