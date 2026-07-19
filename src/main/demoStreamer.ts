// The in-process demo device behind "Try without a streamer": a loopback
// SMOIP server (WS + HTTP) plus its own small UPnP media library, so every
// screen — Now Playing, Queue, Presets, Library, Sources — works with no
// hardware on the network. Doubles as the App Review demo and screenshot rig.
//
// Derived from dev/mock-streamer.mjs (the harness mock), minus that file's
// env-var scenario knobs. Behavioral fixes discovered in either copy should
// be mirrored into the other.
//
// The server binds an ephemeral loopback port; art URLs embed the port, so
// all state is built only after listen() reports it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'

const QUEUE_LEN = 30
const PLAYING_QUEUE_ID = 28

type Dict = Record<string, unknown>

// StreamMagic's query parser decodes %-escapes but takes '+' LITERALLY
// (probed live 2026-07-19). Mirror it for name/url params so a
// URLSearchParams regression app-side renders wrong here too instead of
// passing silently (same helper in dev/mock-streamer.mjs — deliberate fork).
function rawParam(u: URL, key: string): string | null {
  const m = u.search.match(new RegExp(`[?&]${key}=([^&]*)`))
  return m ? decodeURIComponent(m[1].replace(/\+/g, '%2B')) : null
}
type QueueItem = { id: number; position: number; srcId?: string; metadata: Dict }

const xmlEsc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const durFmt = (secs: number): string =>
  `0:${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}.000`
const didlWrap = (inner: string): string =>
  `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${inner}</DIDL-Lite>`
const didlContainer = (
  id: string,
  parent: string,
  title: string,
  cls: string,
  art: string | null,
  artist?: string,
  date?: string
): string =>
  `<container id="${id}" parentID="${parent}" restricted="true"><upnp:class>${cls}</upnp:class><dc:title>${xmlEsc(title)}</dc:title>${art ? `<upnp:albumArtURI>${art}</upnp:albumArtURI>` : ''}${artist ? `<upnp:artist>${xmlEsc(artist)}</upnp:artist>` : ''}${date ? `<dc:date>${date}</dc:date>` : ''}</container>`

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => resolve(body))
  })

