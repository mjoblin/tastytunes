import { ExternalLink, Heart, X } from 'lucide-react'
import { version } from '../../../../package.json'
import { tt } from '@/api'
import { useStore } from '@/store'

const REPO_URL = 'https://github.com/mjoblin/tastytunes'
const SUPPORT_URL = 'https://punytunes.app/support/'

export function InfoModal(): React.JSX.Element {
  const setInfoOpen = useStore((s) => s.setInfoOpen)
  const update = useStore((s) => s.update)

  return (
    <div
      className="absolute inset-0 z-30 bg-black/60 backdrop-blur-sm flex items-center justify-center"
      onClick={() => setInfoOpen(false)}
    >
      <div
        className="w-[420px] rounded-2xl bg-panel ring-1 ring-edge2 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start">
          <div className="flex-1">
            <div className="font-display font-bold text-[24px] leading-none tracking-tight">
              tasty<span className="text-gold">tunes</span>
            </div>
            <div className="microlabel mt-2">
              v{version} · GPLv3 · a controller for streammagic streamers
            </div>
          </div>
          <button
            onClick={() => setInfoOpen(false)}
            className="p-1 text-faint hover:text-dim transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-6 space-y-3">
          {update && (
            <div className="w-full rounded-xl ring-1 ring-gold/40 bg-golddim px-4 py-3">
              {update.phase === 'available' && (
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-[13.5px] text-gold">
                      v{update.version} is available
                    </span>
                    <span className="block font-mono text-[10.5px] text-faint mt-0.5">
                      {update.canDownload
                        ? 'nothing downloads until you say so'
                        : 'open the release page to download'}
                    </span>
                  </span>
                  {update.canDownload ? (
                    <button
                      onClick={() => void tt.updateDownload()}
                      className="shrink-0 text-[12.5px] px-3.5 py-1.5 rounded-lg bg-gold text-bg font-medium hover:brightness-110 motion-safe:active:scale-95 transition-all"
                    >
                      Download
                    </button>
                  ) : (
                    <button
                      onClick={() => void tt.openExternal(update.url)}
                      className="shrink-0 flex items-center gap-1.5 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
                    >
                      Release page <ExternalLink size={12} />
                    </button>
                  )}
                </div>
              )}

              {update.phase === 'downloading' && (
                <div>
                  <div className="flex items-center justify-between text-[13.5px] text-gold">
                    <span>Downloading v{update.version}…</span>
                    <span className="font-mono text-[11px]">{update.percent ?? 0}%</span>
                  </div>
                  <div className="h-1 rounded-full bg-veil2 mt-2 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gold transition-[width] duration-300"
                      style={{ width: `${update.percent ?? 0}%` }}
                    />
                  </div>
                </div>
              )}

              {update.phase === 'downloaded' && (
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-[13.5px] text-gold">
                      v{update.version} is ready
                    </span>
                    <span className="block font-mono text-[10.5px] text-faint mt-0.5">
                      installs when you quit — or restart now
                    </span>
                  </span>
                  <button
                    onClick={() => void tt.updateInstall()}
                    className="shrink-0 text-[12.5px] px-3.5 py-1.5 rounded-lg bg-gold text-bg font-medium hover:brightness-110 motion-safe:active:scale-95 transition-all"
                  >
                    Restart now
                  </button>
                </div>
              )}

              {update.phase === 'error' && (
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-[13.5px] text-alert">Update failed</span>
                    <span className="block font-mono text-[10.5px] text-faint mt-0.5 break-all">
                      {update.error}
                    </span>
                  </span>
                  <button
                    onClick={() => void tt.updateDownload()}
                    className="shrink-0 text-[12.5px] px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => void tt.openExternal(REPO_URL)}
            className="w-full flex items-center justify-between rounded-xl ring-1 ring-edge bg-raised/70 px-4 py-3 text-left hover:ring-edge2 transition-all"
          >
            <span>
              <span className="block text-[13.5px]">Source &amp; issues</span>
              <span className="block font-mono text-[10.5px] text-faint mt-0.5">
                github.com/mjoblin/tastytunes
              </span>
            </span>
            <ExternalLink size={14} className="text-faint shrink-0" />
          </button>

          <button
            onClick={() => void tt.openExternal(SUPPORT_URL)}
            className="w-full flex items-center justify-between rounded-xl ring-1 ring-edge bg-raised/70 px-4 py-3 text-left hover:ring-edge2 transition-all"
          >
            <span>
              <span className="block text-[13.5px]">Support</span>
              <span className="block font-mono text-[10.5px] text-faint mt-0.5">
                punytunes.app/support
              </span>
            </span>
            <ExternalLink size={14} className="text-faint shrink-0" />
          </button>

          <p className="text-[11.5px] text-faint leading-relaxed px-1">
            Yep — that's the support link for PunyTunes, not TastyTunes. Same author, same
            streamers, same inbox. I'm not going to create a different support link.
          </p>

          <p className="text-[11.5px] text-faint leading-relaxed px-1">
            Please don't support the app unless you can afford it, but if you enjoy the app and
            are comfortable contributing, then your support is greatly appreciated{' '}
            <Heart size={11} className="inline-block text-gold -mt-0.5" fill="currentColor" strokeWidth={0} />
          </p>

          <div className="pt-3 mt-1 border-t border-edge text-center text-[10.5px] text-faint">
            © 2026 Redacted Cat
          </div>
        </div>
      </div>
    </div>
  )
}
