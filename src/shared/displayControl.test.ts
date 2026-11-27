import { describe, expect, it } from "vitest";
import type { SleepTimer } from "./model";
import type { QueueListItem, ZoneNowPlaying, ZonePlayState } from "./smoip";
import {
  isDisplayVerb,
  isSleepChoice,
  powerLine,
  powerVerb,
  QUEUE_AFTER,
  QUEUE_ALL,
  QUEUE_BEFORE,
  queueWindow,
  screenName,
  type PowerFacts,
} from "./displayControl";

describe("a screen's name and verbs", () => {
  it("names a screen by its device and browser, an iPad's Safari by its touch", () => {
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
    expect(screenName(mac)).toBe("Mac · Safari");
    expect(screenName(mac, true)).toBe("iPad · Safari");
    expect(
      screenName(
        "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15",
      ),
    ).toBe("iPad · DuckDuckGo");
    expect(
      screenName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      ),
    ).toBe("Windows PC · Edge");
    expect(
      screenName(
        "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ),
    ).toBe("Android tablet · Chrome");
    expect(
      screenName(
        "Mozilla/5.0 (SMART-TV; LINUX; Tizen 8.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/7.0 Chrome/120.0.6099.5 TV Safari/537.36",
      ),
    ).toBe("TV · Samsung Internet");
    expect(screenName("")).toBe("Screen");
  });

  it("knows the fixed list of verbs only", () => {
    expect(isDisplayVerb("toggle")).toBe(true);
    expect(isDisplayVerb("volumeUp")).toBe(true);
    expect(isDisplayVerb("seek")).toBe(true);
    expect(isDisplayVerb("standby")).toBe(true);
    expect(isDisplayVerb("sleep")).toBe(true);
    expect(isDisplayVerb("sleepCancel")).toBe(true);
    expect(isDisplayVerb("power")).toBe(false);
    expect(isDisplayVerb("setSleep")).toBe(false);
    expect(isDisplayVerb("setVolumePercent")).toBe(false);
    expect(isDisplayVerb({})).toBe(false);
  });

  it("sends a queue whole up to QUEUE_ALL, a longer one as a window around the playing track", () => {
    const items: QueueListItem[] = Array.from({ length: 1000 }, (_, i) => ({
      id: 1000 + i,
      position: i,
      metadata: {
        title: `T${i}`,
        artist: "A",
        album: "B",
        duration: 100,
        art_url: null,
        class: null,
        source: null,
        name: null,
        track_number: null,
        genre: null,
      },
    }));
    // a long queue: the window around the playing track
    const rows = queueWindow(items, 1500);
    expect(rows[0].id).toBe(1500 - QUEUE_BEFORE);
    expect(rows).toHaveLength(QUEUE_BEFORE + 1 + QUEUE_AFTER);
    expect(rows.filter((r) => r.playing).map((r) => r.id)).toEqual([1500]);
    expect(queueWindow(items, 1001)[0].id).toBe(1000);
    expect(queueWindow(items, null)).toHaveLength(QUEUE_AFTER + 1);
    // an album's worth, played near its end: all of it, the earlier tracks there to scroll back to
    const album = items.slice(0, 12);
    expect(queueWindow(album, 1011).map((r) => r.id)).toEqual(album.map((i) => i.id));
    // up to QUEUE_ALL, whole wherever it plays
    expect(queueWindow(items.slice(0, QUEUE_ALL), 1290)).toHaveLength(QUEUE_ALL);
    expect(queueWindow(items.slice(0, QUEUE_ALL + 1), 1290)[0].id).toBe(1290 - QUEUE_BEFORE);
  });
});

const NOW = 1_700_000_000_000;
const track = {
  state: "play",
  queue_id: 41,
  metadata: { title: "Song", artist: "Band", duration: 240, class: "stream.media" },
} as unknown as ZonePlayState;
const station = {
  state: "play",
  metadata: { title: "Song", station: "Radio 3", class: "stream.radio" },
} as unknown as ZonePlayState;
const facts = (over: Partial<PowerFacts> = {}): PowerFacts => ({
  on: true,
  action: "pause",
  playState: track,
  nowPlaying: null as ZoneNowPlaying | null,
  timer: null,
  ...over,
});
const armed: SleepTimer = {
  action: "standby",
  minutes: 30,
  firesAt: NOW + 1_800_000,
  trackKey: null,
};

