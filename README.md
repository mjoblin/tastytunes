<div align="center">

<img src="build/icon.png" width="120" alt="TastyTunes icon">

# TastyTunes

**A desktop controller for Cambridge Audio StreamMagic streamers.**

<a href="https://github.com/mjoblin/tastytunes/releases/latest"><img src="https://img.shields.io/github/v/release/mjoblin/tastytunes?style=flat-square&color=d9a520&label=release" alt="Latest release"></a>
<img src="https://img.shields.io/badge/platform-macOS%20·%20Windows%20·%20Linux-555555?style=flat-square" alt="macOS, Windows, Linux">
<img src="https://img.shields.io/badge/MCP%20server-built--in-d9a520?style=flat-square" alt="Built-in MCP server">
<a href="LICENSE"><img src="https://img.shields.io/badge/license-GPLv3-555555?style=flat-square" alt="GPLv3 license"></a>

</div>

<br>

<p align="center">
  <img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/now-playing.webp" alt="TastyTunes Now Playing: album art over an ambient backdrop, format badges, and the current lyric line">
</p>

TastyTunes shows what's playing on the streamer with full artwork and synced
lyrics, browses every local media server and the streamer's USB drive as a
single library, searches all of it, tunes internet radio, and edits the queue
and the streamer's 99 presets.

It also supports playlists and favorites, a listening history, artist and album
notes, tone and EQ, a menu bar / system tray panel, a mini player, a
Fullscreen Display mode with visualizer scenes, sleep timers and schedules,
scrobbling to ListenBrainz, and an optional MCP server for local AI agents.

It all runs on your computer and connects to the streamer over your local
network. There's no account and no cloud service required.

## Installing

