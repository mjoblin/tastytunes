import { dirname, join } from "node:path";

/**
 * WHICH NOW PLAYING HELPER RUNS (0.17.0, app/nowPlaying): pure, so its rule is a unit test.
 *
 * - A packaged app runs only its own: macOS's in Contents/Helpers, Windows' beside
 *   TastyTunes.exe, and none elsewhere. It never reads TASTYTUNES_NP_HELPER, which would let the
 *   environment start any program as the app's child, with the app's standing on the computer
 *   (its Local Network permission among them).
 * - A development run uses a helper only when TASTYTUNES_NP_HELPER names one (the suite's fake, or
 *   a built helper): two copies of the app each claiming Now Playing would take the keys from
 *   each other.
 */

export const HELPER_NAME = "TastyTunes Now Playing";

export interface HelperPlace {
  packaged: boolean;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  resourcesPath: string;
  execPath: string;
  exists(file: string): boolean;
}

export function helperPath(p: HelperPlace): string | null {
  if (!p.packaged) return p.env["TASTYTUNES_NP_HELPER"] || null;
  const file =
    p.platform === "darwin"
      ? join(p.resourcesPath, "..", "Helpers", HELPER_NAME)
      : p.platform === "win32"
        ? join(dirname(p.execPath), `${HELPER_NAME}.exe`)
        : null;
  return file && p.exists(file) ? file : null;
}
