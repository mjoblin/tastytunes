// The MCP tool catalog — every cluster and tool the MCP server can expose.
//
// Split out of ipc.ts 2026-07-26, where its ~490 lines of prose descriptions
// were most of the file. SHARED ON PURPOSE: the Settings screen renders these
// clusters and the server registers from them, so the two cannot drift about
// what exists or what it is called. Schemas and handlers live in
// main/servers/mcpServer.ts; enable/disable state lives in settings.mcp.
//
// Adding a tool = add it here AND implement it in mcpServer.ts. A cluster whose
// tools change saved things gets `optIn: true` and stays off until the user
// says otherwise.

import type { McpSettings } from "./model";

export interface McpToolInfo {
  name: string;
  title: string;
  /** Written for the agent reading tools/list — precise beats promotional. */
  description: string;
}

export interface McpClusterInfo {
  id: string;
  title: string;
  /** Written for the human toggling clusters in Settings. */
  description: string;
  readOnly?: boolean;
  /** Settings-UI grouping: read = look-never-touch, control = transient
   *  actions, write = persists changes (queue order, preset slots). */
  group: "read" | "control" | "write";
  /** Off until the user explicitly enables it (mcp.enabledClusters) — for
   *  clusters whose tools change saved things. */
  optIn?: boolean;
  tools: McpToolInfo[];
}

/** Effective cluster gate — shared by the server and the Settings screen.
 *  Opt-in clusters require an explicit enable; everything else is on unless
 *  disabled. */
export function mcpClusterEnabled(c: McpClusterInfo, mcp: McpSettings): boolean {
  return c.optIn === true
    ? (mcp.enabledClusters ?? []).includes(c.id)
    : !mcp.disabledClusters.includes(c.id);
}

/**
 * Everything the MCP server can expose — shared so the Settings screen and the
 * server agree exactly. Schemas and handlers live in main (mcpServer.ts);
 * enable/disable state lives in settings.mcp.
 */
