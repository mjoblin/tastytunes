import {
  QUEUE_LEN,
  PLAYING_QUEUE_ID,
  type Dict,
  xmlEsc,
  durFmt,
  didlContainer,
} from "./demoShared";

// The built-in demo's LIBRARY (split out of demoStreamer.ts 2026-09-13; the
// streamer's builder had held it beside the sockets in one 1,921-line function):
// the demo device's state and audio spec, the three media servers' albums,
// artists and genres, their DIDL renderers and content-directory answers, the
// resizing art, and the two device descriptions. Everything here is a pure
// function of the host; the streamer destructures what its protocol reads.

export function buildDemoLibrary(host: string) {
  const art = (
    hue: number,
  ): string => `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
  <defs><radialGradient id="g" cx="30%" cy="30%"><stop offset="0%" stop-color="hsl(${hue} 90% 65%)"/>
  <stop offset="60%" stop-color="hsl(${(hue + 40) % 360} 70% 45%)"/><stop offset="100%" stop-color="hsl(${(hue + 80) % 360} 60% 18%)"/></radialGradient></defs>
  <rect width="600" height="600" fill="url(#g)"/>
  <circle cx="420" cy="180" r="140" fill="hsl(${hue} 90% 70%)" opacity="0.7"/>
  <circle cx="150" cy="450" r="180" fill="hsl(${(hue + 80) % 360} 70% 35%)" opacity="0.6"/></svg>`;

  const ARTS: Record<string, string> = {};
  for (let i = 1; i <= 30; i++) ARTS[`/art/q${i}.svg`] = art((i * 47) % 360);
  for (let i = 1; i <= 24; i++) ARTS[`/art/p${i}.svg`] = art((i * 61 + 20) % 360);
  const artUrl = (n: number): string => `${host}/art/q${n}.svg`;

  const trackMeta = (n: number): Dict => ({
    class: "stream.media.upnp",
    source: "MEDIA_PLAYER",
    name: null,
    title: `Demo Track ${n}`,
    art_url: artUrl(n),
    track_number: n,
    duration: 180 + n * 7,
    genre: "Electronic",
    album: "Amber Nights",
    artist: "The Amber Collective",
  });

  const DATA: Record<string, Dict> = {
    "/system/info": {
      name: "Demo streamer",
      timezone: "Europe/London",
      locale: "en_GB",
      usage_reports: false,
      setup: true,
      sources_setup: true,
      versions: [{ component: "SMOIP", version: "1.8" }],
      udn: "demo-udn-1",
      hcv: 1,
      model: "Demo",
      unit_id: "DEMO1",
      max_http_body_size: 65536,
      api: "1.8",
    },
    "/system/power": { power: "ON", standby_mode: "NETWORK", auto_power_down: 3600 },
    "/system/display": { brightness: "dim" },
    // Firmware self-check status the streamer pushes to subscribers. The demo is
    // always up-to-date (no update shown). Read-only, like the mock — the app
    // never sends action=CHECK/UPDATE. (Mirror of dev/mock-streamer.mjs, minus
    // that file's MOCK_FIRMWARE_* scenario knobs — deliberate fork, keep in sync.)
    "/system/update": { early_update: false, update_available: false, updating: false },
    "/system/sources": {
      sources: [
        {
          id: "MEDIA_PLAYER",
          name: "Media Player",
          default_name: "Media Player",
          class: "stream.media",
          nameable: false,
          ui_selectable: true,
          description: "",
          description_locale: "",
          preferred_order: 1,
        },
        {
          id: "IR",
          name: "Internet Radio",
          default_name: "Internet Radio",
          class: "stream.radio",
          nameable: false,
          ui_selectable: true,
          description: "",
          description_locale: "",
          preferred_order: 2,
        },
        {
          id: "USB_AUDIO",
          name: "USB Audio",
          default_name: "USB Audio",
          class: "digital.usb",
          nameable: true,
          ui_selectable: true,
          description: "",
          description_locale: "",
          preferred_order: 3,
        },
        {
          id: "BLUETOOTH",
          name: "Bluetooth",
          default_name: "Bluetooth",
          class: "digital.bluetooth",
          nameable: true,
          ui_selectable: true,
          description: "",
          description_locale: "",
          preferred_order: 4,
        },
        {
          id: "AIRPLAY",
          name: "AirPlay",
          default_name: "AirPlay",
          class: "stream.airplay",
          nameable: false,
          ui_selectable: false,
          description: "",
          description_locale: "",
          preferred_order: 5,
        },
      ],
    },
    "/zone/state": {
      source: "MEDIA_PLAYER",
      power: true,
      pre_amp_mode: true,
      pre_amp_state: "on",
      mute: false,
      volume_step: 15,
      volume_percent: 42,
      volume_db: null,
      cbus: null,
    },
    "/zone/play_state": {
      state: "play",
      position: 73,
      presettable: true,
      queue_index: PLAYING_QUEUE_ID - 1,
      queue_length: QUEUE_LEN,
      queue_id: PLAYING_QUEUE_ID,
      mode_repeat: "off",
      mode_shuffle: "off",
      metadata: {
        ...trackMeta(PLAYING_QUEUE_ID),
        // FILE-TAG READOUT (live, 2026-08-21): play_state reports what the
        // decoder read from the file, not what the server said — Asset
        // renames multi-disc albums, so the readout says "[Disc 1]" while the
        // queue entry and the library say "Amber Nights". Mirrors the mock's
        // MOCK_TAG_METADATA shape so the demo proves the library matches by
        // queue entry, never by this string.
        album: "Amber Nights [Disc 1]",
        playback_source: "punnet",
        sample_format: "44.1kHz/16bit",
        mqa: "none",
        codec: "FLAC",
        lossless: true,
        sample_rate: 44100,
        bit_depth: 16,
        encoding: null,
        station: null,
        bitrate: null,
        radio_id: null,
      },
    },
    "/zone/play_state/position": { position: 73 },
    "/zone/now_playing": {
      state: "play",
      source: { id: "MEDIA_PLAYER", name: "Media Player" },
      display: {
        line1: `Demo Track ${PLAYING_QUEUE_ID}`,
        line2: "The Amber Collective",
        line3: "Amber Nights",
        format: "44.1kHz/16bit FLAC",
        mqa: "none",
        playback_source: "punnet",
        class: "stream.media.upnp",
        art_url: artUrl(PLAYING_QUEUE_ID),
        art_file: null,
        progress: { position: 73, duration: 180 + PLAYING_QUEUE_ID * 7 },
        context: null,
      },
      queue: { length: QUEUE_LEN, position: PLAYING_QUEUE_ID - 1, shuffle: "off", repeat: "off" },
      controls: [
        "play_pause",
        "track_next",
        "track_previous",
        "seek",
        "toggle_shuffle",
        "toggle_repeat",
      ],
    },
    // A queue entry's artist is the DIDL's FIRST upnp:artist (live 2026-08-21:
    // Asset's AlbumArtist role, so compilation entries read "Various Artists";
    // the mock's MOCK_QUEUE_COMPILATION stages it) — the renderer's queue rows
    // show the performer the index knows. This scene holds no compilation.
    "/queue/list": {
      start: 0,
      count: QUEUE_LEN,
      total: QUEUE_LEN,
      play_postition: PLAYING_QUEUE_ID - 1,
      play_id: PLAYING_QUEUE_ID,
      items: Array.from({ length: QUEUE_LEN }, (_, i) => ({
        id: i + 1,
        position: i,
        metadata: trackMeta(i + 1),
      })),
    },
    "/presets/list": {
      start: 1,
      end: 24,
      max_presets: 99,
      presettable: true,
      // preset 1 art-matches the playing track -> shows as playing
      presets: Array.from({ length: 24 }, (_, i) => ({
        id: i + 1,
        name: i === 0 ? "Amber Nights" : `Demo Preset ${i + 1}`,
        type: "MEDIA",
        class: "stream.media.upnp",
        state: "OK",
        is_playing: false, // real firmware never holds this true (verified live)
        art_url: i === 0 ? artUrl(PLAYING_QUEUE_ID) : `${host}/art/p${i + 1}.svg`,
        airable_radio_id: null,
      })),
    },
    // Tone/EQ chain — read shape captured live off the Evo 150 2026-07-19
    // (mirror of dev/mock-streamer.mjs minus its MOCK_NO_EQ knobs; the demo
    // always has tone controls so the section is explorable without hardware).
    "/zone/audio": {
      volume_limit_percent: 50,
      tilt_eq: { enabled: false, intensity: 0 },
      user_eq: {
        enabled: false,
        bands: [
          [80, "LOWSHELF", 0.8],
          [120, "PEAKING", 1.24],
          [315, "PEAKING", 1.24],
          [800, "PEAKING", 1.24],
          [2000, "PEAKING", 1.24],
          [5000, "PEAKING", 1.24],
          [8000, "HIGHSHELF", 0.8],
        ].map(([freq, filter, q], index) => ({ index, filter, freq, gain: 0, q })),
      },
      balance: 0,
      pipeline: "DSP",
    },
  };

  const AUDIO_SPEC: Dict = {
    volume_limit_percent: { minimum: 1, maximum: 100, readonly: false },
    pipeline: { readonly: false },
    tilt_eq: { minimum: -15, maximum: 15, readonly: false },
    user_eq: {
      bands: 7,
      filters: {
        enum: [
          "PASSTHROUGH",
          "PEAKING",
          "LOWSHELF",
          "HIGHSHELF",
          "NOTCH",
          "HIGHPASS",
          "LOWPASS",
          "ALLPASS",
        ],
      },
      readonly: false,
      always_on: false,
    },
    balance: { minimum: -15, maximum: 15, readonly: false },
  };

  // ---- media library: ContentDirectory + /smoip/queue/add (Library screen) --

  type Album = {
    id: string;
    title: string;
    artist: string;
    date: string;
    art: string | null;
    count: number;
    genres?: string[];
    track: (n: number) => Dict;
  };

  const LIB_ALBUMS: Album[] = [
    {
      id: "alb-1",
      title: "Amber Nights",
      artist: "The Amber Collective",
      date: "2011-03-14",
      art: `${host}/art/p1.svg`,
      count: 8,
      genres: ["Electronic"],
      // every track composed by the same writer → the album leaf says so
      track: (n) => ({ ...trackMeta(n), composer: "Amber Writer" }),
    },
    {
      id: "alb-2",
      title: "Neon Evenings",
      artist: "The Neon Collective",
      date: "2014-06-01",
      // Asset-style RESIZING art URL (mirrors the mock; the app asks for the
      // size it draws — shared/artUrl)
      art: `${host}/aa/2002/cover.jpg?size=0`,
      count: 5,
      genres: ["Synthpop; Electropop"],
      // Track 3 FEATURES a guest, in Asset's exact shape (mirrors the mock —
      // see dev/mock-streamer.mjs): AlbumArtist role + packed performers +
      // Composer role. Keeps the featured-track law demo-visible.
      track: (n) => ({
        ...trackMeta(n),
        title: `Neon Track ${n}`,
        album: "Neon Evenings",
        artist: n === 3 ? "The Neon Collective; Ivy Lane" : "The Neon Collective",
        ...(n === 3
          ? { albumArtist: "The Neon Collective", composer: "Neon Writer; Ivy Lane" }
          : {}),
        ...(n === 5 ? { mp3: true } : {}), // the one lossy track in a FLAC album
        art_url: `${host}/aa/2002/cover.jpg?size=0`,
        duration: 120 + n * 11,
      }),
    },
    {
      // A COMPILATION in Asset's exact shape (mirrors the mock): container
      // artist "Various Artists"; each track role="AlbumArtist" + performer.
      id: "alb-3",
      title: "Godzone Mix",
      artist: "Various Artists",
      date: "2002-01-01",
      art: `${host}/art/p3.svg`,
      count: 3,
      genres: ["New Zealand"],
      track: (n) => ({
        ...trackMeta(n),
        title: `Godzone ${n}`,
        album: "Godzone Mix",
        artist: ["Coconut Rough", "Citizen Band", "Che Fu"][n - 1],
        albumArtist: "Various Artists",
        art_url: `${host}/art/p3.svg`,
        duration: 180 + n,
      }),
    },
    // two EDITIONS of one album (mirrors the mock): same title/artist/year,
    // different folders and art, 16/44.1 vs 24/96
    ...(
      [
        ["alb-4", "p4", false],
        ["alb-5", "p5", true],
      ] as const
    ).map(([id, art, hires]) => ({
      id,
      title: "Dark Skies",
      artist: "The Neon Collective",
      date: "2016-05-05",
      art: `${host}/art/${art}.svg`,
      count: 2,
      genres: ["Synthpop"],
      track: (n: number) => ({
        ...trackMeta(n),
        title: `Dark Skies ${n}`,
        album: "Dark Skies",
        artist: "The Neon Collective",
        ...(hires ? { hires: true } : {}),
        art_url: `${host}/art/${art}.svg`,
        duration: 200 + n,
      }),
    })),
  ];

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
      id: "a2-amber",
      title: "Amber Nights",
      artist: "The Amber Collective",
      date: "2011-03-14",
      art: `${host}/art/p21.svg`,
      count: 3,
      genres: ["Electronic"],
      track: (n) => ({
        ...trackMeta(n),
        title: `Amber Track ${n}`,
        album: "Amber Nights",
        artist: "The Amber Collective",
        art_url: `${host}/art/p21.svg`,
        duration: 200 + n,
      }),
    },
    {
      id: "a2-velvet",
      title: "Velvet Static",
      artist: "Static Nomads",
      date: "2019-09-09",
      art: `${host}/art/p22.svg`,
      count: 4,
      genres: ["Ambient", "Downtempo"],
      track: (n) => ({
        ...trackMeta(n),
        title: `Velvet ${n}`,
        album: "Velvet Static",
        artist: "Static Nomads",
        art_url: `${host}/art/p22.svg`,
        duration: 150 + n * 7,
      }),
    },
  ];
  const album2ById = (id: string): Album | undefined => LIB2_ALBUMS.find((a) => a.id === id);

  // A THIRD media server, always present in the demo: a minidlna/ReadyMedia-
  // SHAPED box (mirrors dev/mock-streamer.mjs's MOCK_MINIDLNA_SERVER; every
  // trait rig-verified against ReadyMedia 1.3.3, 2026-08-16). Deliberately
  // NOT Asset's shape — the demo must exercise the other reading:
  //   - NO role attributes: upnp:artist is the ALBUM ARTIST, dc:creator the
  //     performer (compilation tracks say "Various Artists" and name their
  //     singer only as creator; a "feat." track likewise)
  //   - virtual "- All Albums -" under every artist (BARE object.container.album
  //     WITH upnp:artist) and "- All Artists -" under every genre (bare
  //     object.container.person), answering class searches beside the real ones
  //   - album containers carry NO dc:date (tracks do)
  //   - a two-disc set has per-disc track numbers and NO disc element; Browse
  //     order is disc-then-track (1, 2, 1, 2)
  //   - res without bitsPerSample; one albumArtURI tagged JPEG_TN
  type Lib3Album = {
    id: string;
    title: string;
    artist: string;
    genre: string;
    art: string | null;
    tracks: Array<{ n: number; title: string; creator: string; date: string }>;
  };
  const LIB3_ALBUMS: Lib3Album[] = [
    {
      id: "m3-shark",
      title: "Sharkmouth",
      artist: "Russell Morris",
      genre: "Rock",
      art: `${host}/art/p24.svg`,
      tracks: [
        { n: 1, title: "Sharkmouth", creator: "Russell Morris", date: "2012-01-01" },
        { n: 2, title: "Feat Cut", creator: "Russell Morris feat. Guest One", date: "2012-01-01" },
      ],
    },
    {
      id: "m3-comp",
      title: "Rig Compilation",
      artist: "Various Artists",
      genre: "Rock",
      art: null,
      tracks: [
        { n: 1, title: "First Cut", creator: "Guest One", date: "2020-01-01" },
        { n: 2, title: "Second Cut", creator: "Guest Two", date: "2020-01-01" },
      ],
    },
    {
      id: "m3-box",
      title: "Box Set",
      artist: "Enya",
      genre: "New Age",
      art: null,
      tracks: [
        { n: 1, title: "Disc One A", creator: "Enya", date: "2000-01-01" },
        { n: 2, title: "Disc One B", creator: "Enya", date: "2000-01-01" },
        { n: 1, title: "Disc Two A", creator: "Enya", date: "2000-01-01" },
        { n: 2, title: "Disc Two B", creator: "Enya", date: "2000-01-01" },
      ],
    },
  ];
  const LIB3_ARTISTS = [...new Set(LIB3_ALBUMS.map((a) => a.artist))];
  const LIB3_GENRES = [...new Set(LIB3_ALBUMS.map((a) => a.genre))];
  const album3ById = (id: string): Lib3Album | undefined => LIB3_ALBUMS.find((a) => a.id === id);
  const didl3Art = (art: string | null): string =>
    art
      ? `<upnp:albumArtURI dlna:profileID="JPEG_TN" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">${art}</upnp:albumArtURI>`
      : "";
  const didl3Album = (a: Lib3Album, cls = "object.container.album.musicAlbum"): string =>
    `<container id="${a.id}" parentID="m3-albums" restricted="1" searchable="1" childCount="${a.tracks.length}"><dc:title>${xmlEsc(a.title)}</dc:title><upnp:class>${cls}</upnp:class><upnp:storageUsed>-1</upnp:storageUsed><dc:creator>${xmlEsc(a.artist)}</dc:creator><upnp:genre>${xmlEsc(a.genre)}</upnp:genre><upnp:artist>${xmlEsc(a.artist)}</upnp:artist>${didl3Art(a.art)}</container>`;
  const didl3AllAlbums = (artist: string, i: number): string =>
    `<container id="m3-artist-${i}-all" parentID="m3-artist-${i}" restricted="1" searchable="1" childCount="1"><dc:title>- All Albums -</dc:title><upnp:class>object.container.album</upnp:class><upnp:storageUsed>-1</upnp:storageUsed><dc:creator>${xmlEsc(artist)}</dc:creator><upnp:artist>${xmlEsc(artist)}</upnp:artist></container>`;
  const didl3Artist = (artist: string, i: number): string =>
    `<container id="m3-artist-${i}" parentID="m3-artists" restricted="1" searchable="1" childCount="2"><dc:title>${xmlEsc(artist)}</dc:title><upnp:class>object.container.person.musicArtist</upnp:class><upnp:storageUsed>-1</upnp:storageUsed></container>`;
  const didl3AllArtists = (genre: string, i: number): string =>
    `<container id="m3-genre-${i}-all" parentID="m3-genre-${i}" restricted="1" searchable="1" childCount="1"><dc:title>- All Artists -</dc:title><upnp:class>object.container.person</upnp:class><upnp:storageUsed>-1</upnp:storageUsed><upnp:genre>${xmlEsc(genre)}</upnp:genre></container>`;
  const track3Secs = (i: number): number => 120 + i * 11;
  const didl3Track = (a: Lib3Album, i: number): string => {
    const t = a.tracks[i];
    const secs = track3Secs(i);
    return `<item id="${a.id}-i${i}" parentID="${a.id}" restricted="1" refID="m3-folders-${a.id}-${i}"><dc:title>${xmlEsc(t.title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><dc:creator>${xmlEsc(t.creator)}</dc:creator><dc:date>${t.date}</dc:date><upnp:artist>${xmlEsc(a.artist)}</upnp:artist><upnp:album>${xmlEsc(a.title)}</upnp:album><upnp:genre>${xmlEsc(a.genre)}</upnp:genre><upnp:originalTrackNumber>${t.n}</upnp:originalTrackNumber>${didl3Art(a.art)}<res size="${secs * 100000}" duration="${durFmt(secs)}" bitrate="100000" sampleFrequency="44100" nrAudioChannels="2" protocolInfo="http-get:*:audio/x-flac:*">${host}/MediaItems/${a.id}-${i}.flac</res></item>`;
  };
  const track3Meta = (a: Lib3Album, i: number): Dict => ({
    ...trackMeta(i + 1),
    title: a.tracks[i].title,
    album: a.title,
    artist: a.tracks[i].creator,
    genre: a.genre,
    art_url: a.art,
    track_number: a.tracks[i].n,
    duration: track3Secs(i),
  });
  function cd3Children(id: string): string[] | null {
    if (id === "0")
      return [
        `<container id="m3-music" parentID="0" restricted="1" searchable="1" childCount="2"><dc:title>Music</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>`,
      ];
    if (id === "m3-music")
      return [
        `<container id="m3-albums" parentID="m3-music" restricted="1" searchable="1" childCount="${LIB3_ALBUMS.length}"><dc:title>Album</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>`,
        `<container id="m3-artists" parentID="m3-music" restricted="1" searchable="1" childCount="${LIB3_ARTISTS.length}"><dc:title>Artist</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>`,
      ];
    if (id === "m3-albums") return LIB3_ALBUMS.map((a) => didl3Album(a));
    if (id === "m3-artists") return LIB3_ARTISTS.map(didl3Artist);
    const am = id.match(/^m3-artist-(\d+)$/);
    if (am) {
      const artist = LIB3_ARTISTS[Number(am[1])];
      return [
        didl3AllAlbums(artist, Number(am[1])),
        ...LIB3_ALBUMS.filter((a) => a.artist === artist).map((a) => didl3Album(a)),
      ];
    }
    const alb = album3ById(id);
    if (alb) return alb.tracks.map((_, i) => didl3Track(alb, i));
    return null;
  }
  function cd3Metadata(id: string): string | null {
    const alb = album3ById(id);
    if (alb) return didl3Album(alb);
    const m = id.match(/^(m3-\w+)-i(\d+)$/);
    if (m) {
      const a = album3ById(m[1]);
      if (a && a.tracks[Number(m[2])]) return didl3Track(a, Number(m[2]));
    }
    return null;
  }
  const DESCRIPTION3_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>Demo ReadyMedia</friendlyName><manufacturer>Justin Maggard</manufacturer><modelName>Windows Media Connect compatible (MiniDLNA)</modelName><modelNumber>1.3.3</modelNumber><UDN>uuid:demo-udn-3</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><controlURL>/upnp3/control</controlURL><eventSubURL>/upnp3/event</eventSubURL><SCPDURL>/upnp3/scpd.xml</SCPDURL></service></serviceList></device></root>`;

  function cd2Children(id: string): string[] | null {
    if (id === "0") return [didlContainer("a2-music", "0", "Music", "object.container", null)];
    if (id === "a2-music")
      return LIB2_ALBUMS.map((a) =>
        didlContainer(
          a.id,
          "a2-music",
          a.title,
          "object.container.album.musicAlbum",
          a.art,
          a.artist,
          a.date,
          a.genres,
        ),
      );
    const alb = album2ById(id);
    if (alb) return Array.from({ length: alb.count }, (_, i) => didlTrack(alb, i + 1));
    return null;
  }
  function cd2Metadata(id: string): string | null {
    if (id === "a2-music") return didlContainer("a2-music", "0", "Music", "object.container", null);
    const alb = album2ById(id);
    if (alb)
      return didlContainer(
        alb.id,
        "a2-music",
        alb.title,
        "object.container.album.musicAlbum",
        alb.art,
        alb.artist,
        alb.date,
        alb.genres,
      );
    const m = id.match(/^(a2-\w+)-t(\d+)$/);
    if (m) {
      const a = album2ById(m[1]);
      if (a) return didlTrack(a, Number(m[2]));
    }
    return null;
  }

  const SYN_GENRES = [
    "House",
    "Techno",
    "IDM",
    "Trance",
    "Breakbeat",
    "Dub",
    "Chillout",
    "Garage",
    "Electro",
    "Acid",
  ];
  // Synth Album 35 is a TWO-DISC album in Asset's exact shape (mirrors the
  // mock): disc number/count elements AND originalTrackNumber packed as
  // disc×100+track (101, 102, 201, 202).
  const SYN_ALBUMS: Album[] = Array.from({ length: 35 }, (_, i) => ({
    id: `syn-${i + 1}`,
    title: `Synth Album ${i + 1}`,
    artist: `Demo Artist ${(i % 30) + 1}`,
    date: `${1980 + i}-01-01`,
    art: null,
    count: i === 34 ? 4 : 2,
    genres: [SYN_GENRES[i % 10]],
    track: (n: number) => ({
      ...trackMeta(n),
      ...(i === 34
        ? { disc: n <= 2 ? 1 : 2, discCount: 2, trackNo: (n <= 2 ? 100 : 200) + ((n - 1) % 2) + 1 }
        : {}),
      // four formats across four tracks (16/44.1, 24/96, AAC, ALAC): "mixed formats", every row says
      ...(i === 34 && n === 2 ? { hires: true } : {}),
      ...(i === 34 && n === 3 ? { aac: true } : {}),
      ...(i === 34 && n === 4 ? { alac: true } : {}),
      title: `Synth ${i + 1}.${n}`,
      album: `Synth Album ${i + 1}`,
      artist: `Demo Artist ${(i % 30) + 1}`,
      art_url: null,
      duration: 90 + n,
    }),
  }));
  const albumById = (id: string): Album | undefined =>
    LIB_ALBUMS.find((a) => a.id === id) ?? SYN_ALBUMS.find((a) => a.id === id);

  // Asset's artist block for a track (see the mock's didlArtists): with an
  // album artist, AlbumArtist role + plain performers + Composer role and a
  // dc:creator repeating the performers; without, one plain element.
  const didlArtists = (md: Dict): string =>
    md.albumArtist
      ? `<dc:creator>${xmlEsc(String(md.artist))}</dc:creator><upnp:artist role="AlbumArtist">${xmlEsc(String(md.albumArtist))}</upnp:artist><upnp:artist>${xmlEsc(String(md.artist))}</upnp:artist>${md.composer ? `<upnp:artist role="Composer">${xmlEsc(String(md.composer))}</upnp:artist>` : ""}`
      : `<upnp:artist>${xmlEsc(String(md.artist))}</upnp:artist>${md.composer ? `<upnp:artist role="Composer">${xmlEsc(String(md.composer))}</upnp:artist>` : ""}`;
  // The primary <res> with Asset's DLNA attributes (mirrors the mock): FLAC
  // 16/44.1 by default; `mp3: true` = MP3 320 kbps (Neon Track 5).
  // Variants mirror the mock: mp3, hires (FLAC 24/96), and Asset's m4a
  // reporting (decoded PCM attributes for aac AND alac; size tells them apart).
  const didlRes = (alb: Album, n: number, md: Dict): string => {
    const dur = Number(md.duration);
    return md.mp3
      ? `<res duration="${durFmt(dur)}" size="${dur * 40000}" bitrate="40000" sampleFrequency="44100" nrAudioChannels="2" protocolInfo="http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=01">file:///tmp/usm/1/${alb.id}/${n}.mp3</res>`
      : md.aac || md.alac
        ? `<res duration="${durFmt(dur)}" size="${dur * (md.alac ? 400000 : 32000)}" bitrate="576000" bitsPerSample="24" sampleFrequency="96000" nrAudioChannels="2" protocolInfo="http-get:*:audio/mp4:DLNA.ORG_PN=AAC_ISO;DLNA.ORG_OP=01">file:///tmp/usm/1/${alb.id}/${n}.m4a</res>`
        : md.hires
          ? `<res duration="${durFmt(dur)}" size="${dur * 700000}" bitrate="576000" bitsPerSample="24" sampleFrequency="96000" nrAudioChannels="2" protocolInfo="http-get:*:audio/x-flac:DLNA.ORG_PN=FLAC;DLNA.ORG_OP=01">file:///tmp/usm/1/${alb.id}/${n}.flac</res>`
          : `<res duration="${durFmt(dur)}" size="${dur * 100000}" bitrate="176400" bitsPerSample="16" sampleFrequency="44100" nrAudioChannels="2" protocolInfo="http-get:*:audio/x-flac:DLNA.ORG_PN=FLAC;DLNA.ORG_OP=01">file:///tmp/usm/1/${alb.id}/${n}.flac</res>`;
  };
  const didlTrack = (alb: Album, n: number): string => {
    const md = alb.track(n);
    return `<item id="${alb.id}-t${n}" parentID="${alb.id}" restricted="true"><dc:title>${xmlEsc(String(md.title))}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>${didlArtists(md)}<upnp:album>${xmlEsc(String(md.album))}</upnp:album>${(alb.genres ?? []).map((g) => `<upnp:genre>${xmlEsc(g)}</upnp:genre>`).join("")}<upnp:originalTrackNumber>${String(md.trackNo ?? n)}</upnp:originalTrackNumber>${md.disc ? `<upnp:originalDiscNumber>${String(md.disc)}</upnp:originalDiscNumber><upnp:originalDiscCount>${String(md.discCount)}</upnp:originalDiscCount>` : ""}<upnp:albumArtURI>${String(md.art_url)}</upnp:albumArtURI>${didlRes(alb, n, md)}</item>`;
  };

  const ARTIST_COUNT = 400;
  const artistName = (n: number): string =>
    n % 7 === 0 ? `Artist & Friends ${n}` : `Demo Artist ${n}`;

  const didlLooseTrack = (
    id: string,
    parent: string,
    title: string,
    artist: string,
    artU: string,
  ): string =>
    `<item id="${id}" parentID="${parent}" restricted="true"><dc:title>${xmlEsc(title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><upnp:artist>${xmlEsc(artist)}</upnp:artist><upnp:albumArtURI>${artU}</upnp:albumArtURI><res duration="0:03:00.000" protocolInfo="*:*:*:*">file:///tmp/usm/1/singles/${id}.flac</res></item>`;
  const SINGLES: Array<[string, string, string]> = [
    ["sng-1", "Zeta Song", "The Amber Collective"],
    ["sng-2", "Alpha Song", "The Neon Collective"],
    ["sng-3", "Middle Song", "The Amber Collective"],
  ];

  function cdChildren(id: string): string[] | null {
    if (id === "0")
      return [
        didlContainer("lib-music", "0", "Music", "object.container", null),
        didlContainer("lib-artists", "0", "Artists", "object.container", null),
        didlContainer("lib-singles", "0", "Singles", "object.container", null),
        didlContainer("lib-attic", "0", "Attic", "object.container", null),
      ];
    if (id === "lib-attic")
      return [
        didlContainer("attic-boot", "lib-attic", "[Bootlegs]", "object.container", null),
        didlContainer("attic-live", "lib-attic", "Live Tapes", "object.container", null),
      ];
    if (id === "attic-boot" || id === "attic-live")
      return SINGLES.map(([sid, title, artist], i) =>
        didlLooseTrack(`${id}-${sid}`, id, title, artist, `${host}/art/p${i + 11}.svg`),
      );
    if (id === "lib-singles")
      return SINGLES.map(([sid, title, artist], i) =>
        didlLooseTrack(sid, "lib-singles", title, artist, `${host}/art/p${i + 11}.svg`),
      );
    if (id === "lib-artists")
      return [
        didlContainer(
          "art-all",
          "lib-artists",
          "[All Artists]",
          "object.container.person",
          `${host}/art/p9.svg`,
        ),
        ...Array.from({ length: ARTIST_COUNT }, (_, i) =>
          didlContainer(
            `art-${i + 1}`,
            "lib-artists",
            artistName(i + 1),
            "object.container.person.musicArtist",
            i < 8 ? `${host}/art/p${(i % 24) + 1}.svg` : null,
          ),
        ),
      ];
    if (id === "lib-music")
      return [
        ...LIB_ALBUMS.map((a) =>
          didlContainer(
            a.id,
            "lib-music",
            a.title,
            "object.container.album.musicAlbum",
            a.art,
            a.artist,
            a.date,
            a.genres,
          ),
        ),
        didlTrack(LIB_ALBUMS[0], 1),
      ];
    const artMatch = id.match(/^art-(\d+)$/);
    if (artMatch) {
      const albums = artMatch[1] === "2" ? SYN_ALBUMS : LIB_ALBUMS;
      return [
        didlContainer(`${id}-alltracks`, id, " [All Tracks]", "object.container", null),
        didlContainer(`${id}-shuffle`, id, " [Shuffle Tracks]", "object.container", null),
        ...albums.map((a) =>
          didlContainer(
            a.id,
            id,
            a.title,
            "object.container.album.musicAlbum",
            a.art,
            a.artist,
            a.date,
            a.genres,
          ),
        ),
      ];
    }
    if (/^art-\d+-(alltracks|shuffle)$/.test(id))
      return LIB_ALBUMS.flatMap((a) =>
        Array.from({ length: a.count }, (_, i) => didlTrack(a, i + 1)),
      );
    const alb = albumById(id);
    if (alb) return Array.from({ length: alb.count }, (_, i) => didlTrack(alb, i + 1));
    return null;
  }
  function cdMetadata(id: string): string | null {
    if (id === "lib-music")
      return didlContainer("lib-music", "0", "Music", "object.container", null);
    if (id === "lib-singles")
      return didlContainer("lib-singles", "0", "Singles", "object.container", null);
    const alb = albumById(id);
    if (alb)
      return didlContainer(
        alb.id,
        "lib-music",
        alb.title,
        "object.container.album.musicAlbum",
        alb.art,
        alb.artist,
        alb.date,
        alb.genres,
      );
    const m = id.match(/^((?:alb|syn)-\d+)-t(\d+)$/);
    if (m) {
      const a = albumById(m[1]);
      if (a) return didlTrack(a, Number(m[2]));
    }
    const sng = SINGLES.findIndex(([sid]) => sid === id);
    if (sng >= 0)
      return didlLooseTrack(
        id,
        "lib-singles",
        SINGLES[sng][1],
        SINGLES[sng][2],
        `${host}/art/p${sng + 11}.svg`,
      );
    return null;
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
</root>`;

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
</root>`;

  return {
    art,
    ARTS,
    DATA,
    AUDIO_SPEC,
    LIB_ALBUMS,
    LIB2_ALBUMS,
    album2ById,
    LIB3_ALBUMS,
    LIB3_ARTISTS,
    LIB3_GENRES,
    album3ById,
    didl3Album,
    didl3AllAlbums,
    didl3Artist,
    didl3AllArtists,
    didl3Track,
    track3Meta,
    cd3Children,
    cd3Metadata,
    DESCRIPTION3_XML,
    cd2Children,
    cd2Metadata,
    albumById,
    didlTrack,
    ARTIST_COUNT,
    artistName,
    didlLooseTrack,
    SINGLES,
    cdChildren,
    cdMetadata,
    DESCRIPTION_XML,
    DESCRIPTION2_XML,
  };
}
