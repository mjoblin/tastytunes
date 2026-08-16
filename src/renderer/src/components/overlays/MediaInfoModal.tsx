import { useState } from 'react'
import { Copy, Check, Disc3, Music2, User } from 'lucide-react'
import {
  albumComposers,
  albumFormat,
  discGroups,
  fmtBytes,
  formatLabel,
  trackArtists,
  trackPosition,
  type MediaInfoTarget,
  type MediaNode
} from '@shared/model'
import { artUrlAt } from '@shared/artUrl'
import { useStore } from '@/store'
import { ModalShell } from '@/components/chrome/Overlay'
import { CloseButton } from '@/components/controls/CloseButton'
import { ArtImage } from '@/components/media/ArtImage'
import { fmtTime } from '@/lib/format'
import { isAlbumClass, isArtistClass } from '@/lib/media'

/**
 * The Info modal: everything the server said about a piece of media, laid out
 * plainly (user ask, 2026-08-16). The rows and headers stay quiet on purpose
 * — THIS is where the detail lives. Three sections when they apply: what it
 * is (identity), how it's encoded (format), where it came from (source).
 * For an album, the caller hands over the tracks it already knows belong to
 * it, so runtime / size / format / composers are summed here, the same
 * derivations the album leaf and the lens use (albumFormat, albumComposers)
 * — never a second reading. "Copy as JSON" hands the raw node(s) to the
 * clipboard for bug reports.
 */

type Row = [label: string, value: React.ReactNode]

function kindOf(node: MediaNode): 'album' | 'artist' | 'folder' | 'track' {
  if (!node.isContainer) return 'track'
  if (isArtistClass(node.upnpClass)) return 'artist'
  if (isAlbumClass(node.upnpClass)) return 'album'
  return 'folder'
}

