import { tt } from '@/api'
import { useStore } from '@/store'

/**
 * What playing a station actually needs. Structural rather than `RadioStation`
 * so a FAVORITED station plays through the same path — a favorite carries a
 * url, a name and a favicon but none of the directory metadata.
 */
export interface PlayableStation {
  url: string
  name: string
  favicon: string | null
  /** radio-browser's id when it came from the directory. */
  uuid?: string
}

/**
 * Play an internet-radio station on the streamer.
 *
 * Shared by the Radio screen and unified search (2026-07-25) — not because the
 * command is hard, but because of the SIDE EFFECT next to it: `lastStation` is
 * the only record of the URL behind what's playing, since play_state carries no
 * URL, and it's what lets Now Playing heart a stream the app started. A second
 * play path that forgot to set it would leave the heart mysteriously dead for
 * stations played from search.
 *
 * Rejections are toasted centrally by the api layer; the boolean is for callers
 * that show their own pending state (the Radio screen's "tuning in…").
 */
export async function playStation(station: PlayableStation): Promise<boolean> {
  useStore.getState().setLastStation({
    url: station.url,
    name: station.name,
    favicon: station.favicon,
    // radio-browser uses the URL as the uuid for hand-entered stations
    radioBrowserUuid: station.uuid && station.uuid !== station.url ? station.uuid : null
  })
  try {
    await tt.command({ type: 'streamRadio', url: station.url, name: station.name })
    return true
  } catch {
    return false
  }
}
