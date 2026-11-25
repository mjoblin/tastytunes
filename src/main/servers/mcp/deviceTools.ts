import { z } from "zod";
import { sleepTrackKey } from "@shared/model";
import { getSettings } from "../../data/persist";
import { seekLanding } from "../../device/commandFrames";
import {
  type ToolContext,
  type ToolImpl,
  ok,
  err,
  status,
  scheduleOut,
  defineTool,
  rowIds,
  acted,
  trackMoved,
  streamerHostOf,
  DEVICE_ARG,
} from "./toolkit";

// The MCP bridge's device tools (the streamer itself: status and the lists, transport, volume,
// presets, sources, power, devices and the sleep timer), one of six tool modules split out of
// mcpServer.ts 2026-09-13; the shapes and helpers they share live in ./toolkit.

export function deviceTools(ctx: ToolContext): Record<string, ToolImpl> {
  const { dm } = ctx;
  return {
    // ---- status & lists
    get_status: defineTool({
      inputSchema: { device: DEVICE_ARG },
      handler: async (a) =>
        ok(a.device != null ? status(ctx, await ctx.target(a.device)) : status(ctx)),
    }),
    list_queue: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Where the page starts. Default: a few before the playing track, so the page shows what just played and what comes next.",
          ),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        const s = t.snapshot();
        // bounded (0.16.0: a queue can hold thousands of tracks), and by default a window around
        // the playing track, the part an agent asks about
        const items = s.queue?.items ?? [];
        const playing = items.findIndex((i) => i.id === s.queue?.play_id);
        const offset = a.offset ?? Math.max(0, playing - 5);
        const limit = a.limit ?? 50;
        const page = items.slice(offset, offset + limit);
        const ids = rowIds();
        return ok({
          current_id: s.queue?.play_id ?? null,
          current_position: playing >= 0 ? playing : null,
          total: s.queue?.total ?? 0,
          offset,
          returned: page.length,
          // each entry's library ids when the index has its content (0.16.0): a queue entry
          // carries none of its own
          items: page.map((i) => ({
            id: i.id,
            position: i.position,
            title: i.metadata?.title ?? i.metadata?.name ?? null,
            artist: i.metadata?.artist ?? null,
            album: i.metadata?.album ?? null,
            duration_seconds: i.metadata?.duration ?? null,
            ...ids.track({
              title: i.metadata?.title ?? null,
              artist: i.metadata?.artist,
              album: i.metadata?.album,
              artUrl: i.metadata?.art_url,
            }),
          })),
        });
      },
    }),
    list_presets: defineTool({
      inputSchema: { device: DEVICE_ARG },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        const s = t.snapshot();
        return ok(
          (s.presets?.presets ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            kind: p.class,
            is_playing: p.is_playing === true,
          })),
        );
      },
    }),
    list_sources: defineTool({
      inputSchema: { device: DEVICE_ARG },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        const s = t.snapshot();
        const active = s.zoneState?.source ?? s.nowPlaying?.source?.id ?? null;
        return ok(
          (s.sources?.sources ?? [])
            .filter((x) => x.ui_selectable)
            .map((x) => ({ id: x.id, name: x.name, kind: x.class, active: x.id === active })),
        );
      },
    }),
    list_devices: defineTool({
      handler: () => {
        const s = dm.snapshot();
        const current = s.connection.phase === "connected" ? s.connection.host : null;
        // the streamers seen on the network now, and the ones the device book remembers (0.16.0:
        // any of them can be named as a tool's device)
        const seen = new Set(s.devices.map((d) => d.udn));
        return ok([
          ...s.devices.map((d) => ({
            host: d.host,
            name: d.friendlyName,
            model: d.model,
            connected: d.host === current,
            seen_now: true,
          })),
          ...getSettings()
            .knownDevices.filter((d) => !seen.has(d.udn))
            .map((d) => ({
              host: d.host,
              name: d.friendlyName,
              model: d.model,
              connected: d.host === current,
              seen_now: false,
            })),
        ]);
      },
    }),
    list_schedules: defineTool({
      handler: () =>
        ok({
          note: "Schedules fire only while TastyTunes is running and connected.",
          schedules: getSettings().schedules.map(scheduleOut),
        }),
    }),
    // ---- transport
    play: defineTool({
      inputSchema: { device: DEVICE_ARG },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        return acted(
          t,
          () => t.command({ type: "play" }),
          "Playing.",
          (_b, n) => n.playState?.state === "play",
        );
      },
    }),
    pause: defineTool({
      inputSchema: { device: DEVICE_ARG },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        return acted(
          t,
          () => t.command({ type: "pause" }),
          "Paused.",
          (_b, n) => n.playState?.state === "pause",
        );
      },
    }),
    stop: defineTool({
      inputSchema: { device: DEVICE_ARG },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        return acted(
          t,
          () => t.command({ type: "stop" }),
          "Stopped.",
          (_b, n) => n.playState?.state === "stop",
        );
      },
    }),
    next_track: defineTool({
      inputSchema: { device: DEVICE_ARG },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        return acted(
          t,
          () => t.command({ type: "nextTrack" }),
          "Skipped to the next track.",
          trackMoved,
        );
      },
    }),
    previous_track: defineTool({
      inputSchema: { device: DEVICE_ARG },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        return acted(
          t,
          () => t.command({ type: "previousTrack" }),
          "Went back to the previous track.",
          trackMoved,
        );
      },
    }),
    seek: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        position_seconds: z
          .number()
          .min(0)
          .optional()
          .describe("Position in the current track, in seconds."),
        relative_seconds: z
          .number()
          .optional()
          .describe(
            "Instead: seconds from where it is now, back when negative ('go back 30 seconds').",
          ),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        const s = t.snapshot();
        if ((a.position_seconds == null) === (a.relative_seconds == null))
          return err("Give position_seconds or relative_seconds, one of them.");
        // from where it is now (0.16.0: a relative seek had needed the position first)
        const at = s.position?.position ?? s.playState?.position ?? 0;
        const wanted = Math.max(0, a.position_seconds ?? at + (a.relative_seconds ?? 0));
        // where it lands is the device layer's to say (seekLanding): into the track's last second,
        // or past it, the next track
        const land = seekLanding(wanted, s);
        if ("next" in land)
          return acted(
            t,
            () => t.command({ type: "seek", positionSecs: wanted }),
            "Went on to the next track.",
            trackMoved,
          );
        return acted(
          t,
          () => t.command({ type: "seek", positionSecs: wanted }),
          `Moved to ${land.at}s.`,
          (_b, n) => Math.abs((n.position?.position ?? n.playState?.position ?? -99) - land.at) < 3,
        );
      },
    }),
    play_queue_item: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        id: z.number().int().describe("Queue item id from list_queue."),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        return acted(
          t,
          () => t.command({ type: "playQueueId", queueId: a.id }),
          `Playing queue item ${String(a.id)}.`,
          (_b, n) => n.queue?.play_id === a.id || n.playState?.queue_id === a.id,
        );
      },
    }),
    set_shuffle: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        on: z.boolean(),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        const mode = a.on ? "all" : "off";
        return acted(
          t,
          () => t.command({ type: "setShuffle", mode }),
          `Shuffle ${a.on ? "on" : "off"}.`,
          (_b, n) => n.playState?.mode_shuffle === mode,
        );
      },
    }),
    set_repeat: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        mode: z
          .enum(["off", "all", "one"])
          .describe("off, all (the whole queue) or one (the current track)."),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        const mode = a.mode;
        return acted(
          t,
          () => t.command({ type: "setRepeat", mode }),
          `Repeat ${mode}.`,
          (b, n) =>
            n.playState?.mode_repeat !== b.playState?.mode_repeat ||
            n.playState?.mode_repeat === mode,
        );
      },
    }),
    // ---- volume
    set_volume: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        percent: z.number().min(0).max(100).describe("Absolute volume percent."),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        const limit = getSettings().volumeLimitPercent;
        const capped = limit != null && a.percent > limit;
        const target = capped ? limit : a.percent;
        return acted(
          t,
          () => t.command({ type: "setVolumePercent", percent: a.percent }),
          capped
            ? `Volume set to ${limit}% (the app's volume limit).`
            : `Volume set to ${String(a.percent)}%.`,
          (_b, n) => Math.abs((n.zoneState?.volume_percent ?? -99) - target) <= 1,
        );
      },
    }),
    change_volume: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        steps: z
          .number()
          .int()
          .min(-20)
          .max(20)
          .describe("Steps up (positive) or down (negative)."),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        return acted(
          t,
          () => t.command({ type: "volumeStepChange", delta: a.steps }),
          (n) =>
            `Volume ${a.steps < 0 ? "down" : "up"} ${Math.abs(a.steps)} ${Math.abs(a.steps) === 1 ? "step" : "steps"}, now ${n.zoneState?.volume_percent ?? "?"}%.`,
          (b, n) => n.zoneState?.volume_percent !== b.zoneState?.volume_percent,
        );
      },
    }),
    set_mute: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        muted: z.boolean(),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        return acted(
          t,
          () => t.command({ type: "setMute", mute: a.muted }),
          a.muted ? "Muted." : "Unmuted.",
          (_b, n) => n.zoneState?.mute === a.muted,
        );
      },
    }),
    // ---- presets / sources / power / devices
    recall_preset: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        id: z.number().int().min(1).describe("Preset id from list_presets."),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        const s = t.snapshot();
        const preset = (s.presets?.presets ?? []).find((p) => p.id === a.id);
        if (!preset) return err(`No preset ${String(a.id)}. Use list_presets.`);
        return acted(
          t,
          () => t.command({ type: "recallPreset", presetId: a.id }),
          `Recalled preset ${String(a.id)}${preset.name ? ` (${preset.name})` : ""}.`,
          trackMoved,
        );
      },
    }),
    set_source: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        id: z.string().describe("Source id from list_sources, e.g. MEDIA_PLAYER or IR."),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        const s = t.snapshot();
        const src = (s.sources?.sources ?? []).find((x) => x.id === a.id);
        if (!src) return err(`Unknown source '${String(a.id)}'. Use list_sources.`);
        return acted(
          t,
          () => t.command({ type: "setSource", sourceId: a.id }),
          `Switched to ${src.name}.`,
          (_b, n) => n.zoneState?.source === a.id,
        );
      },
    }),
    set_power: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        state: z.enum(["on", "standby"]),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        await t.command({ type: "power", power: a.state === "on" ? "ON" : "NETWORK" });
        return ok(a.state === "on" ? "Powering on." : "Going to network standby.");
      },
    }),
    connect_device: defineTool({
      inputSchema: {
        device: z.string().describe("The streamer by name, host or IP (from list_devices)."),
      },
      handler: (a) => {
        // the window's streamer becomes trusted (its pictures, its media servers): on this
        // network only, named as every tool's device argument names one (mcp/toolkit)
        const s = dm.snapshot();
        const named = streamerHostOf(a.device, [...s.devices, ...getSettings().knownDevices]);
        if ("error" in named) return err(named.error);
        dm.connect(named.host);
        return ok(`Connecting to ${named.host}. Call get_status to confirm.`);
      },
    }),
    // ---- sleep timer
    set_sleep_timer: defineTool({
      inputSchema: {
        device: DEVICE_ARG,
        minutes: z
          .number()
          .min(1)
          .max(720)
          .optional()
          .describe("Minutes from now. Omit when using end_of_track."),
        end_of_track: z.boolean().optional().describe("Fire when the current track ends."),
        action: z
          .enum(["pause", "standby"])
          .optional()
          .describe("Defaults to the user's configured action."),
      },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        const s = t.snapshot();
        const stored = getSettings().sleepAction;
        const action = a.action ?? (stored === "pause" ? "pause" : "standby");
        if (a.end_of_track) {
          const key = sleepTrackKey(s.playState);
          if (key == null) return err("Nothing identifiable is playing — use minutes instead.");
          t.setSleep({ action, minutes: null, firesAt: null, trackKey: key });
          return ok(`Sleep timer armed: ${action} at the end of the current track.`);
        }
        if (typeof a.minutes !== "number") return err("Provide minutes, or end_of_track: true.");
        t.setSleep({
          action,
          minutes: a.minutes,
          firesAt: Date.now() + a.minutes * 60_000,
          trackKey: null,
        });
        return ok(`Sleep timer armed: ${action} in ${a.minutes} minute(s).`);
      },
    }),
    cancel_sleep_timer: defineTool({
      inputSchema: { device: DEVICE_ARG },
      handler: async (a) => {
        const t = await ctx.target(a.device);
        t.setSleep(null);
        return ok("Sleep timer cleared.");
      },
    }),
  };
}
