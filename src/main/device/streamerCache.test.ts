import { describe, expect, it } from "vitest";
import {
  PRESET_VOLUME_GIVE_UP_MS,
  PresetVolumeAfterRecall,
  WAKE_COMMANDS,
  applyFrame,
  emptyCache,
} from "./streamerCache";

// The one rule for which frame fills which part of a connection's cache: the window's connection
// and an agent's connection to another streamer both read the wire through it.
describe("a streamer's cache, filled by its frames", () => {
  it("fills the part each pushed path names", () => {
    const cache = emptyCache();
    applyFrame(cache, "/zone/play_state", { state: "play", metadata: { title: "Teardrop" } });
    applyFrame(cache, "/zone/state", { source: "MEDIA_PLAYER", volume_percent: 30 });
    applyFrame(cache, "/system/power", { power: "ON" });
    applyFrame(cache, "/queue/list", { total: 3, items: [] });
    applyFrame(cache, "/system/info", { name: "Kitchen", udn: "uuid:kitchen" });
    expect(cache.playState?.metadata?.title).toBe("Teardrop");
    expect(cache.zoneState?.volume_percent).toBe(30);
    expect(cache.systemPower?.power).toBe("ON");
    expect(cache.queue?.total).toBe(3);
    expect(cache.systemInfo?.name).toBe("Kitchen");
  });

  it("reads the firmware's self-check into the window's shape, and fills nothing for an echo", () => {
    const cache = emptyCache();
    applyFrame(cache, "/system/update", { update_available: true, updating: false });
    expect(cache.firmwareUpdate).toEqual({
      updateAvailable: true,
      updating: false,
      earlyUpdate: false,
    });
    const before = JSON.stringify(cache);
    applyFrame(cache, "/zone/play_control", { action: "pause" });
    applyFrame(cache, "/queue/info", {});
    expect(JSON.stringify(cache)).toBe(before);
  });

  it("wakes a sleeping streamer for the play-shaped verbs only", () => {
    expect(WAKE_COMMANDS.has("play")).toBe(true);
    expect(WAKE_COMMANDS.has("recallPreset")).toBe(true);
    expect(WAKE_COMMANDS.has("pause")).toBe(false);
    expect(WAKE_COMMANDS.has("setVolumePercent")).toBe(false);
  });
});

describe("a recall's level waits for the recall to land", () => {
  const rig = () => {
    let now = 0;
    let what = "before";
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    const applied: number[] = [];
    const level = new PresetVolumeAfterRecall({
      signature: () => what,
      apply: (l) => applied.push(l),
      now: () => now,
      setTimer: (fn, ms) => {
        const t = { at: now + ms, fn, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        if (t) (t as { live: boolean }).live = false;
      },
    });
    const advance = (ms: number): void => {
      now += ms;
      for (const t of timers) {
        if (!t.live || t.at > now) continue;
        t.live = false;
        t.fn();
      }
    };
    const play = (s: string): void => {
      what = s;
      level.onPlayback();
    };
    return { level, applied, advance, play };
  };

  it("sends the level a beat after the recall once what plays changed", () => {
    const r = rig();
    r.level.recalled(35, false);
    r.advance(300);
    r.play("album");
    r.advance(800);
    expect(r.applied).toEqual([]);
    r.advance(100);
    expect(r.applied).toEqual([35]);
  });

  it("never sends it for a recall that changed nothing", () => {
    const r = rig();
    r.level.recalled(35, false);
    r.advance(PRESET_VOLUME_GIVE_UP_MS);
    r.play("later");
    r.advance(5_000);
    expect(r.applied).toEqual([]);
  });

  it("sends it after the beat for a recall of what already plays", () => {
    const r = rig();
    r.level.recalled(35, true);
    r.advance(1_200);
    expect(r.applied).toEqual([35]);
  });

  it("lets it go for a newer recall, a play or a volume set by hand", () => {
    const r = rig();
    r.level.recalled(35, false);
    r.level.recalled(50, false);
    r.play("second");
    r.advance(2_000);
    expect(r.applied).toEqual([50]);
    r.level.recalled(35, false);
    r.level.onCommand("volumeStepChange");
    r.play("third");
    r.advance(2_000);
    r.level.recalled(35, false);
    r.level.onCommand("playQueueId");
    r.play("fourth");
    r.advance(2_000);
    expect(r.applied).toEqual([50]);
  });
});
