# iPad shell (spike)

The start of the iPadOS port: a Capacitor shell that reuses the desktop
renderer wholesale, with the 30-channel `tt` preload API (the seam — the
renderer has zero Electron imports) reimplemented over browser WebSocket +
native HTTP. **Spike status: adapter core proven against the mock streamer;
no Xcode project yet; no UI work yet.**

## What's real

- `src/smoipClient.ts` — SMOIP WebSocket client (subscribe set, reconnect
  with backoff, keepalive). Live-verified fact this rests on (2026-07-18,
  real Evo 150): the firmware accepts `Origin: capacitor://localhost` — it
  requires Origin *presence*, not a value — so WKWebView's stock WebSocket
  works with no native plugin.
- `src/adapter.ts` — `createTtAdapter()` implements the `TastyTunesApi`
  seam: connect/disconnect, the transport/zone command map, push fan-out in
  the shapes the renderer store already consumes, snapshot assembly.
- `src/browse.ts` — ContentDirectory browse/servers over the HTTP shim
  (`src/http.ts`: CapacitorHttp when present — native, no CORS — else
  `fetch` for dev harnesses).

## What's stubbed (TODO(port) markers in adapter.ts)

- Streamer discovery (needs the Capacitor zeroconf plugin; the Evo
  advertises `_stream-magic._tcp` — verified — so no multicast entitlement).
- Settings persistence (Capacitor Preferences; hoist the defaults out of
  `src/main/persist.ts` into `src/shared/`).
- Lyrics / artist & album context / scrobbling / recents / caches (move the
  service modules behind the seam or re-point them at direct fetch; CORS
  audit needed per service).
- Queue & preset edit verbs, preset-volume ride-along, search, queue add.
- Deliberately dropped on iPad (per R5 decisions): mini player, MCP server,
  schedules, self-update.

## Binding constraints for the UI phase

Read the **touch-feel doctrine in ROADMAP.md R5** before writing any UI
code — native physics, branded skin; feel bugs are release blockers.
`capacitor.config.ts` already encodes the non-negotiables that live at the
shell layer (background color matched to the app, no white flash).

## Verify

`node dev-harness` pattern (session scratchpad `verify-ipad-adapter.mjs`):
compile with `npx tsc -p ipad/tsconfig.json`, run the mock streamer, drive
the adapter from Node (global `WebSocket`/`fetch` stand in for the WKWebView
runtime).
