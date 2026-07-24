import { useEffect, useRef, useState } from 'react'

/**
 * Renders from a SETTLED snapshot that only adopts new data once `sig` stops
 * changing, and reports whether the group should be visible — for fading a
 * block out on change and back in once its source settles (e.g. track metadata
 * during the gap between tracks), without flashing intermediate/empty states.
 *
 * Pair `visible` with a `transition-opacity` class, and render from `shown`
 * (not the live values): on change it fades out showing the old snapshot,
 * stays hidden while `sig` churns, then adopts the new snapshot (while
 * invisible) and fades back in.
 */
export function useSettledSnapshot<T>(
  sig: string,
  snapshot: () => T,
  settleMs = 350
): { shown: T; visible: boolean } {
  const [shown, setShown] = useState<T>(snapshot)
  const [visible, setVisible] = useState(false)
  const shownSig = useRef(sig)
  const snapRef = useRef(snapshot)
  snapRef.current = snapshot
  useEffect(() => {
    // Live matches what's shown (steady state, or a glitch settled back): show it.
    if (sig === shownSig.current) {
      setVisible(true)
      return
    }
    // Changed: fade out now, adopt + fade in once `sig` holds steady.
    setVisible(false)
    const t = setTimeout(() => {
      shownSig.current = sig
      setShown(snapRef.current())
      setVisible(true)
    }, settleMs)
    return () => clearTimeout(t)
  }, [sig, settleMs])
  return { shown, visible }
}
