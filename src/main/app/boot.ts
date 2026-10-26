import { app, protocol } from "electron";
import { join } from "node:path";
import { installNavigationGuard } from "./guard";
// tastytunes:// URLs: listened for before ready, held until whenReady takes them (app/urlInbox)
import "./urlInbox";

// THE PROCESS'S FIRST WORDS (main/index.ts imports this module before any other, so these run
// before anything else in main is evaluated; split out of index.ts in the 0.11.0 sweep).

// tt-art: the app's own picture scheme (main/lookups/artThumbs). Registered
// before ready, as Electron requires; served in whenReady (app/artProtocol).
protocol.registerSchemesAsPrivileged([
  { scheme: "tt-art", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// A dead log pipe must never crash the app: when a parent process that
// spawned us (a script, a test harness) dies, our stdout/stderr writes
// eventually hit EPIPE once the kernel buffer fills — hours later — and an
// unhandled stream error becomes Electron's uncaught-exception dialog on
// the user's desktop (live, 2026-08-29). Swallow stream errors; logging is
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

// every web contents the app creates is held to its own page (app/guard)
installNavigationGuard();
