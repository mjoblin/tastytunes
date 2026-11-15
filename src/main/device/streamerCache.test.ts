import { describe, expect, it } from "vitest";
import { applyFrame, emptyCache, WAKE_COMMANDS } from "./streamerCache";

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