describe("standby and the sleep timer on a screen", () => {
  it("takes one of the window's lengths, or the end of the track, and nothing else", () => {
    for (const m of [15, 30, 45, 60, 90, 120, "track"]) expect(isSleepChoice(m)).toBe(true);
    for (const m of [0, 20, 30.5, -15, 7200, "30", "end", null, undefined, {}])
      expect(isSleepChoice(m)).toBe(false);
  });

  it("tells a screen of both while the streamer is on, with the timer as it stands", () => {
    expect(powerLine(facts())).toEqual({
      standby: true,
      sleep: { action: "pause", endOfTrack: true, armed: null },
    });
    // armed: when it runs out, or null for the end of the track, and the armed timer's own action
    expect(powerLine(facts({ timer: armed })).sleep).toEqual({
      action: "standby",
      endOfTrack: true,
      armed: { firesAt: NOW + 1_800_000 },
    });
    const eot: SleepTimer = { action: "pause", minutes: null, firesAt: null, trackKey: "q41" };
    expect(powerLine(facts({ timer: eot })).sleep?.armed).toEqual({ firesAt: null });
  });

  it("offers End of track only where the window does: a track with a length, not a station", () => {
    expect(powerLine(facts({ playState: station })).sleep?.endOfTrack).toBe(false);
    const noLength = { ...track, metadata: { ...track.metadata, duration: null } } as ZonePlayState;
    expect(powerLine(facts({ playState: noLength })).sleep?.endOfTrack).toBe(false);
    expect(powerLine(facts({ playState: null })).sleep?.endOfTrack).toBe(false);
  });

  it("says the app's own action, an unset one as standby (the window's guard)", () => {
    expect(powerLine(facts({ action: undefined })).sleep?.action).toBe("standby");
    expect(powerLine(facts({ action: "off" })).sleep?.action).toBe("standby");
  });

  it("offers neither while the streamer isn't on (a sleeping one has Wake instead)", () => {
    expect(powerLine(facts({ on: false }))).toEqual({ standby: false, sleep: null });
    expect(powerLine(facts({ on: false, timer: armed }))).toEqual({ standby: false, sleep: null });
  });

  it("puts a streamer that is on in standby, and does nothing for one already there", () => {
    expect(powerVerb("standby", undefined, facts(), NOW)).toEqual({ standby: true });
    expect(powerVerb("standby", undefined, facts({ on: false }), NOW)).toBeNull();
  });

  it("arms the timer as the window does: the app's own action, from now or to the track's end", () => {
    expect(powerVerb("sleep", 30, facts(), NOW)).toEqual({
      sleep: { action: "pause", minutes: 30, firesAt: NOW + 30 * 60_000, trackKey: null },
    });
    expect(powerVerb("sleep", "track", facts({ action: null }), NOW)).toEqual({
      sleep: { action: "standby", minutes: null, firesAt: null, trackKey: "q41" },
    });
    // armed again over a running timer: the new one replaces it
    expect(powerVerb("sleep", 15, facts({ timer: armed }), NOW)).toEqual({
      sleep: { action: "pause", minutes: 15, firesAt: NOW + 15 * 60_000, trackKey: null },
    });
  });

  it("refuses a timer with the streamer not on, a length it doesn't offer, or a track end on a station", () => {
    expect(powerVerb("sleep", 30, facts({ on: false }), NOW)).toBeNull();
    expect(powerVerb("sleep", undefined, facts(), NOW)).toBeNull();
    expect(powerVerb("sleep", 20, facts(), NOW)).toBeNull();
    expect(powerVerb("sleep", "track", facts({ playState: station }), NOW)).toBeNull();
  });

  it("cancels a timer that is armed, and has nothing to cancel otherwise", () => {
    expect(powerVerb("sleepCancel", undefined, facts({ timer: armed }), NOW)).toEqual({
      sleep: null,
    });
    // whether the streamer is on or not: a timer is let go either way
    expect(powerVerb("sleepCancel", undefined, facts({ on: false, timer: armed }), NOW)).toEqual({
      sleep: null,
    });
    expect(powerVerb("sleepCancel", undefined, facts(), NOW)).toBeNull();
  });
});
