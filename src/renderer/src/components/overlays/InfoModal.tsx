import { ExternalLink, Heart } from 'lucide-react'
import { version } from '../../../../../package.json'
import { REPO_URL } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { CloseButton } from '@/components/controls/CloseButton'
import { ModalShell } from '@/components/chrome/Overlay'

const SUPPORT_URL = 'https://tastytunes.app/#support'

export function InfoModal(): React.JSX.Element | null {
  const open = useStore((s) => s.infoOpen)
  const setInfoOpen = useStore((s) => s.setInfoOpen)

  return (
    <ModalShell open={open} onClose={() => setInfoOpen(false)} className="w-[420px] p-6">
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
          className="w-full flex items-center justify-between rounded-xl ring-1 ring-edge bg-raised/70 px-4 py-3 text-left hover:ring-edge2"
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
          className="w-full flex items-center justify-between rounded-xl ring-1 ring-edge bg-raised/70 px-4 py-3 text-left hover:ring-edge2"
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
    </ModalShell>
  )
}
