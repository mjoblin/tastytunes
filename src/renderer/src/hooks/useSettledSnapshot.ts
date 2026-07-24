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
 *
 * `sig` is the IDENTITY of the thing being shown, not everything the snapshot
 * carries — a field that can tick on its own (a per-second bitrate badge, a
 * radio stream's rolling text) belongs in the snapshot but NOT in `sig`, or it
 * re-arms the settle timer forever and the group never comes back. `maxHiddenMs`
 * is the backstop for the churn nobody predicted: once the group has been held
 * hidden that long, the source is treated as unsettleable and rendered live
 * until it goes quiet again — a slightly-early swap beats a blank block.
 */
export function useSettledSnapshot<T>(
  sig: string,
  snapshot: () => T,
  settleMs = 350,
  maxHiddenMs = 1200
): { shown: T; visible: boolean } {
  const [shown, setShown] = useState<T>(snapshot)
  const [visible, setVisible] = useState(false)
  const shownSig = useRef(sig)
  const liveSig = useRef(sig)
  const snapRef = useRef(snapshot)
  // Latest snapshot closure + signature, read by the deferred adopt below.
  // (Assigned in an effect, not during render — a render can be thrown away.)
  useEffect(() => {
    snapRef.current = snapshot
    liveSig.current = sig
  })

  const hiddenSince = useRef<number | null>(null)
  const unsettleable = useRef(false)

  useEffect(() => {
    const adopt = (): void => {
      shownSig.current = liveSig.current
      setShown(snapRef.current())
      setVisible(true)
      hiddenSince.current = null
    }
    // Live matches what's shown (steady state, or a glitch settled back): show it.
    if (sig === shownSig.current) {
      hiddenSince.current = null
      setVisible(true)
      return
    }
    // Proven unsettleable: swap live rather than strobing the group or holding
    // it hidden. One quiet settle window ends it and normal fading resumes.
    if (unsettleable.current) {
      adopt()
      const quiet = setTimeout(() => {
        unsettleable.current = false
      }, settleMs)
      return () => clearTimeout(quiet)
    }
    if (hiddenSince.current == null) {
      hiddenSince.current = Date.now()
    } else if (Date.now() - hiddenSince.current >= maxHiddenMs) {
      unsettleable.current = true
      adopt()
      return
    }
    // Changed: fade out now, adopt + fade in once `sig` holds steady.
    setVisible(false)
    const t = setTimeout(adopt, settleMs)
    return () => clearTimeout(t)
  }, [sig, settleMs, maxHiddenMs])

  return { shown, visible }
}
