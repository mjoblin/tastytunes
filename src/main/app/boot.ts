import { app, protocol } from "electron";
import { join } from "node:path";
import { installNavigationGuard } from "./guard";
import { keepVersionCopy } from "../data/savedFiles";
import { version as appVersion } from "../../../package.json";
// tastytunes:// URLs: listened for before ready, held until whenReady takes them (app/urlInbox)
import "./urlInbox";

// THE PROCESS'S FIRST WORDS (main/index.ts imports this module before any other, so these run
// before anything else in main is evaluated; split out of index.ts in the 0.11.0 sweep).

// tt-art: the app's own picture scheme (main/lookups/artThumbs). Registered
// before ready, as Electron requires; served in whenReady (app/artProtocol).
protocol.registerSchemesAsPrivileged([
  { scheme: "tt-art", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// THE WINDOWS' OWN PICTURE CACHE, BOUNDED (0.16.0-rc.8): Chromium keeps what a window loads from
// the web in an HTTP cache that grew to 1.3 GB in a real profile, outside Settings' sizes and
// Clear. Held at 64 MB, and emptied with the album-art cache's Clear (ipc/lookups).
export const HTTP_CACHE_BYTES = 64 * 1024 * 1024;
app.commandLine.appendSwitch("disk-cache-size", String(HTTP_CACHE_BYTES));

// A dead log pipe must never crash the app: when a parent process that
// spawned us (a script, a test harness) dies, our stdout/stderr writes
// eventually hit EPIPE once the kernel buffer fills — hours later — and an
// unhandled stream error becomes Electron's uncaught-exception dialog on
// the desktop (seen live, 2026-08-29). Swallow stream errors; logging is
// best-effort by nature.
for (const stream of [process.stdout, process.stderr]) stream?.on?.("error", () => {});

// Pin the identity and settings location: when Electron is launched with a
// bare file path (dev harnesses), it doesn't read package.json and userData
// would silently default to ".../Electron". TASTYTUNES_USER_DATA lets test
// harnesses run isolated (own settings, own single-instance lock).
// Display casing: app.name feeds menu role labels ("Hide/Quit TastyTunes");
// the settings path stays lowercase via the explicit setPath below.
app.setName("TastyTunes");
app.setPath(
  "userData",
  process.env["TASTYTUNES_USER_DATA"] ?? join(app.getPath("appData"), "tastytunes"),
);

// a new version keeps a copy of the saved files as the last one left them, before anything in it
// writes (data/savedFiles); the version from package.json, as the log's header reads it
keepVersionCopy(app.getPath("userData"), appVersion, [
  "settings.json",
  "favorites.json",
  "playlists.json",
  // the user's own, which nothing can recompute: the artist pictures chosen, and when each album
  // arrived
  "artist-choices.json",
  "album-arrivals.json",
]);

// every web contents the app creates is held to its own page (app/guard)
installNavigationGuard();
