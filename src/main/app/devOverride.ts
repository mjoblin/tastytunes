import { app } from "electron";

// THE OVERRIDES ONLY A DEVELOPMENT OR TEST RUN HONORS (0.16.0). A program running as
// the same user can set a variable for the app's launch. Most of the app's overrides only point a
// lookup elsewhere, and the install smokes keep them (a packaged build under test reaches no real
// service). These five would hand such a program the app's identity, so an installed build reads
// none of them: the windows' page (loaded with the bridge, every IPC handler trusting its origin),
// the ListenBrainz address (the token goes with each listen), the fanart.tv address (its key goes
// with each request), secrets kept unencrypted, and the update feed (on Windows its config names
// no publisher, so the signature check is skipped). Lint dev-overrides: nothing else reads them.

export type DevOverride =
  | "ELECTRON_RENDERER_URL"
  | "TASTYTUNES_LB_URL"
  | "TASTYTUNES_FANART_URL"
  | "TASTYTUNES_SECRETS_PLAIN"
  | "TASTYTUNES_UPDATE_FEED";

/** The override's value in a development or test run; nothing in an installed build. */
export function devOverride(name: DevOverride): string | undefined {
  return app.isPackaged ? undefined : process.env[name];
}
