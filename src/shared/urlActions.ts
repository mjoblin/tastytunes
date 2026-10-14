import type { StreamerCommand } from "./ipc";

/**
 * THE tastytunes:// URL SCHEME (0.12.0, the first round; filed 2026-10-11 from a Reddit ask for
 * a Stream Deck integration). One control surface for anything that can open a URL: a Stream
 * Deck's Website action, Raycast, Alfred, Keyboard Maestro, Shortcuts, a launcher. This module
 * is the verbs, pure: a URL in, an action or the reason it was refused out. main/app/urlActions
 * runs the action through the app's own command path (deviceManager.command), and
 * main/app/urlInbox receives the URLs.
 *
 * HARMLESS VERBS ONLY: any web page can link a tastytunes:// URL (a browser asks before handing
 * one to an app), so nothing here clears, overwrites or deletes, and a volume set is held to the
 * app's volume limit like every other (device/commandFrames).
 */

export const URL_SCHEME = "tastytunes";

/** What a URL asks for. `command` goes out as it is; the rest are resolved against what the
 *  streamer has (its presets, its sources, its mute) or are the app's own windows. */
export type UrlAction =
  | { kind: "command"; command: StreamerCommand }
  | { kind: "muteToggle" }
  | { kind: "preset"; slot: number }
  | { kind: "source"; name: string }
  | { kind: "screen"; screen: string }
  | { kind: "mini" };

export type UrlParse =
  { ok: true; action: UrlAction; verb: string } | { ok: false; reason: string };

/** One example of every verb, in the order Settings lists them; the unit test parses each. */
export const URL_EXAMPLES = [
  "toggle",
  "play",
  "pause",
  "stop",
  "next",
  "previous",
  "volume/up",
  "volume/down",
  "volume/up/5",
  "volume/30",
  "mute",
  "mute/on",
  "mute/off",
  "preset/1",
  "source/CD",
  "power",
  "power/on",
  "power/standby",
  "screen/now-playing",
  "mini",
] as const;

const PLAIN: Record<string, StreamerCommand> = {
  toggle: { type: "togglePlayback" },
  play: { type: "play" },
  pause: { type: "pause" },
  stop: { type: "stop" },
  next: { type: "nextTrack" },
  previous: { type: "previousTrack" },
};

/** A whole number written as one, in a range ("05" and "5" alike; "5.5", "1e2" and "" not). */
function wholeIn(s: string | undefined, min: number, max: number): number | null {
  if (s == null || !/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/**
 * Reads a tastytunes:// URL. The verb is case-insensitive; a trailing slash, a query and a
 * fragment are ignored (launchers and Windows' argv add them); the parts are %-decoded, so a
 * source's name may carry spaces. `screens` maps the names a URL may use to the app's screen
 * keys (main builds it from the Go menu's list).
 */
export function parseUrlAction(raw: string, screens: Readonly<Record<string, string>>): UrlParse {
  const m = /^tastytunes:(?:\/\/)?([^?#]*)/i.exec(raw.trim());
  if (!m) return { ok: false, reason: "That isn't a TastyTunes link." };
  let parts: string[];
  try {
    parts = m[1]
      .split("/")
      .filter((p) => p !== "")
      .map((p) => decodeURIComponent(p).trim());
  } catch {
    return { ok: false, reason: "Couldn't read that TastyTunes link." };
  }
  const verb = (parts[0] ?? "").toLowerCase();
  const arg = parts[1];
  const lone = parts.length === 1;
  const unknown: UrlParse = {
    ok: false,
    reason: verb
      ? `TastyTunes has no action called “${parts.join("/")}”.`
      : "That TastyTunes link names no action.",
  };
  const ok = (action: UrlAction): UrlParse => ({ ok: true, action, verb: parts.join("/") });

  if (verb in PLAIN) return lone ? ok({ kind: "command", command: PLAIN[verb] }) : unknown;
  switch (verb) {
    case "volume": {
      const dir = arg?.toLowerCase();
      if (dir === "up" || dir === "down") {
        const steps = parts.length === 2 ? 1 : parts.length === 3 ? wholeIn(parts[2], 1, 20) : null;
        if (steps == null) return { ok: false, reason: "Volume up and down take 1 to 20 steps." };
        return ok({
          kind: "command",
          command: { type: "volumeStepChange", delta: dir === "up" ? steps : -steps },
        });
      }
      const percent = parts.length === 2 ? wholeIn(arg, 0, 100) : null;
      if (percent == null)
        return { ok: false, reason: "Volume takes up, down or a number from 0 to 100." };
      return ok({ kind: "command", command: { type: "setVolumePercent", percent } });
    }
    case "mute": {
      if (lone) return ok({ kind: "muteToggle" });
      const to = arg?.toLowerCase();
      if (parts.length === 2 && (to === "on" || to === "off"))
        return ok({ kind: "command", command: { type: "setMute", mute: to === "on" } });
      return { ok: false, reason: "Mute takes on or off." };
    }
    // power has mute's shape and SMoIP's words (/system/power: toggle, ON, NETWORK); there is no
    // off, so standby is named for what it is
    case "power": {
      if (lone) return ok({ kind: "command", command: { type: "power", power: "toggle" } });
      const to = arg?.toLowerCase();
      if (parts.length === 2 && (to === "on" || to === "standby"))
        return ok({
          kind: "command",
          command: { type: "power", power: to === "on" ? "ON" : "NETWORK" },
        });
      return { ok: false, reason: "Power takes on or standby." };
    }
    case "preset": {
      const slot = parts.length === 2 ? wholeIn(arg, 1, 99) : null;
      if (slot == null) return { ok: false, reason: "Preset takes a number from 1 to 99." };
      return ok({ kind: "preset", slot });
    }
    case "source": {
      const name = parts.slice(1).join("/");
      if (!name) return { ok: false, reason: "Source takes the name of a source, such as CD." };
      return ok({ kind: "source", name });
    }
    case "screen": {
      const screen = parts.length === 2 ? screens[arg.toLowerCase()] : undefined;
      if (!screen)
        return {
          ok: false,
          reason: `TastyTunes has no screen called “${parts.slice(1).join("/")}”.`,
        };
      return ok({ kind: "screen", screen });
    }
    case "mini":
      return lone ? ok({ kind: "mini" }) : unknown;
    default:
      return unknown;
  }
}

/** Whether an action leaves the user where they were (everything but going to a screen): a
 *  URL that brought the app forward hands the focus back (main/app/urlInbox). */
export function staysInBackground(action: UrlAction): boolean {
  return action.kind !== "screen";
}
