import type { PlaylistActivation } from '@shared/model'
import { tt } from '@/api'
import { useStore } from '@/store'

/**
 * Activate a playlist — replace the streamer's queue with it — and TELL the
 * user how it went.
 *
 * Shared by the Playlists screen and unified search (the lib/recents pattern:
 * one helper so the outcome reporting can't belong to only one surface). The
 * reporting is the point of the wrapper. Activation replaces the QUEUE — an
 * effect you can't see from either surface — so the outcome toasts with a way
 * there; and rejections (not connected, a run already going, a mid-run network
 * failure) don't ride the command() path, so the api layer's central failure
 * toast never sees them — the catch here is that toast's stand-in. Search
 * originally called tt.playlistActivate with a bare `.catch(() => {})`, which
 * was a Play button that could silently do nothing.
 */
export async function activatePlaylist(p: { id: string; name: string }): Promise<void> {
  const showToast = useStore.getState().showToast
  let res: PlaylistActivation
  try {
    res = await tt.playlistActivate(p.id)
  } catch {
    showToast({ kind: 'error', text: `Couldn't load “${p.name}”` })
    return
  }
  const missed = res.missed.length
  showToast({
    kind: res.added > 0 ? 'success' : 'error',
    text: res.cancelled
      ? `Stopped — ${res.added} of ${res.total} loaded`
      : missed > 0
        ? `Loaded ${res.added} of ${res.total} — ${missed} not found`
        : `Loaded ${res.added} ${res.added === 1 ? 'track' : 'tracks'} from “${p.name}”`,
    action: { label: 'Open Queue', screen: 'queue' }
  })
}