1. Get the installer for your platform from the
   [releases page](https://github.com/mjoblin/tastytunes/releases/latest):
   macOS 12+ (universal, signed and notarized), Windows 10+ (x64 & arm64,
   one signed installer), Linux (x64 or arm64 AppImage).
2. Launch it. TastyTunes discovers StreamMagic streamers on your network; if
   discovery comes up empty, enter the streamer's IP directly.
3. There's nothing else to configure.

Without a streamer on the network, demo mode on the connect screen runs the
whole app against a built-in virtual one with sample music libraries.

You'll need a Cambridge Audio network player built on the StreamMagic
platform, on the same network as your computer: Evo 75/150, CXN100 /
CXN (V2), MXN10, AXN10, EXN100, Edge NQ, 851N. Developed and tested daily
against an Evo 150.

## Screenshots

### Now Playing

Album art, track details, format badges and the current lyric line. The transport bar is at the bottom of every screen.

### Audio analysis

For music on your local media servers, TastyTunes reads the audio file and shows its waveform under the artwork and in the seek bar (both optional, in Settings › Appearance), with the track's dynamic range beside the format badges. Once analyzed, an album's dynamic range becomes a filter and is sortable in the Library.

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/audio-analysis-detail.webp" alt="Now Playing with the waveform under the album art and the dynamic range beside the format badges" width="640">

### The library as one collection

Local media servers and the streamer's USB drive, combined into Artists, Albums and Tracks views, with genre, decade, format, and dynamic range filters.

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/lens-albums.webp" alt="The Albums view combining every library into one collection">

#### Artists and Tracks views

The Artists view shows your artists, the selected artist's albums, and the selected album's tracks. The Tracks view lists every track in every library and can be filtered by decade, genre, format, and dynamic range, and the filtered list can be played as a whole.

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/lens-artists.webp" alt="The Artists view with an artist selected, their albums in the middle column and the tracks of one album on the right">

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/lens-tracks.webp" alt="The Tracks view filtered by decade and dynamic range">

### Search everything

Search your libraries, playlists, favorites, presets, and internet radio at once, with the results grouped by type.

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/search.webp" alt="Search results grouped by type">

### Synced lyrics

The current line is highlighted and kept in view. Click a line to seek there.

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/lyrics.webp" alt="Lyrics panel with the current line highlighted">

### Liner notes

View a short biography of the artist, the album's year, label and genres with a summary, and the track's performers, writers and production credits. The notes come from MusicBrainz and Wikipedia, with a link to each source.

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/context-panel.webp" alt="The Liner notes panel showing the album's year, genres, summary and source links" width="380">

### Presets

The streamer's presets as a card grid or table rows. A preset is recalled with a click, at the volume saved with it, and the playing preset is highlighted.

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/presets.webp" alt="The Presets grid with the playing preset lit">

### Fullscreen Display mode

Press <kbd>F</kbd> to fill the screen with the album art or a scene, track details, the current lyric line and a clock.

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/display.webp" alt="Fullscreen display mode showing album art and the current lyric line">

### Scenes

Visualizer scenes created from the track's audio analysis and lyrics: its loudness, beats, drum hits, drops, and lyrics. A scene takes the album art's place on Now Playing, or fills the screen in Fullscreen Display mode. Select one, or Shuffle for a different scene on every track. Hi-Fi and Turntable show for every source; the other scenes need local media, and show the album art for AirPlay, internet radio and other sources.

<table>
  <tr>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/sleeve.webp" alt="The Sleeve scene"><br><sub>Sleeve</sub></td>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/pit.webp" alt="The Ball Pit scene"><br><sub>Ball Pit</sub></td>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/survey.webp" alt="The Contour scene"><br><sub>Contour</sub></td>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/panel.webp" alt="The Hi-Fi scene"><br><sub>Hi-Fi</sub></td>
  </tr>
  <tr>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/confluence.webp" alt="The Ink scene"><br><sub>Ink</sub></td>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/orbit.webp" alt="The Orbit scene"><br><sub>Orbit</sub></td>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/roll.webp" alt="The Piano Roll scene"><br><sub>Piano Roll</sub></td>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/refrain.webp" alt="The Refrain scene"><br><sub>Refrain</sub></td>
  </tr>
  <tr>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/sea.webp" alt="The Sea scene"><br><sub>Sea</sub></td>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/terminal.webp" alt="The Terminal scene"><br><sub>Terminal</sub></td>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/terrain.webp" alt="The Terrain scene"><br><sub>Terrain</sub></td>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/tide.webp" alt="The Tide scene"><br><sub>Tide</sub></td>
  </tr>
  <tr>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/conduit.webp" alt="The Tunnel scene"><br><sub>Tunnel</sub></td>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/turntable.webp" alt="The Turntable scene"><br><sub>Turntable</sub></td>
    <td align="center" width="25%"><img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/scenes/type.webp" alt="The Type scene"><br><sub>Type</sub></td>
  </tr>
</table>

### Mini player

A small always-on-top window: art, transport, playhead, volume and what's next.

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/mini-player.webp" alt="Mini player window" width="360">

### Menu bar / system tray

A compact panel with many of TastyTunes' features, opened from the TastyTunes icon in the menu bar (macOS) or system tray (Windows).

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/tray-panel.webp" alt="The menu-bar panel showing now playing and the queue" width="380">

### Settings

Themes, fonts, layouts and sort orders, and much more, stored on your machine.

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/settings.webp" alt="Appearance settings">

### AI agents

MCP tools that let local AI agents see and control the streamer.

<img src="https://raw.githubusercontent.com/mjoblin/media/main/tastytunes/images/settings-agents.webp" alt="The AI agents settings tab">

## MCP server

TastyTunes can host a local MCP server (off by default), so AI agents on your
network (Claude Code, Cursor, anything that supports MCP over HTTP) can see and
control the streamer:

```bash
claude mcp add --transport http tastytunes http://127.0.0.1:8555/mcp
```

> *"what's playing?"* · *"how many albums do I have?"* · *"play a 90s rock album"* · *"put on some jazz radio"* · *"set a sleep timer for the end of this track"*

The tools cover what the app itself does: playback and volume, presets and
sources, library and radio, favorites, tone and EQ, sleep timers, the listening
record (plays, last played, what was left unfinished), audio analysis, album art,
the scenes and Display mode, etc. The editing
ones, like queue and preset changes, are kept separate and off until you
turn them on. Every tool can be enabled or disabled in Settings › AI agents.
Agents are held to the same limits as the app: the volume limit, the power
safeguards and the Connections settings. A call to a disabled tool is
refused. Bind it to localhost, or to your network to reach the streamer from
another machine. Bound to your network, it requires the token from Settings ›
AI agents. The setup for each client (Claude Code, Cursor, VS Code, Gemini CLI,
Codex CLI, Claude Desktop, ChatGPT) is at [tastytunes.app/agents](https://tastytunes.app/agents/).

### Home Assistant

Home Assistant can control the streamer through TastyTunes with a
`rest_command`. A scene or automation can then call it like any other service:

```yaml
rest_command:
  listening_room_on:
    url: "http://<machine-running-tastytunes>:8555/mcp"
    method: post
    content_type: application/json
    headers:
      Authorization: Bearer <token from Settings › AI agents>
    payload: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall_preset","arguments":{"id":3}}}'
```

Any enabled tool works the same way, such as `set_volume`, `set_power`, and
`pause`. Bind the server to your network in Settings › AI agents, enable the
tools the Home Assistant automation needs, copy the token into the
`Authorization` header, and keep TastyTunes running.

## Every feature

### Connection & devices

- Automatic discovery of streamers on the local network, with manual IP entry when discovery finds nothing
- Device switcher in the transport bar
- Reconnects automatically, including after the computer sleeps
- Power and standby
- Demo mode: runs the whole app against a built-in virtual streamer and two sample libraries

### Now Playing

- Large artwork over an ambient blurred-art backdrop
- Optional art-derived accent, with a gold tint following the current album
- Format badges: codec, sample rate, bit depth, lossless, MQA
- A signal-quality lamp: gold for hi-res lossless, blue for lossless and gray for lossy, each with its own shape so the states don't rely on color alone
- The lamp's legend is in Settings › Status lamps
- The full signal chain in a popover from the lamp
- Internet-radio display, track *x* of *y*, and the current lyric line under the track details
- Album art can be optionally replaced by a scene visualizer, selected from the scene picker
- Album art (or scene visualizer) can be resized
- Fullscreen Display mode (<kbd>F</kbd>), for a display on a desk or shelf, with the album art or a scene
- Info: what the streamer reports about the current stream (codec, sample rate, bit depth, bitrate, queue position), for any source: local media, radio, AirPlay
- The artist and album names link to the Library (local media only)
- While the streamer is in standby, Now Playing offers to pick up where you left off: the same track from the same point, the same station or the same source

### Audio analysis

- A waveform of the playing track in the seek bar and under the artwork on Now Playing (local media only). Can be disabled in Settings › Appearance (on by default)
- Dynamic range for every analyzed track and album (same as the DR database's TT-DR value), shown on Now Playing, in track rows and in album headers
- Analyze audio on any album from its menu, or on the tracks shown in the Tracks view
- Peak and loudness details under the Now Playing waveform, and a Dynamic range row in Info

### Scenes

- Fifteen scenes: Ball Pit, Contour, Hi-Fi, Ink, Orbit, Piano Roll, Refrain, Sea, Sleeve, Terminal, Terrain, Tide, Tunnel, Turntable, and Type, plus Shuffle, which selects a different scene for every track (or album)
- Hi-Fi (the lyrics on a glowing stereo display) and Turntable (the album on a turntable) show for every source, including radio and AirPlay
- Selected from a picker on the Now Playing album art or in Fullscreen Display mode
- Scenes come with an explanation of what you see and what it means, and their own settings
- Settings shared by all scenes: a simulated cathode tube finish, the corner title and clock, drop sensitivity, and a playback sync nudge
- Lyrics are optionally displayed in scenes that can show them
- The other scenes need local media: each shows once the playing track has been analyzed, and radio, AirPlay and other sources show the album art

### Library

- Browse every local UPnP media server and the streamer's own USB storage
- A local index for fast searching as you type
- <kbd>⌘F</kbd> searches every library at once, grouped by server
- Artists, Albums and Tracks views combining every library into one collection, with filters for genre, decade, format (codec, lossless, hi-res), dynamic range, and albums or compilations
- The Albums view can be shown as cards or rows
- The Artists view shows your artists, the selected artist's albums, and the selected album's tracks
- The Tracks view lists every track in every library, and the filtered list can be played as a whole
- Artist and album names in track rows link to the Library
- Albums with featured artists stay together, and compilations are listed under Various Artists
- Multi-disc albums show disc dividers, and a multi-volume set is shown as one album with a volume selector
- Album headers show the album's format and size
- Info on any album, track or artist, showing everything the local media server reports, which can be copied as JSON
- Play now, play next, append, or replace
- Select several tracks (<kbd>⌘</kbd>-click, <kbd>⇧</kbd>-click) and queue them, heart them or add them to a playlist together
- Drag tracks, or an album, onto Queue, Playlists or Favorites in the navigation panel
- Albums with no artwork on the local media server get a cover from the Cover Art Archive (can be disabled in Settings)
- Album art from local media servers that can't resize images is cached on your computer (clearable in Settings › Libraries)
- Save an album, a track, or the whole queue to one of the streamer's preset slots
- Open in Library from the queue, favorites, playlists, History, and the Info panel navigates to the track's album, with the track highlighted
- <kbd>Backspace</kbd> goes up a level
- Filters are remembered per folder
- The library index is checked for changes when the app connects and is automatically kept current

### Radio

- Search and browse the [radio-browser.info](https://www.radio-browser.info) directory, with genre and decade categories
- Stations can be favorited and saved to hardware preset slots

### Favorites

- Stations, albums and tracks, hearted from rows, cards or Now Playing
- Favorites keep working when a local media server re-indexes

### Playlists

- Ordered collections of tracks, kept on your computer, built from any track or saved from the queue
- Playlists keep working when a local media server re-indexes
- Playing a playlist replaces the queue, with its progress shown and a way to cancel
- Tracks that can't be found are listed once the playlist has loaded
- A playlist that matches the current queue is marked
- Reorder by drag or keyboard, rename, and delete with undo

### Transport & volume

- Play, pause, stop, next, previous, seek, scrub; repeat and shuffle
- Only the controls the streamer itself reports (based on source) are enabled
- Pre-amp mode (absolute volume) and Control Bus mode (nudge), mute, and an optional volume limit
- Scroll-wheel volume on the volume control and the mini player

### Queue

- View, jump, drag-to-reorder, remove, clear
- Multi-select with <kbd>⌘</kbd>-click and <kbd>⇧</kbd>-click (<kbd>⌘A</kbd> for everything): the selected tracks can be moved, removed, hearted or added to a playlist together, and a drag moves the whole selection
- Cards, rows and album-grouped layouts
- Follow mode keeps the playing track in view

### Presets

- All 99 hardware slots: recall, delete, drag-to-reorder; use keys <kbd>1</kbd>–<kbd>9</kbd> for immediate recall
- Per-preset volume: each preset can keep its own volume level, applied when it's recalled
- A preset broken by a media server re-indexing is flagged in place, and can be repaired with a click

### Tone, EQ & device

- Seven-band EQ, tilt and balance, with saveable presets (based on streamer model)
- Display brightness, standby mode, and auto power-down, where the streamer supports them

### Sources

- One-click switching across every source the streamer exposes

### CD

With Cambridge Audio's Evo CD transport (on an Evo streaming amplifier):

- The disc's tracks are listed on the Queue screen, beside the Media Library queue
- Track names come from MusicBrainz when Liner notes is on in Settings › Connections
- Now Playing shows track *x* of *y* while a disc plays

### Lyrics

- Synced lyrics from LRCLIB follow the current line
- Clicking a line seeks there
- Shown in a full panel on Now Playing, as a single line under the track details, and in Fullscreen Display mode
- Plain lyrics when synced lyrics aren't available

### Liner notes

- A short artist biography and album facts (year, label, genres, credits), from MusicBrainz and Wikipedia, with a link to each source
- Notes are cached on your computer (clearable in Settings)

### Scrobbling

- ListenBrainz: a listen is submitted after half the track or four minutes of playing
- Short tracks and radio aren't scrobbled
- Failed submissions are retried until successful

### History

- One screen (<kbd>H</kbd>) with five views: Recent, Timeline, Stats, Rediscover, and Elsewhere
- With more than one streamer, every view can be filtered to a single streamer
- Recent: the last 200 tracks and stations played (clearable), including the tracks a station announces
- Timeline: every play in the listening record, grouped into listening sessions by day, or shown play by play
- The Timeline can be filtered by source, period and listens only
- Stats for this week, this month, this year, or all time, stepping back to any earlier week, month or year: plays, listening time, the most played albums, artists and tracks, and much more
- Stats can be exported to an image on disk
- Rediscover: albums worth coming back to: started and never finished, more from the artists you play, not heard in a while, and never played
- Elsewhere: the artists you heard away from the library, through AirPlay, a cast or a streaming service, or on internet radio, with whether your library includes them; a row opens to the tracks heard and, with Liner notes on, the artist's summary
- Listening record: a log of what plays and for how long (local media, radio, AirPlay, and other sources), kept on your computer in plain JSON Lines files, one per year
- A play is recorded once it ends, if it played for at least 30 seconds
- The listening record can be exported, cleared or disabled in Settings › History (on by default)
- Its file format is documented at [tastytunes.app/listening-record](https://tastytunes.app/listening-record/)
- AI agents can read the listening record through the MCP server's history tools: what played, when, and for how long, including "on this day"

### Automation

- Sleep timer: 15 minutes to 2 hours, or end of track, then pause or standby, with an optional volume fade-out (pre-amp mode)
- Schedules: wake the streamer to a preset at a chosen volume, fading in, or send it to standby, per weekday (schedules only trigger while the app is running)
- A wake schedule missed while the computer was asleep is offered when the computer wakes, instead of running late

### Menu bar / system tray

- An optional icon in the menu bar (macOS) or system tray (Windows, Linux), on by default, can be disabled in Settings
- On macOS and Windows, clicking the icon opens a compact panel: now playing with transport and volume, plus queue, presets, playlists and Recent
- On Windows and Linux, closing the main window keeps TastyTunes running in the tray; Quit is in the icon's menu
- On Linux there's no panel, just the icon and its menu

### Windows & control

- Mini player: frameless, always on top, remembers its position
- Command palette (<kbd>⌘K</kbd>): transport, sources, presets by name, screens, and much more
- Keyboard controls throughout: single keys open specific screens, <kbd>space</kbd> toggles play, arrows seek and nudge volume, <kbd>/</kbd> filters lists; <kbd>?</kbd> shows the controls overlay
- Back and forward through everywhere you've been, like a browser: <kbd>⌘←</kbd>/<kbd>⌘→</kbd> (Alt+arrows on Windows and Linux), the mouse side buttons, or View › Back/Forward, which also works from inside a text box (<kbd>⌘[</kbd>/<kbd>⌘]</kbd> on macOS)
- Scroll positions are remembered in the Library, Search and Playlists
- Every reorderable list (queue, presets, playlists, the navigation panel) can be reordered by keyboard as well as by drag
- Keyboard focus is shown with a visible ring
- Notices are announced to screen readers
- Undo for queue edits, favorites, playlist additions and schedule deletions, from the notice that follows each change
- OS media keys
- A track-change notification with artwork when the window isn't focused

### Appearance

- Dark and light themes
- Reduced motion: on, off, or follow the system setting
- Card size, cards or rows per screen, and resizable side panels
- The navigation panel can be reordered, and screens hidden from it

### Transparency

- A requests console (<kbd>`</kbd>) listing every outbound request the app makes: service, method, status, timing
- A SMOIP console showing the raw streamer traffic

### Updates & packaging

- An update is downloaded only when you click Download, and installed when you click Restart
- Signed and notarized universal macOS builds (Intel and Apple Silicon); one signed Windows installer covering x64 and arm64 (native on Windows-on-ARM); Linux AppImages for x64 and arm64, including 64-bit Raspberry Pi OS

## What leaves your machine

The complete list:

| Traffic | Where it goes | When |
|---|---|---|
| Streamer control | your streamer, on your LAN | always (it's the app) |
| Library browsing | your media servers, on your LAN | always (it's the app) |
| Lyrics | lrclib.net | on by default; toggleable |
| Liner notes | musicbrainz.org · wikidata.org · wikipedia.org | on by default; toggleable |
| Missing album art | musicbrainz.org · coverartarchive.org | on by default; toggleable |
| Radio directory | radio-browser.info | when you search or browse Radio |
| Station logos | each station's own website or image host | when a station is shown |
| Update check | github.com | on by default; toggleable |
| Scrobbles | listenbrainz.org | off until you add your token |

No analytics, no telemetry, no accounts, and no radio "click" pings (the radio
directory sees your searches, but not which station you played). Each row of
Settings › Connections states what its service is sent, and the requests console
shows the traffic live.

## Development

```bash
npm install
npm run dev        # run with HMR
npm run typecheck  # typecheck main + preload + renderer
npm run check      # typecheck, lint (ESLint) and format check (Prettier); what CI runs
npm run format     # format the source with Prettier
npm run build      # bundle to out/
npm run dist:mac   # package a dmg (also: dist:win, dist:linux)
```

Development happens on the `develop` branch; `main` tracks the latest
release. Pull requests should target `develop`.

Stack: Electron + electron-vite, React 19, TypeScript, Tailwind CSS v4,
Zustand, `ws` in the main process for the streamer socket.

- `src/main/` is where device I/O lives: SSDP discovery, the SMOIP WebSocket
  client (with the `Origin` header the streamer requires),
  reconnect/keepalive, command dispatch, the UPnP browser and library index,
  the MCP server, the scheduler and sleep timer, external-service fetchers,
  and the typed IPC push relay.
- `src/preload/` is the `window.tastytunes` bridge.
- `src/renderer/` is the React UI; a Zustand store fed exclusively by pushed state.
- `src/shared/` holds the SMOIP payload types and the IPC contract.

The streamer is the single source of truth: user actions send commands, the
streamer applies them and pushes new state, and the UI re-renders from the
push. Live state arrives over the streamer's SMOIP WebSocket
(`ws://<host>:80/smoip`); commands go over the same socket, with a couple of
queue/preset edits over SMOIP HTTP.

## Support

TastyTunes is free. If it's been worth something to you, there's a
name-your-price tip jar at [tastytunes.app](https://tastytunes.app/#support).
For help (bugs, questions, requests) use
[GitHub issues](https://github.com/mjoblin/tastytunes/issues) or the TastyTunes
[contact form](https://tastytunes.app/help/).

## License

TastyTunes is free software, released under the
[GNU General Public License v3.0](LICENSE).

© 2026 [Redacted Cat](https://redactedcat.com)
