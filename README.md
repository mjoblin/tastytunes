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
  <img src=".github/assets/now-playing.png" alt="TastyTunes Now Playing — album art over an ambient backdrop, format badges, and the current lyric line">
</p>

TastyTunes talks straight to the streamer. No backend, no database, no
account, no cloud — the app opens the SMOIP WebSocket the streamer already
serves, sends commands down it, and re-renders from the state the streamer
pushes back. The device is the single source of truth.

It's the bigger, tastier sibling of [PunyTunes](https://punytunes.app) — same
streamers, same author, but a full desktop app in place of a tray applet: a
library with its own search, queue and preset editing, synced lyrics, alarms,
scrobbling, a mini player, and an MCP server for local AI agents.

## The tour

<table>
  <tr>
    <td width="50%">
      <img src=".github/assets/lens-albums.png" alt="The Albums lens pooling every library into one collection">
      <p align="center"><b>The library, as one collection</b><br><sub>UPnP servers and the streamer's USB drive, pooled into Artists and Albums views with genre and decade filters.</sub></p>
    </td>
    <td width="50%">
      <img src=".github/assets/search.png" alt="Cross-server search with results grouped by server">
      <p align="center"><b>Search every library at once</b><br><sub>⌘F, type, results grouped by where they live — answered from a local index.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src=".github/assets/lyrics.png" alt="Lyrics panel with the current line highlighted">
      <p align="center"><b>Synced lyrics</b><br><sub>The current line is highlighted and kept centered. Click a line to seek there.</sub></p>
    </td>
    <td width="50%">
      <img src=".github/assets/mini-player.png" alt="Mini player window">
      <p align="center"><b>Mini player</b><br><sub>A small always-on-top window: art, transport, playhead, volume, what's next.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src=".github/assets/settings.png" alt="Appearance settings">
      <p align="center"><b>Settings</b><br><sub>Themes, fonts, layouts, sort orders — all stored on your machine, not an account.</sub></p>
    </td>
    <td width="50%">
      <img src=".github/assets/settings-agents.png" alt="The AI agents settings tab">
      <p align="center"><b>AI agents</b><br><sub>The MCP server's per-cluster and per-tool switches. Off by default.</sub></p>
    </td>
  </tr>
</table>

## MCP server

TastyTunes can host a local MCP server (off by default), so AI agents on your
machine — Claude Code, Claude Desktop, anything that speaks MCP — can see and
control the streamer:

```bash
claude mcp add --transport http tastytunes http://127.0.0.1:8555/mcp
```

> *"what's playing?"* · *"how many albums do I have?"* · *"play a 90s rock album"* · *"put on some jazz radio"* · *"set a sleep timer for the end of this track"*

53 tools across 17 clusters: status, transport, volume, presets, sources,
power, devices, sleep timer, library, radio, favorites, tone & EQ, display,
and lyric/context lookups, plus opt-in clusters for queue editing, preset
saving, and schedules. Every cluster and every tool can be switched off in
Settings → AI agents, taking effect on the agent's next call; the
edit-capable clusters are off until you enable them. Bind to localhost, or to
the LAN to control the streamer from another machine. Agents get the same
limits as the UI: the volume cap, the power-on reboot guard, and the
Connections toggles — a lookup that's switched off refuses.

## Every feature

### Connection & devices

- UPnP/SSDP discovery, with a manual-IP fallback for shy networks
- Device switcher in the playback bar
- Auto-reconnect with backoff, and connection health checks after system sleep
- Power and standby, with a guard that never re-sends ON to a unit that's already on
- Demo mode — run the whole app against a built-in virtual streamer, no hardware needed

### Now Playing

- Large artwork over an ambient blurred-art backdrop
- Optional art-derived accent — the gold tint follows the current album
- Format badges: codec, sample rate, bit depth, lossless, MQA
- Signal-quality lamp — amber for hi-res lossless, green for lossless, gray for lossy — with the full signal chain in a popover
- Internet-radio display, track *x* of *y*, and the current lyric line under the track details
- Display mode (<kbd>F</kbd>): chrome-free full screen for a desk or shelf display

### Library

- Browse every UPnP media server and the streamer's own USB storage
- A local, rebuildable index: search as you type, and <kbd>⌘F</kbd> searches every library at once, grouped by server
- Artists & Albums views pooling all sources into one collection, with genre and decade filters and sorts
- Play now, play next, append, or replace; a bare click never adds a track that's already queued
- Save any album — or the whole queue — to the streamer's hardware presets
- Browser-style navigation: <kbd>⌘←</kbd>/<kbd>⌘→</kbd>, Backspace, mouse back button; per-folder filters and scroll memory

### Radio

