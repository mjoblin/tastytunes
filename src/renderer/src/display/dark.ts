/**
 * WHY THE PAGE IS DARK (0.17.0, Display on other screens): the page goes black while the streamer
 * sleeps, and while the app or the streamer is out of reach, and a touch says which, in one line
 * beside the TastyTunes mark (display/PageTransport's SleepControls). The app unheard covers the
 * computer asleep, the app quit, its switch for other screens off and an address that changed
 * (the page keeps asking the address it was opened at), so its line says what to check, and for
 * the last to open the address again.
 */

/** What the page heard: the app, its connection to the streamer, and this screen's own Wake
 *  (allowed, unlocked, with Presets, playlists and power on; null otherwise). */
export interface DarkFacts {
  heard: boolean;
  connected: boolean;
  wake: "ready" | "unreachable" | null;
}

export type DarkCause = "app" | "streamer" | "asleep";

export function whyDark({ heard, connected, wake }: DarkFacts): { cause: DarkCause; line: string } {
  if (!heard)
    return {
      cause: "app",
      line: "Can't reach TastyTunes. Check that it's running, the computer is awake and Second screen is on, or open its address again.",
    };
  // where this screen has Wake, the line agrees with what its buttons can do
  if (wake === "unreachable")
    return {
      cause: "streamer",
      line: "TastyTunes can't reach the streamer. Wake it with its remote.",
    };
  if (wake === "ready" || connected) return { cause: "asleep", line: "The streamer is asleep." };
  return { cause: "streamer", line: "TastyTunes can't reach the streamer." };
}
