import { useEffect } from 'react'
import type { MotionMode } from '@shared/ipc'

/**
 * Resolve settings.motion against the OS Reduce Motion preference and stamp
 * the result on :root as .reduce-motion — the single source of truth that the
 * motion-safe: variant, the animation freezes, and smooth scrolling all read.
 * Mounted by both windows (App and MiniPlayer).
 */
export function useMotionPreference(motion: MotionMode): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = (): void => {
      const reduce = motion === 'off' || (motion === 'system' && mq.matches)
      document.documentElement.classList.toggle('reduce-motion', reduce)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [motion])
}