/** All mutable demo state, built for one concrete loopback host. */
function buildDemo(host: string): {
  handleHttp: (req: IncomingMessage, res: ServerResponse) => void
  attachWs: (wss: WebSocketServer) => void
} {
  const art = (hue: number): string => `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
  <defs><radialGradient id="g" cx="30%" cy="30%"><stop offset="0%" stop-color="hsl(${hue} 90% 65%)"/>
  <stop offset="60%" stop-color="hsl(${(hue + 40) % 360} 70% 45%)"/><stop offset="100%" stop-color="hsl(${(hue + 80) % 360} 60% 18%)"/></radialGradient></defs>
  <rect width="600" height="600" fill="url(#g)"/>
  <circle cx="420" cy="180" r="140" fill="hsl(${hue} 90% 70%)" opacity="0.7"/>
  <circle cx="150" cy="450" r="180" fill="hsl(${(hue + 80) % 360} 70% 35%)" opacity="0.6"/></svg>`

  const ARTS: Record<string, string> = {}
  for (let i = 1; i <= 30; i++) ARTS[`/art/q${i}.svg`] = art((i * 47) % 360)
  for (let i = 1; i <= 24; i++) ARTS[`/art/p${i}.svg`] = art((i * 61 + 20) % 360)
  const artUrl = (n: number): string => `${host}/art/q${n}.svg`

  const trackMeta = (n: number): Dict => ({
    class: 'stream.media.upnp',
    source: 'MEDIA_PLAYER',
    name: null,
    title: `Demo Track ${n}`,
    art_url: artUrl(n),
    track_number: n,
    duration: 180 + n * 7,
    genre: 'Electronic',
    album: 'Amber Nights',
    artist: 'The Amber Collective'
  })

  const DATA: Record<string, Dict> = {
    '/system/info': {
      name: 'Demo streamer',
      timezone: 'Europe/London',
      locale: 'en_GB',
      usage_reports: false,
      setup: true,
      sources_setup: true,
      versions: [{ component: 'SMOIP', version: '1.8' }],
      udn: 'demo-udn-1',
      hcv: 1,
      model: 'Demo',
      unit_id: 'DEMO1',
      max_http_body_size: 65536,
      api: '1.8'
    },
    '/system/power': { power: 'ON' },
    '/system/sources': {
      sources: [
        { id: 'MEDIA_PLAYER', name: 'Media Player', default_name: 'Media Player', class: 'stream.media', nameable: false, ui_selectable: true, description: '', description_locale: '', preferred_order: 1 },
        { id: 'IR', name: 'Internet Radio', default_name: 'Internet Radio', class: 'stream.radio', nameable: false, ui_selectable: true, description: '', description_locale: '', preferred_order: 2 },
        { id: 'USB_AUDIO', name: 'USB Audio', default_name: 'USB Audio', class: 'digital.usb', nameable: true, ui_selectable: true, description: '', description_locale: '', preferred_order: 3 },
        { id: 'BLUETOOTH', name: 'Bluetooth', default_name: 'Bluetooth', class: 'digital.bluetooth', nameable: true, ui_selectable: true, description: '', description_locale: '', preferred_order: 4 },
        { id: 'AIRPLAY', name: 'AirPlay', default_name: 'AirPlay', class: 'stream.airplay', nameable: false, ui_selectable: false, description: '', description_locale: '', preferred_order: 5 }
      ]
    },
    '/zone/state': {
      source: 'MEDIA_PLAYER',
      power: true,
      pre_amp_mode: true,
      pre_amp_state: 'on',
      mute: false,
      volume_step: 15,
      volume_percent: 42,
      volume_db: null,
      cbus: null
    },
    '/zone/play_state': {
      state: 'play',
      position: 73,
      presettable: true,
      queue_index: PLAYING_QUEUE_ID - 1,
      queue_length: QUEUE_LEN,
      queue_id: PLAYING_QUEUE_ID,
      mode_repeat: 'off',
      mode_shuffle: 'off',
      metadata: {
        ...trackMeta(PLAYING_QUEUE_ID),
        playback_source: 'punnet',
        sample_format: '44.1kHz/16bit',
        mqa: 'none',
        codec: 'FLAC',
        lossless: true,
        sample_rate: 44100,
        bit_depth: 16,
        encoding: null,
        station: null,
        bitrate: null,
        radio_id: null
      }
    },
    '/zone/play_state/position': { position: 73 },
    '/zone/now_playing': {
      state: 'play',
      source: { id: 'MEDIA_PLAYER', name: 'Media Player' },
      display: {
        line1: `Demo Track ${PLAYING_QUEUE_ID}`,
        line2: 'The Amber Collective',
        line3: 'Amber Nights',
        format: '44.1kHz/16bit FLAC',
        mqa: 'none',
        playback_source: 'punnet',
        class: 'stream.media.upnp',
        art_url: artUrl(PLAYING_QUEUE_ID),
        art_file: null,
        progress: { position: 73, duration: 180 + PLAYING_QUEUE_ID * 7 },
        context: null
      },
      queue: { length: QUEUE_LEN, position: PLAYING_QUEUE_ID - 1, shuffle: 'off', repeat: 'off' },
      controls: ['play_pause', 'track_next', 'track_previous', 'seek', 'toggle_shuffle', 'toggle_repeat']
    },
    '/queue/list': {
      start: 0,
      count: QUEUE_LEN,
      total: QUEUE_LEN,
      play_postition: PLAYING_QUEUE_ID - 1,
      play_id: PLAYING_QUEUE_ID,
      items: Array.from({ length: QUEUE_LEN }, (_, i) => ({ id: i + 1, position: i, metadata: trackMeta(i + 1) }))
    },
    '/presets/list': {
      start: 1,
      end: 24,
      max_presets: 99,
      presettable: true,
      // preset 1 art-matches the playing track -> shows as playing
      presets: Array.from({ length: 24 }, (_, i) => ({
        id: i + 1,
        name: i === 0 ? 'Amber Nights' : `Demo Preset ${i + 1}`,
        type: 'MEDIA',
        class: 'stream.media.upnp',
        state: 'OK',
        is_playing: false, // real firmware never holds this true (verified live)
        art_url: i === 0 ? artUrl(PLAYING_QUEUE_ID) : `${host}/art/p${i + 1}.svg`,
        airable_radio_id: null
      }))
    }
  }

  // ---- media library: ContentDirectory + /smoip/queue/add (Library screen) --

  type Album = {
    id: string
    title: string
    artist: string
    date: string
    art: string | null
    count: number
    track: (n: number) => Dict
  }

  const LIB_ALBUMS: Album[] = [
    {
      id: 'alb-1',
      title: 'Amber Nights',
      artist: 'The Amber Collective',
      date: '2011-03-14',
      art: `${host}/art/p1.svg`,
      count: 8,
      track: (n) => ({ ...trackMeta(n) })
    },
    {
      id: 'alb-2',
      title: 'Neon Evenings',
      artist: 'The Neon Collective',
      date: '2014-06-01',
      art: `${host}/art/p2.svg`,
      count: 5,
      track: (n) => ({
        ...trackMeta(n),
        title: `Neon Track ${n}`,
        album: 'Neon Evenings',
        artist: 'The Neon Collective',
        art_url: `${host}/art/p2.svg`,
        duration: 120 + n * 11
      })
    }
  ]

  const SYN_ALBUMS: Album[] = Array.from({ length: 35 }, (_, i) => ({
    id: `syn-${i + 1}`,
    title: `Synth Album ${i + 1}`,
    artist: 'Demo Artist 2',
    date: `${1980 + i}-01-01`,
    art: null,
    count: 2,
    track: (n: number) => ({
      ...trackMeta(n),
      title: `Synth ${i + 1}.${n}`,
      album: `Synth Album ${i + 1}`,
      artist: 'Demo Artist 2',
      art_url: null,
      duration: 90 + n
    })
  }))
  const albumById = (id: string): Album | undefined =>
    LIB_ALBUMS.find((a) => a.id === id) ?? SYN_ALBUMS.find((a) => a.id === id)

  const didlTrack = (alb: Album, n: number): string => {
    const md = alb.track(n)
    return `<item id="${alb.id}-t${n}" parentID="${alb.id}" restricted="true"><dc:title>${xmlEsc(String(md.title))}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><upnp:artist>${xmlEsc(String(md.artist))}</upnp:artist><upnp:album>${xmlEsc(String(md.album))}</upnp:album><upnp:originalTrackNumber>${n}</upnp:originalTrackNumber><upnp:albumArtURI>${md.art_url}</upnp:albumArtURI><res duration="${durFmt(Number(md.duration))}" protocolInfo="*:*:*:*">file:///tmp/usm/1/${alb.id}/${n}.flac</res></item>`
  }

  const ARTIST_COUNT = 400
  const artistName = (n: number): string => (n % 7 === 0 ? `Artist & Friends ${n}` : `Demo Artist ${n}`)

  const didlLooseTrack = (id: string, parent: string, title: string, artist: string, artU: string): string =>
    `<item id="${id}" parentID="${parent}" restricted="true"><dc:title>${xmlEsc(title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><upnp:artist>${xmlEsc(artist)}</upnp:artist><upnp:albumArtURI>${artU}</upnp:albumArtURI><res duration="0:03:00.000" protocolInfo="*:*:*:*">file:///tmp/usm/1/singles/${id}.flac</res></item>`
  const SINGLES: Array<[string, string, string]> = [
    ['sng-1', 'Zeta Song', 'The Amber Collective'],
    ['sng-2', 'Alpha Song', 'The Neon Collective'],
    ['sng-3', 'Middle Song', 'The Amber Collective']
  ]

  function cdChildren(id: string): string[] | null {
    if (id === '0')
      return [
        didlContainer('lib-music', '0', 'Music', 'object.container', null),
        didlContainer('lib-artists', '0', 'Artists', 'object.container', null),
        didlContainer('lib-singles', '0', 'Singles', 'object.container', null),
        didlContainer('lib-attic', '0', 'Attic', 'object.container', null)
      ]
    if (id === 'lib-attic')
      return [
        didlContainer('attic-boot', 'lib-attic', '[Bootlegs]', 'object.container', null),
        didlContainer('attic-live', 'lib-attic', 'Live Tapes', 'object.container', null)
      ]
    if (id === 'attic-boot' || id === 'attic-live')
      return SINGLES.map(([sid, title, artist], i) =>
        didlLooseTrack(`${id}-${sid}`, id, title, artist, `${host}/art/p${i + 11}.svg`)
      )
    if (id === 'lib-singles')
      return SINGLES.map(([sid, title, artist], i) =>
        didlLooseTrack(sid, 'lib-singles', title, artist, `${host}/art/p${i + 11}.svg`)
      )
    if (id === 'lib-artists')
      return [
        didlContainer('art-all', 'lib-artists', '[All Artists]', 'object.container.person', `${host}/art/p9.svg`),
        ...Array.from({ length: ARTIST_COUNT }, (_, i) =>
          didlContainer(
            `art-${i + 1}`,
            'lib-artists',
            artistName(i + 1),
            'object.container.person.musicArtist',
            i < 8 ? `${host}/art/p${(i % 24) + 1}.svg` : null
          )
        )
      ]
    if (id === 'lib-music')
      return [
        ...LIB_ALBUMS.map((a) =>
          didlContainer(a.id, 'lib-music', a.title, 'object.container.album.musicAlbum', a.art, a.artist, a.date)
        ),
        didlTrack(LIB_ALBUMS[0], 1)
      ]
    const artMatch = id.match(/^art-(\d+)$/)
    if (artMatch) {
      const albums = artMatch[1] === '2' ? SYN_ALBUMS : LIB_ALBUMS
      return [
        didlContainer(`${id}-alltracks`, id, ' [All Tracks]', 'object.container', null),
        didlContainer(`${id}-shuffle`, id, ' [Shuffle Tracks]', 'object.container', null),
        ...albums.map((a) =>
          didlContainer(a.id, id, a.title, 'object.container.album.musicAlbum', a.art, a.artist, a.date)
        )
      ]
    }
    if (/^art-\d+-(alltracks|shuffle)$/.test(id))
      return LIB_ALBUMS.flatMap((a) => Array.from({ length: a.count }, (_, i) => didlTrack(a, i + 1)))
    const alb = albumById(id)
    if (alb) return Array.from({ length: alb.count }, (_, i) => didlTrack(alb, i + 1))
    return null
  }
  function cdMetadata(id: string): string | null {
    if (id === 'lib-music') return didlContainer('lib-music', '0', 'Music', 'object.container', null)
    if (id === 'lib-singles') return didlContainer('lib-singles', '0', 'Singles', 'object.container', null)
    const alb = albumById(id)
    if (alb)
      return didlContainer(alb.id, 'lib-music', alb.title, 'object.container.album.musicAlbum', alb.art, alb.artist, alb.date)
    const m = id.match(/^((?:alb|syn)-\d+)-t(\d+)$/)
    if (m) {
      const a = albumById(m[1])
      if (a) return didlTrack(a, Number(m[2]))
    }
    const sng = SINGLES.findIndex(([sid]) => sid === id)
    if (sng >= 0)
      return didlLooseTrack(id, 'lib-singles', SINGLES[sng][1], SINGLES[sng][2], `${host}/art/p${sng + 11}.svg`)
    return null
  }

  // ---------------------------------------------------------------- WS side

  let wssRef: WebSocketServer | null = null
  const broadcast = (path: string): void => {
    if (!wssRef) return
    const msg = JSON.stringify({ path, params: { data: DATA[path] } })
    for (const c of wssRef.clients) if (c.readyState === 1) c.send(msg)
  }

  let nextQueueId = 1000

  const queueList = (): { items: QueueItem[]; play_id: number | null; play_postition: number | null } =>
    DATA['/queue/list'] as { items: QueueItem[]; play_id: number | null; play_postition: number | null }

  function setQueue(items: QueueItem[], playItem: QueueItem | null): void {
    items.forEach((it, i) => {
      it.position = i
    })
    const playIdx = playItem ? items.indexOf(playItem) : -1
    const cur = queueList()
    DATA['/queue/list'] = {
      start: 0,
      count: items.length,
      total: items.length,
      play_postition: playIdx >= 0 ? playIdx : (cur.play_postition ?? null),
      play_id: playItem ? playItem.id : items.some((i) => i.id === cur.play_id) ? cur.play_id : null,
      items
    }
    if (playItem) {
      const md = playItem.metadata
      const ps = DATA['/zone/play_state'] as Dict
      DATA['/zone/play_state'] = {
        ...ps,
        state: 'play',
        position: 0,
        queue_index: playIdx,
        queue_length: items.length,
        queue_id: playItem.id,
        // radio keys must NOT survive a queue takeover — real firmware
        // rebuilds metadata per track (library tracks carry no station)
        metadata: { ...(ps.metadata as Dict), station: null, radio_id: null, ...md }
      }
      const np = DATA['/zone/now_playing'] as Dict
      DATA['/zone/now_playing'] = {
        ...np,
        display: {
          ...(np.display as Dict),
          line1: md.title,
          line2: md.artist,
          line3: md.album,
          art_url: md.art_url,
          progress: { position: 0, duration: md.duration }
        },
        queue: { ...(np.queue as Dict), length: items.length, position: playIdx }
      }
      broadcast('/zone/play_state')
      broadcast('/zone/now_playing')
    }
    broadcast('/queue/list')
  }

  function queueItemsFor(targetId: string | null): QueueItem[] | null {
    const trackMatch = targetId?.match(/^((?:alb|syn)-\d+)-t(\d+)$/)
    if (trackMatch) {
      const a = albumById(trackMatch[1])
      if (!a) return null
      return [
        {
          id: nextQueueId++,
          position: 0,
          srcId: targetId ?? undefined,
          metadata: { ...a.track(Number(trackMatch[2])), playback_source: 'punnet' }
        }
      ]
    }
    const alb = targetId ? albumById(targetId) : undefined
    if (alb)
      return Array.from({ length: alb.count }, (_, i) => ({
        id: nextQueueId++,
        position: 0,
        srcId: `${alb.id}-t${i + 1}`,
        metadata: { ...alb.track(i + 1), playback_source: 'punnet' }
      }))
    if (targetId === 'lib-singles')
      return SINGLES.map(([sid, title, artist], i) => ({
        id: nextQueueId++,
        position: 0,
        srcId: sid,
        metadata: {
          title,
          artist,
          album: null,
          art_url: `${host}/art/p${i + 11}.svg`,
          duration: 180,
          playback_source: 'punnet'
        }
      }))
    const sng = SINGLES.findIndex(([sid]) => sid === targetId)
    if (sng >= 0) return (queueItemsFor('lib-singles') ?? []).slice(sng, sng + 1)
    return null
  }

  function handleQueueAdd(params: Dict, res: ServerResponse): void {
    const didl = String(params.didl ?? '')
    const idMatch = didl.match(/ id="([^"]+)"/)
    const targetId = idMatch ? idMatch[1] : null
    const newItems = queueItemsFor(targetId)
    if (!newItems) {
      res.writeHead(400)
      res.end('{"error":"unknown didl target"}')
      return
    }

    const cur = queueList().items ?? []
    const curPlayIdx = cur.findIndex((i) => i.id === queueList().play_id)
    const action = params.action

    if (action === 'REPLACE') setQueue(newItems, null)
    else if (action === 'APPEND') setQueue([...cur, ...newItems], null)
    else if (action === 'PLAY_NEXT') {
      const at = curPlayIdx >= 0 ? curPlayIdx + 1 : cur.length
      setQueue([...cur.slice(0, at), ...newItems, ...cur.slice(at)], null)
    } else if (action === 'PLAY_NOW') {
      const at = curPlayIdx >= 0 ? curPlayIdx + 1 : cur.length
      setQueue([...cur.slice(0, at), ...newItems, ...cur.slice(at)], newItems[0])
    } else if (action === 'PLAY_FROM_HERE') {
      const playItem = newItems.find((i) => i.srcId === params.play_from_id) ?? newItems[0]
      setQueue(newItems, playItem)
    } else {
      res.writeHead(400)
      res.end('{"error":"unknown action"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  }

  function handlePresetSave(body: Dict, res: ServerResponse): void {
    const didl = String(body.didl ?? '')
    const title = didl.match(/<dc:title>(.*?)<\/dc:title>/)?.[1] ?? 'Preset'
    const artU = didl.match(/<upnp:albumArtURI>(.*?)<\/upnp:albumArtURI>/)?.[1] ?? null
    const list = DATA['/presets/list'] as { presets: Array<Dict & { id: number }> }
    const presets = list.presets.filter((p) => p.id !== body.preset)
    presets.push({
      id: Number(body.preset),
      name: title,
      type: 'MEDIA',
      class: 'stream.media.upnp',
      state: 'OK',
      is_playing: false,
      art_url: artU,
      airable_radio_id: null
    })
    presets.sort((a, b) => a.id - b.id)
    DATA['/presets/list'] = { ...list, presets }
    broadcast('/presets/list')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  }

  const DESCRIPTION_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Demo library</friendlyName>
    <manufacturer>TastyTunes</manufacturer>
    <UDN>uuid:demo-udn-1</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <controlURL>/upnp/control</controlURL>
        <eventSubURL>/upnp/event</eventSubURL>
        <SCPDURL>/upnp/scpd.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const u = new URL(req.url ?? '/', host)

      if (u.pathname === '/description.xml') {
        res.writeHead(200, { 'content-type': 'text/xml' })
        return res.end(DESCRIPTION_XML)
      }
      if (u.pathname === '/smoip/system/upnp') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(
          JSON.stringify({
            data: {
              devices: [
                {
                  model: 'Demo',
                  name: 'Demo library',
                  manufacturer: 'TastyTunes',
                  udn: 'demo-udn-1',
                  description_url: `${host}/description.xml`
                }
              ]
            }
          })
        )
      }
      if (u.pathname === '/upnp/control' && req.method === 'POST') {
        const body = await readBody(req)
        const soap = (inner: string): void => {
          res.writeHead(200, { 'content-type': 'text/xml' })
          res.end(
            `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`
          )
        }
        if (body.includes('GetSearchCapabilities'))
          return soap(
            '<u:GetSearchCapabilitiesResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><SearchCaps>*</SearchCaps></u:GetSearchCapabilitiesResponse>'
          )
        if (body.includes('GetSortCapabilities'))
          return soap(
            '<u:GetSortCapabilitiesResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><SortCaps></SortCaps></u:GetSortCapabilitiesResponse>'
          )
        if (body.includes('<u:Search')) {
          // scope-aware like Asset: results only for the class in `derivedfrom`,
          // and only on the fields the criteria actually reference
          const q = (body.match(/contains &quot;(.*?)&quot;/)?.[1] ?? '').toLowerCase()
          const scope = body.match(/derivedfrom &quot;(.*?)&quot;/)?.[1] ?? ''
          const useArtist = body.includes('upnp:artist contains')
          const useAlbum = body.includes('upnp:album contains')
          const parts: string[] = []
          if (scope.includes('container.album')) {
            for (const a of LIB_ALBUMS)
              if (a.title.toLowerCase().includes(q) || (useArtist && a.artist.toLowerCase().includes(q)))
                parts.push(didlContainer(a.id, 'lib-music', a.title, 'object.container.album', a.art, a.artist, a.date))
          } else if (scope.includes('item.audioItem')) {
            for (const a of LIB_ALBUMS)
              for (let n = 1; n <= a.count; n++) {
                const md = a.track(n)
                if (
                  String(md.title).toLowerCase().includes(q) ||
                  (useArtist && String(md.artist).toLowerCase().includes(q)) ||
                  (useAlbum && String(md.album).toLowerCase().includes(q))
                )
                  parts.push(didlTrack(a, n))
              }
            for (const [sid, title, artist] of SINGLES)
              if (title.toLowerCase().includes(q) || (useArtist && artist.toLowerCase().includes(q)))
                parts.push(didlLooseTrack(sid, 'lib-singles', title, artist, `${host}/art/p11.svg`))
          } else if (scope.includes('container.person')) {
            for (let i = 1; i <= ARTIST_COUNT; i++) {
              const name = artistName(i)
              if (name.toLowerCase().includes(q))
                parts.push(
                  didlContainer(
                    `art-${i}`,
                    'lib-artists',
                    name,
                    'object.container.person',
                    i <= 8 ? `${host}/art/p${(i % 24) + 1}.svg` : null
                  )
                )
            }
          }
          return soap(
            `<u:SearchResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Result>${xmlEsc(didlWrap(parts.join('')))}</Result><NumberReturned>${parts.length}</NumberReturned><TotalMatches>${parts.length}</TotalMatches><UpdateID>1</UpdateID></u:SearchResponse>`
          )
        }
        const objectId = body.match(/<ObjectID>(.*?)<\/ObjectID>/)?.[1] ?? '0'
        const flag = body.match(/<BrowseFlag>(.*?)<\/BrowseFlag>/)?.[1] ?? 'BrowseDirectChildren'
        const start = Number(body.match(/<StartingIndex>(\d+)<\/StartingIndex>/)?.[1] ?? 0)
        const meta = cdMetadata(objectId)
        const all = flag === 'BrowseMetadata' ? (meta ? [meta] : null) : cdChildren(objectId)
        if (!all) {
          res.writeHead(500)
          return res.end('no such object')
        }
        // cap each response like real servers do — the app must page
        const parts = all.slice(start, start + 150)
        const result = didlWrap(parts.join(''))
        res.writeHead(200, { 'content-type': 'text/xml' })
        return res.end(
          `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Result>${xmlEsc(result)}</Result><NumberReturned>${parts.length}</NumberReturned><TotalMatches>${all.length}</TotalMatches><UpdateID>1</UpdateID></u:BrowseResponse></s:Body></s:Envelope>`
        )
      }
      // Rename a preset in place (mirrors the real Evo's GET verb).
      if (u.pathname === '/smoip/presets/rename') {
        const slot = Number(u.searchParams.get('preset'))
        const name = rawParam(u, 'name') ?? ''
        const list = DATA['/presets/list'] as { presets: Array<Dict & { id: number }> }
        const p = list.presets.find((x) => x.id === slot)
        if (p && name) {
          p.name = name
          broadcast('/presets/list')
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"zone": "ZONE1"}')
      }
      // Play an internet-radio stream by URL (mirrors the real Evo's GET
      // verb: url+name both required, AND an explicit zone — firmware 400s
      // without it).
      if (u.pathname === '/smoip/stream/radio') {
        if (!u.searchParams.get('zone')) {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end('{"code": 113, "message": "\'zone/preset\' value missing"}')
        }
        const url = rawParam(u, 'url')
        const name = rawParam(u, 'name')
        if (!url || !name) {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end('{"error":"missing params"}')
        }
        // Real firmware answers instantly and pushes the new state only once
        // the stream connects — keep that beat so the demo's "tuning in" UX
        // matches the hardware feel.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"zone": "ZONE1"}')
        await new Promise((r) => setTimeout(r, 900))
        DATA['/zone/state'] = { ...DATA['/zone/state'], source: 'IR' }
        DATA['/zone/play_state'] = {
          state: 'play',
          position: 0,
          presettable: true,
          queue_index: null,
          queue_length: null,
          queue_id: null,
          mode_repeat: 'off',
          mode_shuffle: 'off',
          metadata: {
            // real firmware reports class "md.radio" for raw-URL streams
            class: 'md.radio',
            source: 'IR',
            name: 'Internet Radio',
            station: name,
            title: null,
            art_url: null,
            duration: null,
            codec: 'AAC',
            bitrate: 128000,
            lossless: false,
            sample_rate: 44100,
            bit_depth: null,
            mqa: 'none',
            sample_format: null,
            encoding: null,
            radio_id: null,
            album: null,
            artist: null,
            genre: null,
            track_number: null
          }
        }
        DATA['/zone/now_playing'] = {
          ...DATA['/zone/now_playing'],
          source: { id: 'IR', name: 'Internet Radio' },
          display: {
            line1: name,
            line2: null,
            line3: null,
            art_url: null,
            art_file: null,
            class: 'stream.radio',
            format: 'AAC',
            mqa: 'none',
            playback_source: 'radio',
            progress: null,
            context: null
          },
          controls: ['play_pause']
        }
        broadcast('/zone/state')
        broadcast('/zone/play_state')
        broadcast('/zone/now_playing')
        return
      }
      // Save the CURRENT playback to a preset slot (mirrors the real Evo's
      // GET verb; called bare it defaults to the next free slot).
      if (u.pathname === '/smoip/zone/save_preset') {
        const meta = (DATA['/zone/play_state'].metadata ?? {}) as Dict
        const list = DATA['/presets/list'] as { presets: Array<Dict & { id: number }> }
        const used = new Set(list.presets.map((p) => p.id))
        let slot = Number(u.searchParams.get('preset'))
        if (!slot) {
          slot = 1
          while (used.has(slot)) slot++
        }
        const isRadio = /radio/.test(String(meta.class ?? ''))
        const name =
          ((isRadio ? meta.station || meta.name : meta.title) as string | null) || `Preset ${slot}`
        const presets = list.presets.filter((p) => p.id !== slot)
        presets.push({
          id: slot,
          name,
          type: isRadio ? 'Stream' : 'UPnP',
          class: isRadio ? 'stream.radio' : 'stream.media.upnp',
          state: 'OK',
          is_playing: false,
          art_url: (meta.art_url as string | null) ?? null,
          airable_radio_id: (meta.radio_id as string | null) ?? null
        })
        presets.sort((a, b) => a.id - b.id)
        DATA['/presets/list'] = { ...list, presets }
        broadcast('/presets/list')
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"zone": "ZONE1"}')
      }
      // Snapshot the current queue as a MediaQueue preset (mirrors the real
      // Evo's GET verb; art_urls = one per distinct album in the queue).
      if (u.pathname === '/smoip/queue/save_preset') {
        const list = DATA['/presets/list'] as { presets: Array<Dict & { id: number }> }
        const used = new Set(list.presets.map((p) => p.id))
        let slot = Number(u.searchParams.get('preset'))
        if (!slot) {
          slot = 1
          while (used.has(slot)) slot++
        }
        const name = rawParam(u, 'name') || `Queue Preset ${slot}`
        const arts = [
          ...new Set(
            (queueList().items ?? []).map((i) => i.metadata.art_url as string | null).filter(Boolean)
          )
        ].slice(0, 4) as string[]
        const presets = list.presets.filter((p) => p.id !== slot)
        presets.push({
          id: slot,
          name,
          type: 'MediaQueue',
          class: 'stream.media',
          state: 'OK',
          is_playing: false,
          art_url: arts[0] ?? null,
          art_urls: arts,
          airable_radio_id: null
        })
        presets.sort((a, b) => a.id - b.id)
        DATA['/presets/list'] = { ...list, presets }
        broadcast('/presets/list')
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"zone": "ZONE1"}')
      }
      if (u.pathname === '/smoip/queue/add') {
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}') as Dict
          if (body.action === 'PRESET') return handlePresetSave(body, res)
          return handleQueueAdd(body, res)
        }
        return handleQueueAdd(Object.fromEntries(u.searchParams), res)
      }

      const svg = ARTS[u.pathname]
      if (svg) {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' })
        res.end(svg)
      } else {
        res.writeHead(404)
        res.end()
      }
    })()
  }

  // Move the playing track by ±1 and push updated state, so Next/Prev (and
  // "end of track" sleep timers) work in the demo. Queue mode only.
  function advanceTrack(delta: number, push: (path: string) => void): void {
    const ps = DATA['/zone/play_state'] as Dict
    const cur = (ps.queue_id as number | null) ?? PLAYING_QUEUE_ID
    const next = Math.min(QUEUE_LEN, Math.max(1, cur + (delta > 0 ? 1 : -1)))
    if (next === cur) return
    const md = trackMeta(next)
    DATA['/zone/play_state'] = {
      ...ps,
      position: 0,
      queue_index: next - 1,
      queue_id: next,
      metadata: { ...(ps.metadata as Dict), ...md, playback_source: 'punnet' }
    }
    DATA['/zone/play_state/position'] = { position: 0 }
    const np = DATA['/zone/now_playing'] as Dict
    DATA['/zone/now_playing'] = {
      ...np,
      display: {
        ...(np.display as Dict),
        line1: md.title,
        art_url: md.art_url,
        progress: { position: 0, duration: md.duration }
      },
      queue: { ...(np.queue as Dict), position: next - 1 }
    }
    DATA['/queue/list'] = { ...DATA['/queue/list'], play_postition: next - 1, play_id: next }
    push('/zone/play_state')
    push('/zone/play_state/position')
    push('/zone/now_playing')
  }

  function attachWs(wss: WebSocketServer): void {
    wssRef = wss
    wss.on('connection', (ws) => {
      const push = (path: string): void => ws.send(JSON.stringify({ path, params: { data: DATA[path] } }))
      ws.on('message', (raw) => {
        let frame: { path?: string; params?: Dict }
        try {
          frame = JSON.parse(String(raw)) as { path?: string; params?: Dict }
        } catch {
          return
        }
        const params = frame.params ?? {}
        if (params.update === 1 && frame.path && DATA[frame.path]) push(frame.path)
        else if (frame.path === '/queue/list') push('/queue/list')
        else if (frame.path === '/presets/list') push('/presets/list')
        else if (frame.path === '/zone/recall_preset' && typeof params.preset === 'number') {
          // Apply the recall like real firmware — after a beat (source switch
          // + stream/queue load), so the Presets tuning state shows in demo
          // exactly like on hardware.
          const list = DATA['/presets/list'] as { presets: Array<Dict & { id: number }> }
          const preset = list.presets.find((p) => p.id === params.preset)
          if (preset) {
            setTimeout(() => {
              if (/radio/.test(String(preset.class ?? ''))) {
                DATA['/zone/state'] = { ...DATA['/zone/state'], source: 'IR' }
                DATA['/zone/play_state'] = {
                  state: 'play',
                  position: 0,
                  presettable: true,
                  queue_index: null,
                  queue_length: null,
                  queue_id: null,
                  mode_repeat: 'off',
                  mode_shuffle: 'off',
                  metadata: {
                    class: 'md.radio',
                    source: 'IR',
                    name: 'Internet Radio',
                    station: preset.name,
                    title: null,
                    art_url: (preset.art_url as string | null) ?? null,
                    duration: null,
                    codec: 'AAC',
                    bitrate: 128000,
                    lossless: false,
                    sample_rate: 44100,
                    bit_depth: null,
                    mqa: 'none',
                    sample_format: null,
                    encoding: null,
                    radio_id: (preset.airable_radio_id as number | null) ?? null,
                    album: null,
                    artist: null,
                    genre: null,
                    track_number: null
                  }
                }
                DATA['/zone/now_playing'] = {
                  ...DATA['/zone/now_playing'],
                  source: { id: 'IR', name: 'Internet Radio' },
                  display: {
                    line1: preset.name,
                    line2: null,
                    line3: null,
                    art_url: (preset.art_url as string | null) ?? null,
                    art_file: null,
                    class: 'md.radio',
                    format: 'AAC',
                    mqa: 'none',
                    playback_source: 'radio',
                    progress: null,
                    context: null
                  },
                  controls: ['play_pause']
                }
                push('/zone/state')
                push('/zone/play_state')
                push('/zone/now_playing')
              } else {
                // synthetic queue whose album/art match the preset, so the
                // playing lamp's content check recognizes the recall
                const items: QueueItem[] = Array.from({ length: 8 }, (_, i) => ({
                  id: nextQueueId++,
                  position: i,
                  metadata: {
                    title: `${preset.name} — Track ${i + 1}`,
                    artist: 'The Demo Artists',
                    album: preset.name,
                    art_url: (preset.art_url as string | null) ?? null,
                    duration: 200 + i * 7,
                    playback_source: 'punnet'
                  }
                }))
                DATA['/zone/state'] = { ...DATA['/zone/state'], source: 'MEDIA_PLAYER' }
                setQueue(items, items[0])
                push('/zone/state')
              }
            }, 900)
          }
        } else if (frame.path === '/zone/play_control' && typeof params.skip_track === 'number') {
          advanceTrack(params.skip_track, push)
        } else if (frame.path === '/zone/state' && typeof params.volume_percent === 'number') {
          // echo volume like a real device (async push back)
          DATA['/zone/state'] = { ...DATA['/zone/state'], volume_percent: params.volume_percent }
          setTimeout(() => push('/zone/state'), 120)
        } else if (frame.path === '/zone/play_control' && typeof params.queue_id === 'number') {
          // play a specific queue entry (Library click-jump, queue-row click)
          const items = queueList().items ?? []
          const item = items.find((i) => i.id === params.queue_id)
          if (item) setQueue(items, item)
        } else if (frame.path === '/zone/play_control' && typeof params.position === 'number') {
          // echo seek: report the new playhead shortly after
          DATA['/zone/play_state'] = { ...DATA['/zone/play_state'], position: params.position }
          DATA['/zone/play_state/position'] = { position: params.position }
          setTimeout(() => push('/zone/play_state/position'), 250)
        } else if (frame.path === '/zone/play_control' && typeof params.mode_shuffle === 'string') {
          DATA['/zone/play_state'] = { ...DATA['/zone/play_state'], mode_shuffle: params.mode_shuffle }
          setTimeout(() => push('/zone/play_state'), 120)
        } else if (frame.path === '/zone/play_control' && typeof params.action === 'string') {
          // echo transport state: play / pause / stop / toggle
          const state = (DATA['/zone/play_state'] as Dict).state
          const next = params.action === 'toggle' ? (state === 'play' ? 'pause' : 'play') : params.action
          DATA['/zone/play_state'] = { ...DATA['/zone/play_state'], state: next }
          setTimeout(() => push('/zone/play_state'), 120)
        } else if (frame.path === '/system/power' && typeof params.power === 'string') {
          // echo power: ON / NETWORK / toggle
          const powered = (DATA['/system/power'] as Dict).power === 'ON'
          const next = params.power === 'toggle' ? (powered ? 'NETWORK' : 'ON') : params.power
          DATA['/system/power'] = { power: next }
          setTimeout(() => push('/system/power'), 120)
        }
      })
    })
  }

  return { handleHttp, attachWs }
}

// ------------------------------------------------------------------ lifecycle

let running: { server: Server; wss: WebSocketServer; host: string } | null = null

/** Start (or reuse) the demo device; resolves to its "127.0.0.1:port" host. */
export async function startDemoStreamer(): Promise<string> {
  if (running) return running.host
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const host = `127.0.0.1:${port}`
  const demo = buildDemo(`http://${host}`)
  server.on('request', demo.handleHttp)
  const wss = new WebSocketServer({ server, path: '/smoip' })
  demo.attachWs(wss)
  running = { server, wss, host }
  return host
}

export function stopDemoStreamer(): void {
  if (!running) return
  for (const c of running.wss.clients) c.terminate()
  running.wss.close()
  running.server.close()
  running = null
}

/** The demo device's host while it runs, else null. */
export function demoHost(): string | null {
  return running?.host ?? null
}
