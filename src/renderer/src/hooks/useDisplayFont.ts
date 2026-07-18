import { useEffect } from 'react'
import type { DisplayFont } from '@shared/ipc'

/**
 * The curated display faces. Every face ships in the bundle (fontsource
 * variable packages, imported in main.tsx) — the browser only downloads the
 * woff2 for families actually used, so the inactive faces cost nothing at
 * runtime. Stacks fall back to the same generics styles.css declares.
 */
export const DISPLAY_FONTS: Array<{ id: DisplayFont; label: string; stack: string }> = [
  {
    id: 'bricolage',
    label: 'Bricolage Grotesque',
    stack: "'Bricolage Grotesque Variable', ui-sans-serif, sans-serif"
  },
  { id: 'fraunces', label: 'Fraunces', stack: "'Fraunces Variable', Georgia, serif" },
  {
    id: 'space-grotesk',
    label: 'Space Grotesk',
    stack: "'Space Grotesk Variable', ui-sans-serif, sans-serif"
  },
  { id: 'sora', label: 'Sora', stack: "'Sora Variable', ui-sans-serif, sans-serif" },
  { id: 'unbounded', label: 'Unbounded', stack: "'Unbounded Variable', ui-sans-serif, sans-serif" }
]

export const fontStack = (id: DisplayFont): string =>
  (DISPLAY_FONTS.find((f) => f.id === id) ?? DISPLAY_FONTS[0]).stack

/**
 * Apply the chosen display face by overriding the --font-display token on
 * the root — every font-display utility in the app follows. Mounted by both
 * windows (App and MiniPlayer), like useTheme.
 */
export function useDisplayFont(pref: DisplayFont): void {
  useEffect(() => {
    document.documentElement.style.setProperty('--font-display', fontStack(pref))
  }, [pref])
}
