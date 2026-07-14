import type { ZoneNowPlaying, ZonePlayState } from '@shared/smoip'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function fmtTime(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return '–:––'
  const s = Math.floor(secs)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

export function fmtKHz(sampleRate: number): string {
  const khz = sampleRate / 1000
  return Number.isInteger(khz) ? `${khz} kHz` : `${khz.toFixed(1)} kHz`
}

export interface NowPlayingMeta {
  title: string | null
  subtitle: string | null // artist, or the "now playing" text on radio
  album: string | null
  artUrl: string | null
  isRadio: boolean
  badges: string[]
}

/**
 * Merge /zone/play_state metadata with /zone/now_playing display info into
 * something displayable, with the radio special-casing both reference apps use.
 */
export function deriveNowPlaying(
  playState: ZonePlayState | null,
  nowPlaying: ZoneNowPlaying | null
): NowPlayingMeta {
  const md = playState?.metadata ?? null
  const display = nowPlaying?.display ?? null
  const klass = md?.class ?? display?.class ?? ''
  const isRadio = /radio/i.test(klass) || md?.station != null

  const badges: string[] = []
  if (md?.codec) badges.push(md.codec)
  if (md?.sample_rate) badges.push(fmtKHz(md.sample_rate))
  if (md?.bit_depth) badges.push(`${md.bit_depth}-bit`)
  if (md?.bitrate) badges.push(`${Math.round(md.bitrate / 1000)} kbps`)
  if (md?.lossless) badges.push('lossless')
  if (md?.mqa && md.mqa !== 'none') badges.push(`MQA ${md.mqa}`)

  if (isRadio) {
    return {
      title: md?.station ?? display?.line1 ?? md?.title ?? null,
      subtitle: md?.title ?? display?.line2 ?? null,
      album: null,
      artUrl: md?.art_url ?? display?.art_url ?? null,
      isRadio,
      badges
    }
  }

  return {
    title: md?.title ?? display?.line1 ?? null,
    subtitle: md?.artist ?? display?.line2 ?? null,
    album: md?.album ?? display?.line3 ?? null,
    artUrl: md?.art_url ?? display?.art_url ?? null,
    isRadio,
    badges
  }
}

/** The transport controls the streamer currently allows (/zone/now_playing controls[]). */
export function controlSet(nowPlaying: ZoneNowPlaying | null): Set<string> {
  return new Set(nowPlaying?.controls ?? [])
}

// ------------------------------------------------------------ signal quality lamp

export type SignalQuality = 'hires' | 'lossless' | 'lossy' | 'unknown'

/** Roon-style one-glance stream quality, from /zone/play_state metadata. */
export function signalQuality(playState: ZonePlayState | null): SignalQuality {
  const md = playState?.metadata
  if (!md) return 'unknown'
  const hires =
    (md.sample_rate != null && md.sample_rate > 48_000) ||
    (md.bit_depth != null && md.bit_depth > 16) ||
    (md.mqa != null && md.mqa !== 'none')
  if (md.lossless && hires) return 'hires'
  if (md.lossless) return 'lossless'
  if (md.codec || md.bitrate || md.sample_rate) return 'lossy'
  return 'unknown'
}

/** Fixed (non-accent) lamp colors so quality reads consistently across albums. */
export const SIGNAL_COLORS: Record<SignalQuality, string> = {
  hires: '#f0a848',
  lossless: '#67dd8b',
  lossy: '#8d867a',
  unknown: '#4a453d'
}

export const SIGNAL_LABELS: Record<SignalQuality, string> = {
  hires: 'hi-res lossless',
  lossless: 'lossless',
  lossy: 'lossy',
  unknown: 'unknown'
}
