// The app's own DOMAIN — the things TastyTunes stores and reasons about,
// independent of how they travel.
//
// Split out of ipc.ts 2026-07-26. The rule for what lives here: a type belongs
// in this folder if it would still mean something with the IPC layer deleted —
// the local recently-played log, favorites, playlists, and the content-identity
// helpers that make all three survive a media server re-indexing; connection and
// MCP status (runtime domain state the manager tracks whatever the transport);
// settings; and the media-browser, radio, schedule, lookup, sleep, update and
// diagnostics shapes the app reasons about. Message shapes, channel names and the
// preload API stay in ipc.ts, which imports FROM here; nothing in this folder may
// import from ipc.ts, and that one-way edge is what keeps the contract free of
// domain churn.
//
// smoip.ts is the other direction entirely — the STREAMER's wire types. This
// folder may read from it (a recent entry is matched against a play_state, a
// playlist hashes with the same core a live queue does); it never writes to it.
//
// One file until the 0.11.0 sweep (2,600 lines); now a module per domain behind
// this barrel, so every importer keeps importing "@shared/model". Within the
// folder, modules import each other directly, never through this file.

export * from "./collections";
export * from "./listening";
export * from "./copies";
export * from "./media";
export * from "./audio";
export * from "./settings";
export * from "./schedules";
export * from "./lookups";
export * from "./mcp";
export * from "./diagnostics";
export * from "./radio";
