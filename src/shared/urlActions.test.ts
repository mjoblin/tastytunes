import { describe, expect, it } from "vitest";
import { parseUrlAction, staysInBackground, URL_EXAMPLES, type UrlParse } from "./urlActions";

const SCREENS = { "now-playing": "now-playing", queue: "queue", history: "recently-played" };
const parse = (raw: string): UrlParse => parseUrlAction(raw, SCREENS);
const action = (raw: string): unknown => {
  const p = parse(raw);
  return p.ok ? p.action : p.reason;
};

describe("parseUrlAction", () => {
  it("reads every example Settings lists", () => {
    for (const ex of URL_EXAMPLES) expect(parse(`tastytunes://${ex}`).ok, ex).toBe(true);
  });

  it("maps the transport and power verbs onto the app's own commands", () => {
    expect(action("tastytunes://toggle")).toEqual({
      kind: "command",
      command: { type: "togglePlayback" },
    });
    expect(action("tastytunes://next")).toEqual({
      kind: "command",
      command: { type: "nextTrack" },
    });
    expect(action("tastytunes://wake")).toEqual({
      kind: "command",
      command: { type: "power", power: "ON" },
    });
    expect(action("tastytunes://standby")).toEqual({
      kind: "command",
      command: { type: "power", power: "NETWORK" },
    });
  });

  it("reads volume as steps or a percent, and refuses anything else", () => {
    expect(action("tastytunes://volume/up")).toEqual({
      kind: "command",
      command: { type: "volumeStepChange", delta: 1 },
    });
    expect(action("tastytunes://volume/down/5")).toEqual({
      kind: "command",
      command: { type: "volumeStepChange", delta: -5 },
    });
    expect(action("tastytunes://volume/30")).toEqual({
      kind: "command",
      command: { type: "setVolumePercent", percent: 30 },
    });
    expect(action("tastytunes://volume/0")).toEqual({
      kind: "command",
      command: { type: "setVolumePercent", percent: 0 },
    });
    for (const bad of [
      "volume",
      "volume/101",
      "volume/-5",
      "volume/5.5",
      "volume/up/0",
      "volume/up/21",
      "volume/1e2",
      "volume/30/1",
    ])
      expect(parse(`tastytunes://${bad}`).ok, bad).toBe(false);
  });

  it("switches mute, or sets it", () => {
    expect(action("tastytunes://mute")).toEqual({ kind: "muteToggle" });
    expect(action("tastytunes://mute/on")).toEqual({
      kind: "command",
      command: { type: "setMute", mute: true },
    });
    expect(parse("tastytunes://mute/maybe").ok).toBe(false);
  });

  it("takes a preset slot from 1 to 99", () => {
    expect(action("tastytunes://preset/12")).toEqual({ kind: "preset", slot: 12 });
    for (const bad of ["preset", "preset/0", "preset/100", "preset/one"])
      expect(parse(`tastytunes://${bad}`).ok, bad).toBe(false);
  });

  it("takes a source's name, decoded, slashes and all", () => {
    expect(action("tastytunes://source/CD")).toEqual({ kind: "source", name: "CD" });
    expect(action("tastytunes://source/Optical%201")).toEqual({
      kind: "source",
      name: "Optical 1",
    });
    expect(action("tastytunes://source/a/b")).toEqual({ kind: "source", name: "a/b" });
    expect(parse("tastytunes://source").ok).toBe(false);
  });

  it("goes only to a screen it knows, by key or by name", () => {
    expect(action("tastytunes://screen/Queue")).toEqual({ kind: "screen", screen: "queue" });
    expect(action("tastytunes://screen/history")).toEqual({
      kind: "screen",
      screen: "recently-played",
    });
    expect(parse("tastytunes://screen/nowhere").ok).toBe(false);
  });

  it("is forgiving about how the link arrives", () => {
    const toggle = { kind: "command", command: { type: "togglePlayback" } };
    expect(action("TASTYTUNES://Toggle")).toEqual(toggle);
    expect(action("tastytunes://toggle/")).toEqual(toggle);
    expect(action("tastytunes:toggle")).toEqual(toggle);
    expect(action("tastytunes://toggle?from=deck#x")).toEqual(toggle);
    expect(action("  tastytunes://toggle  ")).toEqual(toggle);
  });

  it("refuses what is not one of its links, and names an unknown verb", () => {
    expect(parse("https://example.com/").ok).toBe(false);
    expect(parse("tastytunes://").ok).toBe(false);
    expect(parse("tastytunes://source/%E0%A4%A").ok).toBe(false);
    expect(action("tastytunes://queue/clear")).toBe(
      "TastyTunes has no action called “queue/clear”.",
    );
    // a verb that takes nothing takes nothing
    expect(parse("tastytunes://play/now").ok).toBe(false);
  });

  it("keeps the user where they were for everything but a screen", () => {
    const p = parse("tastytunes://screen/queue");
    const q = parse("tastytunes://preset/3");
    expect(p.ok && staysInBackground(p.action)).toBe(false);
    expect(q.ok && staysInBackground(q.action)).toBe(true);
  });
});
