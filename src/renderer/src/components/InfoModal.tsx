import { ExternalLink, Heart } from 'lucide-react'
import { version } from '../../../../package.json'
import { tt } from '@/api'
import { useStore } from '@/store'
import { CloseButton } from '@/components/CloseButton'

const REPO_URL = 'https://github.com/mjoblin/tastytunes'
const SUPPORT_URL = 'https://tastytunes.app/#support'

export function InfoModal(): React.JSX.Element {
  const setInfoOpen = useStore((s) => s.setInfoOpen)

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
            <div className="font-wordmark font-bold text-[24px] leading-none tracking-tight">
              tasty<span className="text-gold">tunes</span>
            </div>
            <div className="microlabel mt-2">
              v{version} · GPLv3 · a controller for streammagic streamers
            </div>
          </div>
          <CloseButton onClick={() => setInfoOpen(false)} />
        </div>

        <div className="mt-6 space-y-3">
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
                tastytunes.app/#support
              </span>
            </span>
            <ExternalLink size={14} className="text-faint shrink-0" />
          </button>

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
