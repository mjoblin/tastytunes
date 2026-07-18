// ListenBrainz scrobbler. Watches play_state pushes (fed from DeviceManager,
// the same seam recents uses) and submits compliant listens: a track counts
// once it has actually PLAYED for half its length or 4 minutes, whichever is
// first — accumulated wallclock while state is 'play', so pauses don't count
// and seeks can't cheat. Radio and metadata-less sources are never scrobbled.
// Failed listens queue in memory (bounded) and flush with the next success.
import { version } from '../../package.json'
import { isRadioMetadata, type ZonePlayState } from '@shared/smoip'
import { getSettings } from './persist'
import { loggedFetch } from './netlog'

// TASTYTUNES_LB_URL lets test harnesses point submissions at a local server.
const BASE = process.env['TASTYTUNES_LB_URL'] ?? 'https://api.listenbrainz.org'
const MIN_TRACK_SECS = 30
const SUBMIT_CAP_SECS = 240
const PENDING_MAX = 100

interface TrackMeta {
  artist: string
  title: string
  album: string | null
  durationSecs: number | null
}

interface CurrentTrack {
  key: string
  meta: TrackMeta
  /** Epoch seconds when the track started — becomes listened_at. */
  startedAt: number
  playedMs: number
  playingSince: number | null
  submitted: boolean
}

interface Listen {
  listened_at: number
  track_metadata: Record<string, unknown>
}

let current: CurrentTrack | null = null
const pending: Listen[] = []
let timer: NodeJS.Timeout | null = null

function enabled(): boolean {
  const s = getSettings()
  return s.lbEnabled && s.lbToken.trim().length > 0
}

function trackMetadata(meta: TrackMeta): Record<string, unknown> {
  return {
    artist_name: meta.artist,
    track_name: meta.title,
    ...(meta.album ? { release_name: meta.album } : {}),
    additional_info: {
      media_player: 'TastyTunes',
      submission_client: 'TastyTunes',
      submission_client_version: version,
      ...(meta.durationSecs != null ? { duration_ms: Math.round(meta.durationSecs * 1000) } : {})
    }
  }
}

async function post(body: unknown): Promise<boolean> {
  const token = getSettings().lbToken.trim()
  try {
    const res = await loggedFetch('listenbrainz', `${BASE}/1/submit-listens`, {
      method: 'POST',
      headers: {
        authorization: `Token ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    })
    return res.ok
  } catch {
    return false
  }
}

async function submitListen(listen: Listen): Promise<void> {
  const ok = await post({ listen_type: 'single', payload: [listen] })
  if (!ok) {
    pending.push(listen)
    if (pending.length > PENDING_MAX) pending.shift()
    return
  }
  // A success means we're reachable again — flush anything that queued up.
  if (pending.length > 0) {
    const batch = pending.splice(0, pending.length)
    const flushed = await post({ listen_type: 'import', payload: batch })
    if (!flushed) pending.push(...batch.slice(-PENDING_MAX))
  }
}

function playedSecs(t: CurrentTrack): number {
  const live = t.playingSince != null ? Date.now() - t.playingSince : 0
  return (t.playedMs + live) / 1000
}

function checkThreshold(): void {
  if (!current || current.submitted || !enabled()) return
  const d = current.meta.durationSecs
  if (d != null && d < MIN_TRACK_SECS) return
  const threshold = d != null ? Math.min(d / 2, SUBMIT_CAP_SECS) : SUBMIT_CAP_SECS
  if (playedSecs(current) >= threshold) {
    current.submitted = true
    void submitListen({
      listened_at: current.startedAt,
      track_metadata: trackMetadata(current.meta)
    })
  }
}

export const scrobbler = {
  /** Feed every /zone/play_state push through here (DeviceManager does). */
  onPlayState(ps: ZonePlayState): void {
    if (!enabled()) return
    const md = ps.metadata
    const isRadio = isRadioMetadata(md)
    const artist = md?.artist ?? null
    const title = md?.title ?? null

    // Nothing scrobblable: close out any accumulation and wait.
    if (isRadio || !artist || !title) {
      this.pause()
      return
    }

    const key = `${artist}|${title}|${md?.album ?? ''}|${ps.queue_id ?? ''}`
    if (!current || current.key !== key) {
      current = {
        key,
        meta: {
          artist,
          title,
          album: md?.album ?? null,
          durationSecs: md?.duration ?? null
        },
        startedAt: Math.floor(Date.now() / 1000),
        playedMs: 0,
        playingSince: null,
        submitted: false
      }
      void post({ listen_type: 'playing_now', payload: [{ track_metadata: trackMetadata(current.meta) }] })
    }

    if (ps.state === 'play') {
      if (current.playingSince == null) current.playingSince = Date.now()
      if (!timer) timer = setInterval(checkThreshold, 5_000)
    } else {
      this.pause()
    }
    checkThreshold()
  },

  /** Stop accumulating (pause/stop/disconnect) without forgetting the track. */
  pause(): void {
    if (current?.playingSince != null) {
      current.playedMs += Date.now() - current.playingSince
      current.playingSince = null
    }
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  },

  /** Connection lost or device switched — wallclock must stop counting. */
  reset(): void {
    this.pause()
    current = null
  },

  /** GET /1/validate-token for the settings UI. null = network failure. */
  async validateToken(): Promise<{ valid: boolean; userName: string | null } | null> {
    const token = getSettings().lbToken.trim()
    if (!token) return { valid: false, userName: null }
    try {
      const res = await loggedFetch('listenbrainz', `${BASE}/1/validate-token`, {
        headers: { authorization: `Token ${token}` },
        signal: AbortSignal.timeout(10_000)
      })
      if (!res.ok) return { valid: false, userName: null }
      const body = (await res.json()) as { valid?: boolean; user_name?: string }
      return { valid: !!body.valid, userName: body.user_name ?? null }
    } catch {
      return null
    }
  }
}
