import { useEffect, useRef, useState } from 'react'
import { playStation, type PlayableStation } from '@/lib/radio'

/**
 * The "tuning in…" window between clicking a station and its stream landing.
 *
 * The device answers the play command instantly but the stream takes seconds
 * to actually start, so the clicked row pre-glows until the station shows up
 * in play_state (matched against `playingName` — see playingStationName), a
 * dead stream gives up after 15s, and a refused command clears immediately
 * (the failure itself is toasted centrally by the api layer).
 *
 * Lifted out of RadioScreen 2026-07-25 when unified search gained live
 * station rows — the same reason StationRow itself moved: re-implementing the
 * state is exactly how the two surfaces would drift.
 */
export function useStationTuning(playingName: string | null): {
  /** URL of the station on its way to playing, or null. */
  tuningUrl: string | null
  play(st: PlayableStation): Promise<void>
} {
  const [starting, setStarting] = useState<{ url: string; name: string } | null>(null)
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (starting && playingName === starting.name.trim().toLowerCase()) setStarting(null)
  }, [starting, playingName])
  useEffect(
    () => () => {
      if (timeout.current) clearTimeout(timeout.current)
    },
    []
  )

  const play = async (st: PlayableStation): Promise<void> => {
    setStarting({ url: st.url, name: st.name })
    if (timeout.current) clearTimeout(timeout.current)
    // dead-stream fallback: stop indicating if it never lands
    timeout.current = setTimeout(() => setStarting(null), 15_000)
    if (!(await playStation(st))) setStarting(null)
  }

  return { tuningUrl: starting?.url ?? null, play }
}
