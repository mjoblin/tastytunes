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
  date?: string,
  genres?: string[]
): string =>
  `<container id="${id}" parentID="${parent}" restricted="true"><upnp:class>${cls}</upnp:class><dc:title>${xmlEsc(title)}</dc:title>${art ? `<upnp:albumArtURI>${art}</upnp:albumArtURI>` : ''}${artist ? `<upnp:artist>${xmlEsc(artist)}</upnp:artist>` : ''}${date ? `<dc:date>${date}</dc:date>` : ''}${(genres ?? []).map((g) => `<upnp:genre>${xmlEsc(g)}</upnp:genre>`).join('')}</container>`

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
    '/system/power': { power: 'ON', standby_mode: 'NETWORK', auto_power_down: 3600 },
    '/system/display': { brightness: 'dim' },
    // Firmware self-check status the streamer pushes to subscribers. The demo is
    // always up-to-date (no update shown). Read-only, like the mock — the app
    // never sends action=CHECK/UPDATE. (Mirror of dev/mock-streamer.mjs, minus
    // that file's MOCK_FIRMWARE_* scenario knobs — deliberate fork, keep in sync.)
    '/system/update': { early_update: false, update_available: false, updating: false },
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
    },
    // Tone/EQ chain — read shape captured live off the Evo 150 2026-07-19
    // (mirror of dev/mock-streamer.mjs minus its MOCK_NO_EQ knobs; the demo
    // always has tone controls so the section is explorable without hardware).
    '/zone/audio': {
      volume_limit_percent: 50,
      tilt_eq: { enabled: false, intensity: 0 },
      user_eq: {
        enabled: false,
        bands: [
          [80, 'LOWSHELF', 0.8], [120, 'PEAKING', 1.24], [315, 'PEAKING', 1.24],
          [800, 'PEAKING', 1.24], [2000, 'PEAKING', 1.24], [5000, 'PEAKING', 1.24],
          [8000, 'HIGHSHELF', 0.8]
        ].map(([freq, filter, q], index) => ({ index, filter, freq, gain: 0, q }))
      },
      balance: 0,
      pipeline: 'DSP'
    }
  }

  const AUDIO_SPEC: Dict = {
    volume_limit_percent: { minimum: 1, maximum: 100, readonly: false },
    pipeline: { readonly: false },
    tilt_eq: { minimum: -15, maximum: 15, readonly: false },
    user_eq: {
      bands: 7,
      filters: { enum: ['PASSTHROUGH', 'PEAKING', 'LOWSHELF', 'HIGHSHELF', 'NOTCH', 'HIGHPASS', 'LOWPASS', 'ALLPASS'] },
      readonly: false,
      always_on: false
    },
    balance: { minimum: -15, maximum: 15, readonly: false }
  }

  // ---- media library: ContentDirectory + /smoip/queue/add (Library screen) --

  type Album = {
    id: string
    title: string
    artist: string
    date: string
    art: string | null
    count: number
    genres?: string[]
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
      genres: ['Electronic'],
      track: (n) => ({ ...trackMeta(n) })
    },
    {
      id: 'alb-2',
      title: 'Neon Evenings',
      artist: 'The Neon Collective',
      date: '2014-06-01',
      art: `${host}/art/p2.svg`,
      count: 5,
      genres: ['Synthpop; Electropop'],
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

  // A SECOND media server, always present in the demo: a dedicated library box
  // beside the streamer's own storage. One library cannot show what the app
  // does with two — cross-server search fans out over every ready index, and
  // the lens badges exist to say WHICH server a pooled album came from — so
  // the demo (and every screenshot taken from it) was quietly hiding a whole
  // feature. Mirrors dev/mock-streamer.mjs's MOCK_SECOND_SERVER, which is
  // permanent here rather than env-gated.
  //
  // 'Amber Nights' EXISTS ON BOTH SERVERS on purpose: showing the same album's
  // provenance is the grouped UI's reason to exist.
  const LIB2_ALBUMS: Album[] = [
    {
      id: 'a2-amber',
      title: 'Amber Nights',
      artist: 'The Amber Collective',
      date: '2011-03-14',
      art: `${host}/art/p21.svg`,
      count: 3,
      genres: ['Electronic'],
      track: (n) => ({
        ...trackMeta(n),
        title: `Amber Track ${n}`,
        album: 'Amber Nights',
        artist: 'The Amber Collective',
        art_url: `${host}/art/p21.svg`,
        duration: 200 + n
      })
    },
    {
      id: 'a2-velvet',
      title: 'Velvet Static',
      artist: 'Static Nomads',
      date: '2019-09-09',
      art: `${host}/art/p22.svg`,
      count: 4,
      genres: ['Ambient', 'Downtempo'],
      track: (n) => ({
        ...trackMeta(n),
        title: `Velvet ${n}`,
        album: 'Velvet Static',
        artist: 'Static Nomads',
        art_url: `${host}/art/p22.svg`,
        duration: 150 + n * 7
      })
    }
  ]
  const album2ById = (id: string): Album | undefined => LIB2_ALBUMS.find((a) => a.id === id)

  function cd2Children(id: string): string[] | null {
    if (id === '0') return [didlContainer('a2-music', '0', 'Music', 'object.container', null)]
    if (id === 'a2-music')
      return LIB2_ALBUMS.map((a) =>
        didlContainer(a.id, 'a2-music', a.title, 'object.container.album.musicAlbum', a.art, a.artist, a.date, a.genres)
      )
    const alb = album2ById(id)
    if (alb) return Array.from({ length: alb.count }, (_, i) => didlTrack(alb, i + 1))
    return null
  }
  function cd2Metadata(id: string): string | null {
    if (id === 'a2-music') return didlContainer('a2-music', '0', 'Music', 'object.container', null)
    const alb = album2ById(id)
    if (alb)
      return didlContainer(alb.id, 'a2-music', alb.title, 'object.container.album.musicAlbum', alb.art, alb.artist, alb.date, alb.genres)
    const m = id.match(/^(a2-\w+)-t(\d+)$/)
    if (m) {
      const a = album2ById(m[1])
      if (a) return didlTrack(a, Number(m[2]))
    }
    return null
  }

  const SYN_GENRES = ['House', 'Techno', 'IDM', 'Trance', 'Breakbeat', 'Dub', 'Chillout', 'Garage', 'Electro', 'Acid']
  const SYN_ALBUMS: Album[] = Array.from({ length: 35 }, (_, i) => ({
    id: `syn-${i + 1}`,
    title: `Synth Album ${i + 1}`,
    artist: `Demo Artist ${(i % 30) + 1}`,
    date: `${1980 + i}-01-01`,
    art: null,
    count: 2,
    genres: [SYN_GENRES[i % 10]],
    track: (n: number) => ({
      ...trackMeta(n),
      title: `Synth ${i + 1}.${n}`,
      album: `Synth Album ${i + 1}`,
      artist: `Demo Artist ${(i % 30) + 1}`,
      art_url: null,
      duration: 90 + n
    })
  }))
  const albumById = (id: string): Album | undefined =>
    LIB_ALBUMS.find((a) => a.id === id) ?? SYN_ALBUMS.find((a) => a.id === id)

  const didlTrack = (alb: Album, n: number): string => {
    const md = alb.track(n)
    return `<item id="${alb.id}-t${n}" parentID="${alb.id}" restricted="true"><dc:title>${xmlEsc(String(md.title))}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><upnp:artist>${xmlEsc(String(md.artist))}</upnp:artist><upnp:album>${xmlEsc(String(md.album))}</upnp:album>${(alb.genres ?? []).map((g) => `<upnp:genre>${xmlEsc(g)}</upnp:genre>`).join('')}<upnp:originalTrackNumber>${n}</upnp:originalTrackNumber><upnp:albumArtURI>${md.art_url}</upnp:albumArtURI><res duration="${durFmt(Number(md.duration))}" protocolInfo="*:*:*:*">file:///tmp/usm/1/${alb.id}/${n}.flac</res></item>`
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
          didlContainer(a.id, 'lib-music', a.title, 'object.container.album.musicAlbum', a.art, a.artist, a.date, a.genres)
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
          didlContainer(a.id, id, a.title, 'object.container.album.musicAlbum', a.art, a.artist, a.date, a.genres)
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
      return didlContainer(alb.id, 'lib-music', alb.title, 'object.container.album.musicAlbum', alb.art, alb.artist, alb.date, alb.genres)
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
  /**
   * FIRMWARE TRUTH (live-probed 2026-07-23, mirrored from mock-streamer.mjs):
   * in NETWORK standby /zone/play_state reads `state: 'not_ready'` with NO
   * art_url — the streamer stops announcing the pre-standby track as playing,
   * though it retains the state and brings it back on wake. A WIRE-SHAPE
   * override, not a mutation: DATA keeps the real thing and every send point
   * passes through here.
   */
  const wireData = (path: string): unknown => {
    const power = (DATA['/system/power'] as Dict | undefined)?.power
    if (path === '/zone/play_state' && power !== 'ON') {
      const ps = DATA['/zone/play_state'] as Dict
      const { art_url: _dropped, ...metadata } = (ps.metadata ?? {}) as Dict
      return { ...ps, state: 'not_ready', metadata }
    }
    return DATA[path]
  }
  const broadcast = (path: string): void => {
    if (!wssRef) return
    const msg = JSON.stringify({ path, params: { data: wireData(path) } })
    for (const c of wssRef.clients) if (c.readyState === 1) c.send(msg)
  }

  /**
   * Apply a /zone/audio write ATOMICALLY (firmware-faithful: one bad field
   * rejects the whole frame with code 112, nothing applies; out-of-range
   * gains store verbatim). Mirror of the mock's applyAudioWrite.
   */
  function applyAudioWrite(params: Dict): boolean {
    const next = JSON.parse(JSON.stringify(DATA['/zone/audio'])) as {
      user_eq: { enabled: boolean; bands: Array<{ freq: number; filter: string; gain: number; q: number }> }
      tilt_eq: { enabled: boolean; intensity: number }
      balance: number
      volume_limit_percent: number
    }
    for (const [key, val] of Object.entries(params)) {
      if (key === 'zone' || key === 'update') continue
      if (key === 'user_eq') {
        if (typeof val !== 'boolean') return false // boolean ON WRITE
        next.user_eq.enabled = val
      } else if (key === 'user_eq_bands') {
        if (typeof val !== 'string' || val === '') return false
        for (const part of val.split('|')) {
          const [idx, freq, filter, gain, q] = part.split(',')
          const band = next.user_eq.bands[Number(idx)]
          if (idx === '' || !band) return false
          if (freq) band.freq = Number(freq)
          if (filter) band.filter = filter
          if (gain) {
            if (Number.isNaN(Number(gain))) return false
            band.gain = Number(gain)
          }
          if (q) band.q = Number(q)
        }
      } else if (key === 'tilt_eq') {
        if (typeof val !== 'boolean') return false
        next.tilt_eq.enabled = val
      } else if (key === 'tilt_intensity') {
        if (typeof val !== 'number') return false
        next.tilt_eq.intensity = val
      } else if (key === 'balance') {
        if (typeof val !== 'number') return false
        next.balance = val
      } else if (key === 'volume_limit_percent') {
        if (typeof val !== 'number') return false
        next.volume_limit_percent = val
      } else {
        return false
      }
    }
    DATA['/zone/audio'] = next as unknown as Dict
    broadcast('/zone/audio')
    return true
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
      // A queue play announces itself as a source switch to MEDIA_PLAYER —
      // firmware-faithful (mirror of dev/mock-streamer.mjs setQueue).
      if ((DATA['/zone/state'] as Dict).source !== 'MEDIA_PLAYER') {
        DATA['/zone/state'] = { ...DATA['/zone/state'], source: 'MEDIA_PLAYER' }
        DATA['/zone/now_playing'] = {
          ...DATA['/zone/now_playing'],
          source: { id: 'MEDIA_PLAYER', name: 'Media Player' }
        }
        broadcast('/zone/state')
      }
      broadcast('/zone/play_state')
      broadcast('/zone/now_playing')
    }
    broadcast('/queue/list')
  }

  function queueItemsFor(targetId: string | null): QueueItem[] | null {
    // one queue, two sources — the second server's ids resolve here too
    const t2 = targetId?.match(/^(a2-\w+)-t(\d+)$/)
    if (t2) {
      const a = album2ById(t2[1])
      if (a)
        return [
          {
            id: nextQueueId++,
            position: 0,
            srcId: targetId ?? undefined,
            metadata: { ...a.track(Number(t2[2])), playback_source: 'punnet' }
          }
        ]
    }
    const alb2 = targetId ? album2ById(targetId) : undefined
    if (alb2)
      return Array.from({ length: alb2.count }, (_, i) => ({
        id: nextQueueId++,
        position: 0,
        srcId: `${alb2.id}-t${i + 1}`,
        metadata: { ...alb2.track(i + 1), playback_source: 'punnet' }
      }))
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

  const DESCRIPTION2_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>Demo NAS</friendlyName>
    <manufacturer>TastyTunes</manufacturer>
    <UDN>uuid:demo-udn-2</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <controlURL>/upnp2/control</controlURL>
        <eventSubURL>/upnp2/event</eventSubURL>
        <SCPDURL>/upnp2/scpd.xml</SCPDURL>
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
      if (u.pathname === '/description2.xml') {
        res.writeHead(200, { 'content-type': 'text/xml' })
        return res.end(DESCRIPTION2_XML)
      }
      if (u.pathname === '/upnp2/control' && req.method === 'POST') {
        const body = await readBody(req)
        const soap2 = (inner: string): void => {
          res.writeHead(200, { 'content-type': 'text/xml' })
          res.end(
            `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`
          )
        }
        if (body.includes('GetSearchCapabilities'))
          return soap2(
            '<u:GetSearchCapabilitiesResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><SearchCaps>*</SearchCaps></u:GetSearchCapabilitiesResponse>'
          )
        if (body.includes('GetSortCapabilities'))
          return soap2(
            '<u:GetSortCapabilitiesResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><SortCaps></SortCaps></u:GetSortCapabilitiesResponse>'
          )
        if (body.includes('GetSystemUpdateID'))
          return soap2(
            '<u:GetSystemUpdateIDResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Id>7</Id></u:GetSystemUpdateIDResponse>'
          )
        if (body.includes('<u:Search')) {
          const q = (body.match(/contains &quot;(.*?)&quot;/)?.[1] ?? '').toLowerCase()
          const scope = body.match(/derivedfrom &quot;(.*?)&quot;/)?.[1] ?? ''
          const useArtist = body.includes('upnp:artist contains')
          const useAlbum = body.includes('upnp:album contains')
          const parts: string[] = []
          if (scope.includes('container.album')) {
            for (const a of LIB2_ALBUMS)
              if (a.title.toLowerCase().includes(q) || (useArtist && a.artist.toLowerCase().includes(q)))
                parts.push(didlContainer(a.id, 'a2-music', a.title, 'object.container.album', a.art, a.artist, a.date, a.genres))
          } else if (scope.includes('item.audioItem')) {
            for (const a of LIB2_ALBUMS)
              for (let n = 1; n <= a.count; n++) {
                const md = a.track(n)
                const title = String(md.title ?? '')
                if (
                  title.toLowerCase().includes(q) ||
                  (useArtist && a.artist.toLowerCase().includes(q)) ||
                  (useAlbum && a.title.toLowerCase().includes(q))
                )
                  parts.push(didlTrack(a, n))
              }
          }
          return soap2(
            `<u:SearchResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Result>${xmlEsc(didlWrap(parts.join('')))}</Result><NumberReturned>${parts.length}</NumberReturned><TotalMatches>${parts.length}</TotalMatches><UpdateID>7</UpdateID></u:SearchResponse>`
          )
        }
        const objectId = body.match(/<ObjectID>(.*?)<\/ObjectID>/)?.[1] ?? '0'
        const flag = body.match(/<BrowseFlag>(.*?)<\/BrowseFlag>/)?.[1] ?? 'BrowseDirectChildren'
        const meta = cd2Metadata(objectId)
        const all = flag === 'BrowseMetadata' ? (meta ? [meta] : null) : cd2Children(objectId)
        if (!all) {
          res.writeHead(500)
          return res.end('<error/>')
        }
        return soap2(
          `<u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Result>${xmlEsc(didlWrap(all.join('')))}</Result><NumberReturned>${all.length}</NumberReturned><TotalMatches>${all.length}</TotalMatches><UpdateID>7</UpdateID></u:BrowseResponse>`
        )
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
                },
                {
                  model: 'Demo',
                  name: 'Demo NAS',
                  manufacturer: 'TastyTunes',
                  udn: 'demo-udn-2',
                  description_url: `${host}/description2.xml`
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
                parts.push(didlContainer(a.id, 'lib-music', a.title, 'object.container.album', a.art, a.artist, a.date, a.genres))
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
      // Tone/EQ capability spec + state (mirrors the real Evo; reads and
      // atomic writes, full new state echoed back).
      if (u.pathname === '/smoip/zone/audio/spec') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ zone: 'ZONE1', data: AUDIO_SPEC }))
      }
      // §10 device-control specs + display read (mirror of the mock)
      if (u.pathname === '/smoip/system/display/spec') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: { brightness: { enum: ['off', 'dim', 'bright'] } } }))
      }
      if (u.pathname === '/smoip/system/display') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: DATA['/system/display'] }))
      }
      if (u.pathname === '/smoip/system/power/spec') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: {
          power: { enum: ['ON', 'ECO_MODE', 'NETWORK', 'default', 'toggle'], readonly: false },
          standby_mode: { enum: ['ECO_MODE', 'NETWORK'], readonly: false },
          auto_power_down: { minimum: 0, maximum: 7200, readonly: false }
        } }))
      }
      if (u.pathname === '/smoip/zone/audio') {
        const params: Dict = {}
        for (const [k, v] of u.searchParams) {
          params[k] =
            v === 'true' ? true
            : v === 'false' ? false
            : k !== 'user_eq_bands' && v !== '' && !Number.isNaN(Number(v)) ? Number(v)
            : v
        }
        if (Object.keys(params).some((k) => k !== 'zone') && !applyAudioWrite(params)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end('{"code": 112, "message": "invalid parameter"}')
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ zone: 'ZONE1', data: DATA['/zone/audio'] }))
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
      // Queue edits (row remove / drag reorder / Clear queue) — these two
      // routes were MISSING here while the mock had them (fork drift, caught
      // 2026-08-06 adding delete_all): demo-mode queue edits failed silently.
      // Mirrors dev/mock-streamer.mjs; {"start":0,"delete_all":true} is the
      // firmware's clear-all form (vibin's playlist_clear).
      if (u.pathname === '/smoip/queue/delete' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as Dict
        const ids = Array.isArray(body.ids) ? (body.ids as number[]) : []
        const cur = (DATA['/queue/list'] as { items?: QueueItem[] }).items ?? []
        const items = body.delete_all ? [] : cur.filter((it) => !ids.includes(it.id))
        setQueue(items, null)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"zone": "ZONE1"}')
      }
      if (u.pathname === '/smoip/queue/move' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as Dict
        const items = [...((DATA['/queue/list'] as { items?: QueueItem[] }).items ?? [])]
        const idx = items.findIndex((it) => it.id === body.id)
        if (idx >= 0 && typeof body.to === 'number') {
          const [it] = items.splice(idx, 1)
          items.splice(Math.max(0, Math.min(items.length, body.to as number)), 0, it)
        }
        setQueue(items, null)
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
      const push = (path: string): void => ws.send(JSON.stringify({ path, params: { data: wireData(path) } }))
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
        } else if (frame.path === '/zone/play_control' && (DATA['/system/power'] as Dict).power !== 'ON') {
          // FIRMWARE TRUTH (live-probed 2026-07-23, mirrored from the mock):
          // standby refuses every play_control verb (code 114) — nothing
          // plays, nothing wakes. Wake-on-intent sends power ON first.
        } else if (frame.path === '/zone/play_control' && typeof params.skip_track === 'number') {
          advanceTrack(params.skip_track, push)
        } else if (frame.path === '/zone/state' && typeof params.volume_percent === 'number') {
          // echo volume like a real device (async push back)
          DATA['/zone/state'] = { ...DATA['/zone/state'], volume_percent: params.volume_percent }
          setTimeout(() => push('/zone/state'), 120)
        } else if (frame.path === '/zone/state' && typeof params.volume_step_change === 'number') {
          // Pre-Amp: the real firmware applies the step to the level and
          // pushes the new percent, clamped at the device's own volume limit
          // (mirrors mock-streamer.mjs — neither applied it before 2026-08-04,
          // so wheel volume looked dead in demo mode once the mini's volume
          // slider became the seek slider; the slider's absolute writes echo,
          // which is why the gap had been invisible).
          const zone = DATA['/zone/state'] as Dict
          const curPercent = zone.volume_percent
          if (typeof curPercent === 'number') {
            const rawLimit = (DATA['/zone/audio'] as Dict | undefined)?.volume_limit_percent
            const limit = typeof rawLimit === 'number' ? rawLimit : 100
            DATA['/zone/state'] = {
              ...zone,
              volume_percent: Math.max(0, Math.min(limit, curPercent + params.volume_step_change))
            }
            setTimeout(() => push('/zone/state'), 120)
          }
        } else if (frame.path === '/zone/state' && typeof params.mute === 'boolean') {
          // echo mute like a real device (async push back) — the renderer does
          // no optimistic update, so without this the mute button never engages
          DATA['/zone/state'] = { ...DATA['/zone/state'], mute: params.mute }
          setTimeout(() => push('/zone/state'), 120)
        } else if (frame.path === '/zone/state' && typeof params.source === 'string') {
          // echo an input switch (mirrors mock-streamer.mjs — neither handled
          // this before 2026-07-25, so switching a source in the demo did
          // nothing at all). now_playing carries the source too; both move
          // together like the real device.
          const id = params.source as string
          const sources = (DATA['/system/sources'] as Dict).sources as Dict[] | undefined
          const known = (sources ?? []).find((s) => s.id === id)
          DATA['/zone/state'] = { ...DATA['/zone/state'], source: id }
          DATA['/zone/now_playing'] = {
            ...DATA['/zone/now_playing'],
            source: { id, name: (known?.name as string) ?? id }
          }
          setTimeout(() => {
            push('/zone/state')
            push('/zone/now_playing')
          }, 120)
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
        } else if (frame.path === '/system/power') {
          // partial writes: power / standby_mode / auto_power_down (merge)
          const cur = DATA['/system/power'] as Dict
          const next: Dict = { ...cur }
          if (typeof params.power === 'string')
            next.power = params.power === 'toggle' ? (cur.power === 'ON' ? 'NETWORK' : 'ON') : params.power
          if (typeof params.standby_mode === 'string') next.standby_mode = params.standby_mode
          if (typeof params.auto_power_down === 'number') next.auto_power_down = params.auto_power_down
          DATA['/system/power'] = next
          setTimeout(() => push('/system/power'), 120)
        } else if (frame.path === '/system/display' && typeof params.brightness === 'string') {
          DATA['/system/display'] = { ...DATA['/system/display'], brightness: params.brightness }
          setTimeout(() => push('/system/display'), 120)
        } else if (frame.path === '/zone/audio') {
          // tone/EQ write over the WS — atomic, /zone/audio pushed on success
          applyAudioWrite(params)
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
