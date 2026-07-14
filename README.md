# TastyTunes

A desktop controller for [Cambridge Audio StreamMagic](https://www.cambridgeaudio.com/row/en/products/streammagic)
music streamers. A bigger, tastier serving than [PunyTunes](https://punytunes.app).

TastyTunes talks directly to the streamer — no backend, no database. Live state
arrives over the streamer's SMOIP WebSocket (`ws://<host>:80/smoip`); commands go
over the same socket, with a couple of queue/preset edits over SMOIP HTTP.

## Features

- UPnP/SSDP discovery, manual IP fallback, auto-reconnect with backoff, post-sleep
  connection health checks
- Now Playing with large art, ambient art backdrop, format badges (codec / sample
  rate / bit depth / lossless / MQA), internet-radio display
- Transport (play/pause/stop/next/previous/seek/scrub), capability-gated from the
  streamer's own `controls[]`; repeat & shuffle
- Queue: view, jump, drag-to-reorder, remove, clear, follow-current
- Presets: recall, delete, drag-to-reorder
- Source switching, power/standby (with the "never re-send ON" reboot guard)
- Volume for Pre-Amp mode (absolute) and Control Bus mode (nudge), mute, optional
  volume limit
- OS media keys, full keyboard shortcuts (`?`), SMOIP payload console (`` ` ``)

## Development

```bash
npm install
npm run dev        # run with HMR
npm run typecheck  # typecheck main + preload + renderer
npm run build      # bundle to out/
npm run dist:mac   # package a dmg (also: dist:win, dist:linux)
```

Stack: Electron + electron-vite, React 19, TypeScript, Tailwind CSS v4, Zustand,
`ws` in the main process for the streamer socket.

## Architecture

- `src/main/` — device I/O lives here: SSDP discovery, the SMOIP WebSocket client
  (with the `Origin` header the streamer requires), reconnect/keepalive, command
  dispatch, and the typed IPC push relay.
- `src/preload/` — the `window.tastytunes` bridge.
- `src/renderer/` — React UI; a Zustand store fed exclusively by pushed state.
- `src/shared/` — the SMOIP payload types (ported from PunyTunes' generated types)
  and the IPC contract.

The streamer is the single source of truth: user actions send commands, the
streamer applies them and pushes new state, and the UI re-renders from the push.
