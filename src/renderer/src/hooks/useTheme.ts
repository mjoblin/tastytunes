import { useEffect, useState } from 'react'
import type { Theme, ThemePreference } from '@shared/ipc'

/** The OS-resolved theme for a 'system' preference. */
export function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Resolve the stored theme preference ('system' follows the OS, live) into the
 * concrete theme: stamps :root.light and returns the resolved value for
 * consumers that need it (useArtAccent clamps its accent per theme).
 * Mounted by both windows (App and MiniPlayer).
 */
export function useTheme(pref: ThemePreference): Theme {
  const [resolved, setResolved] = useState<Theme>(() => (pref === 'system' ? systemTheme() : pref))

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const theme: Theme = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref
      document.documentElement.classList.toggle('light', theme === 'light')
      setResolved(theme)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [pref])

  return resolved
}