- Search and browse the keyless [radio-browser.info](https://www.radio-browser.info) directory, with genre and decade categories
- Stations can be favorited and saved to hardware preset slots

### Favorites

- Stations, albums, and tracks, hearted from rows, cards, or Now Playing
- Keyed on content identity, so favorites survive media-server id churn

### Transport & volume

- Play, pause, stop, next, previous, seek, scrub; repeat and shuffle
- Capability-gated: only the controls the streamer itself reports are offered
- Pre-amp mode (absolute volume) and Control Bus mode (nudge), mute, and an optional volume limit
- Scroll-wheel volume on the volume cluster and the mini player

### Queue

- View, jump, drag-to-reorder, remove, clear
- Cards ⇄ rows layouts; follow mode keeps the playing track in view

### Presets

- All 99 hardware slots: recall, delete, drag-to-reorder; keys <kbd>1</kbd>–<kbd>9</kbd> recall directly
- Per-preset volume: a preset can carry its own level, applied on every recall, remembered per device

### Tone, EQ & device

- Seven-band EQ, tilt, and balance — live device writes while dragging, with saveable presets (feature-detected per model)
- Display brightness, standby mode, and auto power-down, probed from the device's own capabilities

### Sources

- One-click switching across every source the streamer exposes

### Lyrics

- Fetched from LRCLIB; synced lyrics highlight the live line, auto-center it, and click-to-seek
- Three flavors: a full panel, an inline line under the track details, and a display-mode strip
- Plain-text fallback, instrumental- and radio-aware states, force-refresh

### Artist & album context

- A short artist bio and album facts (year, label, genres, credits) in a side panel — MusicBrainz → Wikipedia, with attribution links
- Lookups cache to disk (bounded, clearable in Settings)

### Scrobbling

- ListenBrainz: a listen submits only after real played time — half the track or four minutes
- Pauses don't count, seeks can't cheat; short tracks and radio never scrobble
- Failed submissions queue and flush with the next success

### History

- Recently played: a bounded local log (200 entries, clearable) of tracks and stations — kept because the streamer itself keeps no history

### Automation

- Sleep timer: 15 minutes to 2 hours, or end of track; pause or standby; owned by the main process, so it survives a closed window and a system sleep
- Schedules: wake the streamer to a preset at a chosen volume, or send it to standby, per weekday (schedules fire while the app is running)

### Windows & control

- Mini player: frameless, always on top, remembers its position
- Command palette (<kbd>⌘K</kbd>): transport, sources, presets by name, screens, library search, index rebuilds, devices, sleep timer, power
- Keyboard throughout — single keys jump screens, <kbd>space</kbd> toggles play, arrows seek and nudge volume, <kbd>/</kbd> filters lists; <kbd>?</kbd> shows the overlay
- OS media keys, and a track-change notification with artwork when the window isn't focused
- An application menu on macOS; an auto-hidden menu bar on Windows and Linux

### Appearance

- Dark and light themes; optional per-album accent
- Reduced motion: on, off, or follow the system setting
- Card size and grid fill, cards ⇄ rows per screen, resizable side panels

### Transparency

- A requests console (<kbd>`</kbd>) showing every outbound request the app makes — service, method, status, timing
- A SMOIP console showing the raw streamer traffic, live

### Updates & packaging

- Update check on launch and every four hours; the self-updater downloads nothing until you click Download, installs nothing until you click Restart
- Signed and notarized universal macOS builds (Intel and Apple Silicon); Windows x64; Linux AppImages for x64 and arm64, including 64-bit Raspberry Pi OS

## What leaves your machine

The complete list:

| Traffic | Where it goes | When |
|---|---|---|
| Streamer control | your streamer, on your LAN | always — it's the app |
| Library browsing | your media servers, on your LAN | always — it's the app |
| Lyrics | lrclib.net | on by default; toggleable |
| Artist & album context | musicbrainz.org · wikidata.org · wikipedia.org | on by default; toggleable |
| Radio directory | radio-browser.info | when you search or browse Radio |
| Update check | github.com | on by default; toggleable |
| Scrobbles | listenbrainz.org | off until you add your token |

No analytics, no telemetry, no accounts, and no radio "click" pings — the
directory never hears what you tuned to. Each row of Settings → Connections
says what its service is sent, and the requests console shows the traffic
live.

## Getting started

1. Get the installer for your platform from the
   [releases page](https://github.com/mjoblin/tastytunes/releases/latest):
   macOS 11+ (universal, signed and notarized), Windows 10+ (x64),
   Linux (x64 or arm64 AppImage).
2. Launch it. TastyTunes discovers StreamMagic streamers on your network; if
   discovery comes up empty, enter the streamer's IP directly.
3. There's no account and nothing else to configure.

No streamer nearby? Demo mode (on the connect screen) runs the whole app
against a built-in virtual streamer.

You'll need a Cambridge Audio network player built on the StreamMagic
platform — Evo 75/150, CXN100 / CXN (V2), MXN10, AXN10, EXN100, Edge NQ,
851N — on the same network as your computer. Developed and tested daily
against an Evo 150.

## Development

```bash
npm install
npm run dev        # run with HMR
npm run typecheck  # typecheck main + preload + renderer
npm run build      # bundle to out/
npm run dist:mac   # package a dmg (also: dist:win, dist:linux)
```

Stack: Electron + electron-vite, React 19, TypeScript, Tailwind CSS v4,
Zustand, `ws` in the main process for the streamer socket.

- `src/main/` — device I/O lives here: SSDP discovery, the SMOIP WebSocket
  client (with the `Origin` header the streamer requires),
  reconnect/keepalive, command dispatch, the UPnP browser and library index,
  the MCP server, the scheduler and sleep timer, external-service fetchers,
  and the typed IPC push relay.
- `src/preload/` — the `window.tastytunes` bridge.
- `src/renderer/` — React UI; a Zustand store fed exclusively by pushed state.
- `src/shared/` — the SMOIP payload types and the IPC contract.

The streamer is the single source of truth: user actions send commands, the
streamer applies them and pushes new state, and the UI re-renders from the
push. Live state arrives over the streamer's SMOIP WebSocket
(`ws://<host>:80/smoip`); commands go over the same socket, with a couple of
queue/preset edits over SMOIP HTTP.

## Support

TastyTunes is free. If it's been worth something to you, there's a
name-your-price tip jar at [tastytunes.app](https://tastytunes.app/#support).
For help — bugs, questions, requests — use
[GitHub issues](https://github.com/mjoblin/tastytunes/issues).

## License

TastyTunes is free software, released under the
[GNU General Public License v3.0](LICENSE).

© 2026 [Redacted Cat](https://redactedcat.com)