export const MCP_CLUSTERS: McpClusterInfo[] = [
  {
    id: "status",
    group: "read",
    title: "Status & lists",
    description: "Read-only: what's playing, the queue, presets, sources, devices, history.",
    readOnly: true,
    tools: [
      {
        name: "get_status",
        title: "Get status",
        description:
          "One combined snapshot: connection and device, power state, active source, what's playing (title/artist/album/station, format, position/duration), volume and mute, shuffle/repeat, queue position, and any armed sleep timer. Call this first.",
      },
      {
        name: "list_queue",
        title: "List queue",
        description:
          "The play queue: id, position, title, artist, album, and duration per track, plus which id is current.",
      },
      {
        name: "list_presets",
        title: "List presets",
        description:
          "The device presets (numbered slots for stations and albums): id, name, kind, and whether one is currently playing.",
      },
      {
        name: "list_sources",
        title: "List sources",
        description:
          "Audio sources (media player, internet radio, USB, Bluetooth, …) and which is active.",
      },
      {
        name: "list_devices",
        title: "List devices",
        description: "StreamMagic streamers known on the network and which one is connected.",
      },
      {
        name: "list_recently_played",
        title: "List recently played",
        description: "Local history of tracks and stations that have played, newest first.",
      },
      {
        name: "list_schedules",
        title: "List schedules",
        description:
          "The user's wake/standby schedules (alarms): time, days, action, enabled. Note: schedules fire only while TastyTunes is running and connected.",
      },
    ],
  },
  {
    id: "transport",
    group: "control",
    title: "Transport",
    description: "Play, pause, skip, seek, queue jumps, shuffle and repeat.",
    tools: [
      { name: "play", title: "Play", description: "Start or resume playback." },
      { name: "pause", title: "Pause", description: "Pause playback." },
      { name: "stop", title: "Stop", description: "Stop playback (mainly internet radio)." },
      { name: "next_track", title: "Next track", description: "Skip to the next track." },
      {
        name: "previous_track",
        title: "Previous track",
        description: "Go back to the previous track.",
      },
      {
        name: "seek",
        title: "Seek",
        description: "Jump to a position (seconds) in the current track.",
      },
      {
        name: "play_queue_item",
        title: "Play queue item",
        description: "Jump to a specific track in the queue by its id (see list_queue).",
      },
      { name: "set_shuffle", title: "Set shuffle", description: "Turn shuffle on or off." },
      { name: "set_repeat", title: "Set repeat", description: "Turn repeat-all on or off." },
    ],
  },
  {
    id: "volume",
    group: "control",
    title: "Volume",
    description: "Absolute volume, relative nudges, and mute.",
    tools: [
      {
        name: "set_volume",
        title: "Set volume",
        description:
          "Set volume to an absolute percent (0–100). Respects the volume limit configured in the app.",
      },
      {
        name: "change_volume",
        title: "Change volume",
        description: "Nudge volume up or down by a number of steps (positive or negative).",
      },
      { name: "set_mute", title: "Set mute", description: "Mute or unmute." },
    ],
  },
  {
    id: "presets",
    group: "control",
    title: "Presets",
    description: "Recall a numbered preset (station or album).",
    tools: [
      {
        name: "recall_preset",
        title: "Recall preset",
        description: "Recall a preset by its id (see list_presets for names).",
      },
    ],
  },
  {
    id: "sources",
    group: "control",
    title: "Sources",
    description: "Switch the active audio source.",
    tools: [
      {
        name: "set_source",
        title: "Set source",
        description: "Switch to a source by its id (see list_sources).",
      },
    ],
  },
  {
    id: "power",
    group: "control",
    title: "Power",
    description: "Wake the streamer or send it to network standby.",
    tools: [
      {
        name: "set_power",
        title: "Set power",
        description:
          "'on' wakes the streamer; 'standby' stops playback and puts it into network standby (it stays reachable).",
      },
    ],
  },
  {
    id: "devices",
    group: "control",
    title: "Devices",
    description: "Switch which streamer the app controls.",
    tools: [
      {
        name: "connect_device",
        title: "Connect device",
        description: "Connect to a different streamer by host/IP (see list_devices).",
      },
    ],
  },
  {
    id: "sleep",
    group: "control",
    title: "Sleep timer",
    description: "Arm or cancel the sleep timer.",
    tools: [
      {
        name: "set_sleep_timer",
        title: "Set sleep timer",
        description:
          "Arm the sleep timer: either minutes from now, or at the end of the current track. Action is 'pause' or 'standby' (defaults to the user's configured choice).",
      },
      {
        name: "cancel_sleep_timer",
        title: "Cancel sleep timer",
        description: "Clear any armed sleep timer.",
      },
    ],
  },
  {
    id: "library",
    title: "Library",
    group: "control",
    description: "Search the media servers and play albums or tracks.",
    tools: [
      {
        name: "list_media_servers",
        title: "List media servers",
        description:
          'UPnP media servers the streamer can play from. Per server: `searchable` = answers LIVE UPnP searches, `index_ready` = TastyTunes holds a local index (search_library and list_albums work with either/the latter). Ready indexes include library counts — sum `index.albums` across servers for questions like "how many albums do I have".',
      },
      {
        name: "rebuild_library_index",
        title: "Rebuild library index",
        description:
          "Build or rebuild TastyTunes' local index for one media server, then report the result. Needed for Browse-only servers (a streamer's USB drive is the usual case) — those never index themselves, so until this runs they answer no searches at all and list_media_servers shows index_ready false. Searchable servers refresh on their own; use this only to force one. Reads the server, writes nothing to it.",
      },
      {
        name: "search_library",
        title: "Search library",
        description:
          "Search for albums, artists, and tracks across every searchable or index-ready media server at once (or one server_udn). Returns object ids for play_media, a TRUE total, and pages with limit/offset — page again rather than assuming the first page is everything. match: 'title' scopes to items whose own title contains the query. Composers are searchable too (\"bangalter\" finds the tracks he wrote); indexed tracks carry album_artist, performers, composers and format when the server sends them.",
      },
      {
        name: "list_albums",
        title: "List albums",
        description:
          "Browse albums from the local library index — filter by artist, genre, decade, kind (albums vs compilations), hires, format (e.g. '24/96', 'MP3') or composer; sort by title, artist, or year; page with limit/offset. Each album comes with what its tracks add up to: track count, discs, runtime, size, format headline (and how many tracks differ), hires, composers (when every track agrees), is_compilation. Returns object ids for play_media / get_media_info. Needs a ready index (see list_media_servers).",
      },
      {
        name: "list_artists",
        title: "List artists",
        description:
          "Artists from the local library index with album and track counts — filter by name, sort by name or album count, page with limit/offset. role 'performers' (default) counts album artists and every performer, featured guests included; role 'composers' lists who wrote the tracks. Needs a ready index (see list_media_servers).",
      },
      {
        name: "list_tracks",
        title: "List tracks",
        description:
          "Every indexed track as one list, filtered by artist, album, genre, decade, format, lossless, hi-res or minimum dynamic range (DR), sorted by title, artist, album, year, duration, DR, plays or last played. Each row carries its play count and last-played time from the listening record when known. The app's Tracks view as a tool.",
      },
      {
        name: "get_track_analysis",
        title: "Get track analysis",
        description:
          "The audio analysis TastyTunes has for a track (the playing track by default): dynamic range (DR, the TT-DR procedure), peak, RMS and crest in dB, plus the album's DR when the whole album has been analyzed. Says so when a track has not been analyzed yet.",
      },
      {
        name: "get_media_info",
        title: "Get media info",
        description:
          "Everything the local index knows about one album, track or artist by server_udn + object id — the app's Info panel as a tool: performers, album artist, composers, year, genres, track/disc numbers, duration, format (codec, bit depth, sample rate, bitrate, size), server and object ids, art URL. An album also gets its tracks summed (count, discs, runtime, size, format, composers, compilation) and its full track list; an artist gets their library page (albums with year/format, track count, guest appearances, composer credits, genres, active years). Read-only, index-backed.",
      },
      {
        name: "play_media",
        title: "Play media",
        description:
          "Play an album or track by server_udn + object id (from search_library). mode 'play_now' (default) keeps the queue, 'play_next'/'append' insert into it; 'replace' CLEARS the queue first — only use replace when asked to.",
      },
    ],
  },
  {
    id: "radio",
    title: "Radio",
    group: "control",
    description:
      "Search internet radio (the keyless radio-browser.info directory) and play stations. No listening data is ever reported back.",
    tools: [
      {
        name: "search_radio",
        title: "Search radio",
        description:
          "Find internet-radio stations by name (query) and/or style (genre — queried against the directory's tags, the right way to ask for 'some jazz'). Returns name, stream URL, country, codec, tags.",
      },
      {
        name: "play_radio",
        title: "Play radio",
        description:
          "Play an internet-radio stream by URL and display name (from search_radio or a station favorite).",
      },
    ],
  },
  {
    id: "favorites",
    title: "Favorites",
    group: "control",
    description:
      "List, play, add to, and remove from the user's favorites (stations, albums, tracks).",
    tools: [
      {
        name: "list_favorites",
        title: "List favorites",
        description: "The user's favorites with the keys play_favorite needs.",
      },
      {
        name: "play_favorite",
        title: "Play favorite",
        description:
          "Play a favorite by its key (see list_favorites). Albums and tracks are found by content — a stale library id heals via search.",
      },
      {
        name: "add_favorite",
        title: "Add favorite",
        description:
          "With no arguments, favorite the currently playing track. For an internet-radio station, pass station_url + station_name (e.g. from search_radio).",
      },
      {
        name: "remove_favorite",
        title: "Remove favorite",
        description: "Remove a favorite by its key (see list_favorites).",
      },
    ],
  },
  {
    id: "playlists",
    title: "Playlists",
    group: "control",
    description:
      "The user's stored playlists (local to the app, not the streamer) — list them and load one into the play queue.",
    tools: [
      {
        name: "list_playlists",
        title: "List playlists",
        description:
          "Stored playlists with their id, track count, runtime, and when each was last played.",
      },
      {
        name: "get_playlist",
        title: "Get playlist",
        description: "The tracks in one playlist, in order.",
      },
      {
        name: "play_playlist",
        title: "Play playlist",
        description:
          "Replace the play queue with a playlist's tracks. Slow by nature — the streamer takes entries one at a time — and a track no longer on any media server is reported rather than failing the run.",
      },
    ],
  },
  {
    id: "history",
    title: "Listening history",
    group: "read",
    description:
      "Read the local listening record: what played, when, and for how long. What an agent can read is data that reaches that agent's model.",
    tools: [
      {
        name: "list_history",
        title: "List history",
        description:
          "Events from the listening record, newest first, filtered by date range and kind. A play's listen flag is derived: half the track or four minutes of real play time.",
      },
      {
        name: "history_top",
        title: "Top played",
        description:
          "Most-listened artists, albums or tracks over a date range, counting library plays that reached half the track or four minutes of real play time.",
      },
      {
        name: "history_on_this_day",
        title: "On this day",
        description:
          "Plays from one calendar day across every year of the record, using the local day as it was recorded.",
      },
      {
        name: "history_first_listen",
        title: "First listen",
        description: "When a track was first played, and when it first reached a full listen.",
      },
      {
        name: "history_stats",
        title: "History stats",
        description:
          "Plays, listens, last played and time heard for one track (the playing track by default) or, given only an album, for the whole album — from the listening record, library plays only.",
      },
      {
        name: "history_unplayed",
        title: "Unplayed albums",
        description:
          "Albums in the library with no recorded play since the listening record began (the record's start date is included). Filter by artist, genre or decade.",
      },
      {
        name: "history_rediscover",
        title: "Rediscover",
        description:
          "Albums that HAVE been played but not since a date (default: 90 days ago), longest-unheard first, with their play counts — the 'not heard since spring' list.",
      },
    ],
  },
  {
    id: "playlistedit",
    title: "Playlist editing",
    group: "write",
    optIn: true,
    description:
      "Create playlists, add the playing track to one, and delete them. These write the user's own stored collection.",
    tools: [
      {
        name: "create_playlist",
        title: "Create playlist",
        description:
          "Create a playlist, optionally seeded with the current play queue (from_queue: true).",
      },
      {
        name: "add_to_playlist",
        title: "Add to playlist",
        description:
          "Add the currently playing track to a playlist by id (see list_playlists). Tracks only — a radio stream can't hold a position in an ordered list.",
      },
      {
        name: "delete_playlist",
        title: "Delete playlist",
        description: "Delete a playlist by id. No undo.",
      },
    ],
  },
  {
    id: "audio",
    title: "Tone & EQ",
    group: "control",
    description:
      "Read and shape the sound: 7-band EQ, tone tilt, balance. Only offered on streamers whose firmware has tone controls; every change is a device setting the user can see and undo on the Device screen.",
    tools: [
      {
        name: "get_audio_settings",
        title: "Get audio settings",
        description:
          "Current EQ band gains, tilt, and balance, plus the allowed ranges. Errors on streamers without tone controls.",
      },
      {
        name: "set_eq_band",
        title: "Set EQ band",
        description:
          "Set one EQ band gain in dB (band index 0–6, low to high frequency; gains clamp to −6..+3). Enables the user EQ when needed.",
      },
      {
        name: "set_tilt",
        title: "Set tone tilt",
        description:
          "Set the tone-tilt intensity (negative = warmer/darker, positive = brighter; range from get_audio_settings). Enables tilt when needed.",
      },
      {
        name: "set_balance",
        title: "Set balance",
        description:
          "Left/right balance (negative = left, positive = right; range from get_audio_settings).",
      },
      {
        name: "apply_eq_preset",
        title: "Apply EQ preset",
        description:
          "Apply one of the user's saved EQ presets by name (get_audio_settings lists them).",
      },
      {
        name: "reset_eq",
        title: "Reset EQ",
        description: "Set all 7 EQ bands back to 0 dB — the same as the Flat button in the app.",
      },
    ],
  },
  {
    id: "display",
    title: "Display",
    group: "control",
    description: "The streamer's front-panel display brightness (models that have a display).",
    tools: [
      {
        name: "set_display_brightness",
        title: "Set display brightness",
        description:
          "Front-panel brightness: 'off', 'dim', or 'bright'. Errors on headless models.",
      },
    ],
  },
  {
    id: "lookups",
    title: "Lookups",
    group: "read",
    readOnly: true,
    description:
      "Lyrics and artist/album context for what's playing. These call the same services as the app's own panels and obey the Connections toggles; while a toggle is off, the matching tool refuses (off means no requests will be sent).",
    tools: [
      {
        name: "get_lyrics",
        title: "Get lyrics",
        description:
          "Lyrics for the currently playing track via LRCLIB. Refuses when the user has lyrics disabled in Settings → Connections.",
      },
      {
        name: "get_artist_info",
        title: "Get artist info",
        description:
          "Artist bio via MusicBrainz + Wikipedia — the current artist by default, or a named one. Refuses when the user has artist context disabled in Settings → Connections.",
      },
      {
        name: "get_album_info",
        title: "Get album info",
        description:
          "Album facts via MusicBrainz + Wikipedia — year, label, genres, credits, summary. The playing album by default, or a named artist + album. Refuses when the user has artist & album context disabled in Settings → Connections.",
      },
    ],
  },
  {
    id: "queueedit",
    title: "Queue editing",
    group: "write",
    optIn: true,
    description:
      "Remove or reorder tracks in the play queue. Removals are immediate and there is no undo.",
    tools: [
      {
        name: "remove_queue_item",
        title: "Remove queue item",
        description: "Remove one track from the queue by its id (see list_queue). No undo.",
      },
      {
        name: "move_queue_item",
        title: "Move queue item",
        description: "Move a queue track (by id) to a new position (0-based; see list_queue).",
      },
      {
        name: "clear_queue",
        title: "Clear queue",
        description: "Remove every item from the play queue (the streamer's clear-all).",
      },
    ],
  },
  {
    id: "presetsave",
    title: "Preset saving",
    group: "write",
    optIn: true,
    description:
      "Save the queue or the current playback into numbered preset slots. A slot that already holds a preset is only replaced when the tool call says overwrite explicitly.",
    tools: [
      {
        name: "save_queue_as_preset",
        title: "Save queue as preset",
        description:
          "Snapshot the whole queue into a preset slot (1–99) with a name. If the slot is occupied the call fails unless overwrite is true — always check list_presets first.",
      },
      {
        name: "repair_preset",
        title: "Repair preset",
        description:
          "Re-point a preset at content its media server no longer resolves. A preset whose stored object id has gone stale (the server re-mints ids on a rescan) is ACCEPTED by the streamer and then silently ignored — it simply will not play, with no error anywhere. The artwork survives that churn, so this matches the preset's art against the library index and writes the album's CURRENT id back into the same slot. Fails rather than guessing when the artwork matches no album, or more than one. Media presets only: radio presets have no index to match against.",
      },
      {
        name: "save_playing_to_preset",
        title: "Save playing to preset",
        description:
          "Save the CURRENT playback (a station, or a single track) to a preset slot (1–99); optional name. Occupied slots need overwrite: true. For whole albums or queues use save_queue_as_preset.",
      },
    ],
  },
  {
    id: "schedules",
    title: "Schedules",
    group: "write",
    optIn: true,
    description:
      "Create, toggle, and delete wake/standby schedules (alarms). These are standing actions that fire on their own later. Reading schedules needs no opt-in (list_schedules, under Status & lists).",
    tools: [
      {
        name: "create_schedule",
        title: "Create schedule",
        description:
          "Add a schedule: time (24h HH:MM), days of the week, and wake (power on, optionally recall a preset and set a volume) or standby. Fires only while TastyTunes is running and connected.",
      },
      {
        name: "set_schedule_enabled",
        title: "Enable/disable schedule",
        description: "Arm or disarm one schedule by id (see list_schedules) without deleting it.",
      },
      {
        name: "delete_schedule",
        title: "Delete schedule",
        description: "Delete one schedule by id (see list_schedules). No undo.",
      },
    ],
  },
];