function Section({ title, rows }: { title: string; rows: Row[] }): React.JSX.Element | null {
  const shown = rows.filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0))
  if (shown.length === 0) return null
  return (
    <div data-info-section={title.toLowerCase()}>
      <div className="microlabel mb-1.5">{title}</div>
      <dl className="grid grid-cols-[112px_1fr] gap-x-4 gap-y-1 text-[12.5px]">
        {shown.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-faint truncate">{label}</dt>
            <dd className="text-ink min-w-0 break-words" data-info-field={label}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

const mono = (v: string | null | undefined): React.ReactNode =>
  v ? <span className="font-mono text-[11px] text-dim break-all">{v}</span> : null

export function MediaInfoModal({ target }: { target: MediaInfoTarget }): React.JSX.Element {
  const setMediaInfo = useStore((s) => s.setMediaInfo)
  const close = (): void => setMediaInfo(null)
  const { node, tracks, serverName, note, artist, stream } = target
  const kind = kindOf(node)
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    const payload = tracks && tracks.length > 0 ? { node, tracks } : node
    void navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  // ---- identity
  const performers = trackArtists(node)
  const identity: Row[] =
    kind === 'track'
      ? [
          ['Title', node.title],
          ['Performers', performers.length > 1 ? performers.join(', ') : (node.artist ?? null)],
          ['Album artist', node.albumArtist ?? null],
          ['Album', node.album ?? null],
          ['Composers', node.composers?.join(', ') ?? null],
          ['Year', node.year ?? null],
          ['Genres', node.genre?.join(', ') ?? null],
          [
            'Position',
            node.trackNumber != null
              ? `${trackPosition(node)}${node.discNumber != null ? ` · disc ${node.discNumber}${node.discCount ? ` of ${node.discCount}` : ''}` : ''}`
              : null
          ],
          ['Duration', node.durationSecs != null ? fmtTime(node.durationSecs) : null]
        ]
      : kind === 'album'
        ? [
            ['Title', node.title],
            ['Artist', node.artist ?? null],
            ['Year', node.year ?? null],
            ['Genres', node.genre?.join(', ') ?? null]
          ]
        : [
            ['Name', node.title],
            ...(node.artist ? ([['Artist', node.artist]] as Row[]) : [])
          ]

  // ---- format (a track's own; an album's summed from its tracks)
  const f = node.format
  const trackFormat: Row[] =
    kind === 'track' && f
      ? [
          ['Codec', f.codec],
          ['Bit depth', f.bits ? `${f.bits}-bit` : null],
          ['Sample rate', f.rate ? `${(f.rate / 1000).toFixed(f.rate % 1000 === 0 ? 0 : 1)} kHz` : null],
          ['Bitrate', f.kbps ? `${f.kbps} kbps` : null],
          ['Channels', f.channels ?? null],
          ['File size', f.sizeBytes ? fmtBytes(f.sizeBytes) : null]
        ]
      : []
  const albumRows: Row[] = (() => {
    if (kind !== 'album' || !tracks || tracks.length === 0) return []
    const secs = tracks.reduce((a, t) => a + (t.durationSecs ?? 0), 0)
    const bytes = tracks.reduce((a, t) => a + (t.format?.sizeBytes ?? 0), 0)
    const fmt = albumFormat(tracks)
    const odd = fmt.notes.filter(Boolean).length
    const discs = discGroups(tracks).filter((g) => g.disc != null).length
    const composers = albumComposers(tracks)
    return [
      ['Tracks', String(tracks.length)],
      ['Discs', discs > 1 ? String(discs) : null],
      ['Runtime', secs > 0 ? fmtTime(secs) : null],
      ['Size', bytes > 0 ? fmtBytes(bytes) : null],
      ['Format', fmt.label ? `${fmt.label}${odd > 0 ? ` (${odd} ${odd === 1 ? 'track differs' : 'tracks differ'})` : ''}` : null],
      ['Composers', composers.length > 0 ? composers.join(', ') : null]
    ]
  })()

  // ---- an artist's library page (artistSummary — shared with MCP)
  const list = (items: string[], max: number): React.ReactNode =>
    items.length === 0 ? null : (
      <span>
        {items.slice(0, max).join(' · ')}
        {items.length > max ? <span className="text-faint"> · +{items.length - max} more</span> : null}
      </span>
    )
  // Lists read as ROWS, the name in ink and its facts quiet beside it — a
  // "·"-joined sentence made a shelf of albums look like a paragraph
  // (user, 2026-08-16).
  const rows = (items: { name: string; meta: string | null }[], max: number): React.ReactNode =>
    items.length === 0 ? null : (
      <ul className="space-y-0.5" data-info-list>
        {items.slice(0, max).map((it, i) => (
          <li key={`${it.name}-${i}`} className="min-w-0 truncate">
            <span className="text-ink">{it.name}</span>
            {it.meta && <span className="text-faint ml-2">{it.meta}</span>}
          </li>
        ))}
        {items.length > max && <li className="text-faint">+{items.length - max} more</li>}
      </ul>
    )
  const artistRows: Row[] = artist
    ? [
        [
          'Albums',
          rows(
            artist.albums.map((a) => ({
              name: a.title,
              meta: [a.year, a.format].filter(Boolean).join(' · ') || null
            })),
            20
          )
        ],
        ['Tracks', artist.trackCount > 0 ? String(artist.trackCount) : null],
        ['Guest on', rows(artist.guestOn.map((g) => ({ name: g.title, meta: g.albumArtist ?? g.album ?? null })), 8)],
        ['Composed', artist.composed.length > 0 ? `${artist.composed.length} ${artist.composed.length === 1 ? 'track' : 'tracks'}` : null],
        ['Genres', list(artist.genres, 8)],
        ['Active', artist.years ? (artist.years[0] === artist.years[1] ? artist.years[0] : `${artist.years[0]}–${artist.years[1]}`) : null]
      ]
    : []

  // ---- the stream, as the streamer reports it (what is playing NOW)
  const khzOf = (hz: number): string => `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`
  const streamRows: Row[] = stream
    ? [
        ['Source', stream.source],
        ['Station', stream.station],
        ['Codec', stream.codec],
        ['Sample rate', stream.sampleRate ? khzOf(stream.sampleRate) : null],
        ['Bit depth', stream.bitDepth ? `${stream.bitDepth}-bit` : null],
        ['Bitrate', stream.bitrate ? `${Math.round(stream.bitrate / 1000)} kbps` : null],
        ['Format', !stream.sampleRate && !stream.codec ? stream.sampleFormat : null],
        ['Encoding', stream.encoding],
        ['Lossless', stream.lossless == null ? null : stream.lossless ? 'yes' : 'no'],
        ['MQA', stream.mqa],
        ['Queue', stream.queuePosition != null && stream.queueLength != null ? `${stream.queuePosition} of ${stream.queueLength}` : null],
        ['Presettable', stream.presettable == null ? null : stream.presettable ? 'yes' : 'no'],
        ['Controls', stream.controls.length > 0 ? stream.controls.join(', ') : null],
        ['Radio id', mono(stream.radioId)],
        ['Playback', [stream.playbackSource, stream.playbackClass].filter(Boolean).join(' · ') || null]
      ]
    : []

  // ---- source
  const source: Row[] = [
    ['Server', serverName ?? node.serverName ?? null],
    ['Object id', node.id ? mono(node.id) : null],
    ['Parent id', mono(node.parentId)],
    ['Class', node.id ? mono(node.upnpClass) : null],
    ['Art', mono(node.artUrl)]
  ]

  const Icon = kind === 'track' ? Music2 : kind === 'artist' ? User : Disc3
  const subtitle =
    kind === 'track'
      ? [node.artist, node.album].filter(Boolean).join(' · ')
      : kind === 'album'
        ? [node.artist, node.year].filter(Boolean).join(' · ')
        : null

  return (
    <ModalShell onClose={close} className="w-[640px] max-w-[92vw] max-h-[86vh] flex flex-col p-6" >
      <div className="flex items-start gap-5" data-media-info>
        <div className="h-[128px] w-[128px] shrink-0 rounded-xl overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
          <ArtImage
            src={artUrlAt(node.artUrl, 128)}
            className="h-full w-full object-cover"
            fallback={<Icon size={40} strokeWidth={1} className="text-faint" />}
          />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="microlabel">{stream ? `now playing · ${kind === 'track' && /audioBroadcast/.test(node.upnpClass) ? 'radio' : kind}` : kind}</div>
          <div className="font-display font-bold text-[20px] tracking-tight leading-tight mt-1 break-words">
            {node.title}
          </div>
          {subtitle && <div className="text-[13px] text-dim mt-0.5 truncate">{subtitle}</div>}
        </div>
        <CloseButton onClick={close} />
      </div>

      {note && (
        <div className="mt-3 text-[11.5px] text-faint" data-info-note>
          {note}
        </div>
      )}
      <div className="mt-5 min-h-0 overflow-y-auto pr-1 space-y-5" data-info-body>
        {streamRows.length > 0 && <Section title="Stream" rows={streamRows} />}
        <Section title="Identity" rows={identity} />
        {artistRows.length > 0 && <Section title="Library" rows={artistRows} />}
        {albumRows.length > 0 && <Section title="Album" rows={albumRows} />}
        {trackFormat.length > 0 && <Section title="Format" rows={trackFormat} />}
        <Section title="Source" rows={source} />
      </div>

      <div className="mt-5 flex items-center justify-between">
        <span className="text-[11.5px] text-faint">
          {kind === 'album' && (!tracks || tracks.length === 0)
            ? 'Open the album to see its tracks summed here.'
            : kind === 'artist' && !artist
              ? 'No library index covers this artist yet.'
              : formatLabel(node.format) ?? ''}
        </span>
        <button
          onClick={copy}
          data-info-copy
          className="flex items-center gap-1.5 rounded-full ring-1 ring-edge bg-raised/70 px-3 py-1.5 text-[12px] text-dim hover:text-ink hover:ring-edge2"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy as JSON'}
        </button>
      </div>
    </ModalShell>
  )
}
