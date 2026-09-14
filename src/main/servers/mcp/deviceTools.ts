import { z } from "zod";
import { sleepTrackKey } from "@shared/model";
import { getSettings } from "../../data/persist";
import { type ToolContext, type ToolImpl, ok, err, status, scheduleOut } from "./toolkit";

// The MCP bridge's device tools (the streamer itself: status and the lists, transport, volume,
// presets, sources, power, devices and the sleep timer), one of six tool modules split out of
// mcpServer.ts 2026-09-13; the shapes and helpers they share live in ./toolkit.

export function deviceTools(ctx: ToolContext): Record<string, ToolImpl> {
  const { dm } = ctx;
  return {
    // ---- status & lists
    get_status: { handler: () => ok(status(ctx)) },
    list_queue: {
      handler: () => {
        const s = ctx.connected();
        return ok({
          current_id: s.queue?.play_id ?? null,
          total: s.queue?.total ?? 0,
          items: (s.queue?.items ?? []).map((i) => ({
            id: i.id,
            position: i.position,
            title: i.metadata?.title ?? i.metadata?.name ?? null,
            artist: i.metadata?.artist ?? null,
            album: i.metadata?.album ?? null,
            duration_seconds: i.metadata?.duration ?? null,
          })),
        });
      },
    },
    list_presets: {
      handler: () => {
        const s = ctx.connected();
        return ok(
          (s.presets?.presets ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            kind: p.class,
            is_playing: p.is_playing === true,
          })),
        );
      },
    },
    list_sources: {
      handler: () => {
        const s = ctx.connected();
        const active = s.zoneState?.source ?? s.nowPlaying?.source?.id ?? null;
        return ok(
          (s.sources?.sources ?? [])
            .filter((x) => x.ui_selectable)
            .map((x) => ({ id: x.id, name: x.name, kind: x.class, active: x.id === active })),
        );
      },
    },
    list_devices: {
      handler: () => {
        const s = dm.snapshot();
        const current = s.connection.phase === "connected" ? s.connection.host : null;
        return ok(
          s.devices.map((d) => ({
            host: d.host,
            name: d.friendlyName,
            model: d.model,
            connected: d.host === current,
          })),
        );
      },
    },
    list_recently_played: {
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Max entries (default 25)."),
      },
      handler: (a) => {
        const limit = typeof a.limit === "number" ? a.limit : 25;
        return ok(
          dm
            .snapshot()
            .recents.slice(0, limit)
            .map((r) => ({
              at: new Date(r.at).toISOString(),
              title: r.title,
              artist: r.artist,
              album: r.album,
              station: r.station,
              source: r.source,
            })),
        );
      },
    },
    list_schedules: {
      handler: () =>
        ok({
          note: "Schedules fire only while TastyTunes is running and connected.",
          schedules: getSettings().schedules.map(scheduleOut),
        }),
    },
    // ---- transport
    play: {
      handler: async () => {
        ctx.connected();
        await dm.command({ type: "play" });
        return ok("Playing.");
      },
    },
    pause: {
      handler: async () => {
        ctx.connected();
        await dm.command({ type: "pause" });
        return ok("Paused.");
      },
    },
    stop: {
      handler: async () => {
        ctx.connected();
        await dm.command({ type: "stop" });
        return ok("Stopped.");
      },
    },
    next_track: {
      handler: async () => {
        ctx.connected();
        await dm.command({ type: "nextTrack" });
        return ok("Skipped to the next track.");
      },
    },
    previous_track: {
      handler: async () => {
        ctx.connected();
        await dm.command({ type: "previousTrack" });
        return ok("Went back to the previous track.");
      },
    },
    seek: {
      inputSchema: {
        position_seconds: z.number().min(0).describe("Position in the current track, in seconds."),
      },
      handler: async (a) => {
        ctx.connected();
        await dm.command({ type: "seek", positionSecs: a.position_seconds as number });
        return ok(`Seeked to ${String(a.position_seconds)}s.`);
      },
    },
    play_queue_item: {
      inputSchema: { id: z.number().int().describe("Queue item id from list_queue.") },
      handler: async (a) => {
        ctx.connected();
        await dm.command({ type: "playQueueId", queueId: a.id as number });
        return ok(`Playing queue item ${String(a.id)}.`);
      },
    },
    set_shuffle: {
      inputSchema: { on: z.boolean() },
      handler: async (a) => {
        ctx.connected();
        await dm.command({ type: "setShuffle", mode: a.on ? "all" : "off" });
        return ok(`Shuffle ${a.on ? "on" : "off"}.`);
      },
    },
    set_repeat: {
      inputSchema: { on: z.boolean() },
      handler: async (a) => {
        ctx.connected();
        await dm.command({ type: "setRepeat", mode: a.on ? "all" : "off" });
        return ok(`Repeat ${a.on ? "on" : "off"}.`);
      },
    },
    // ---- volume
    set_volume: {
      inputSchema: { percent: z.number().min(0).max(100).describe("Absolute volume percent.") },
      handler: async (a) => {
        ctx.connected();
        await dm.command({ type: "setVolumePercent", percent: a.percent as number });
        const limit = getSettings().volumeLimitPercent;
        const capped = limit != null && (a.percent as number) > limit;
        return ok(
          capped
            ? `Volume set to ${limit}% (the app's volume limit).`
            : `Volume set to ${String(a.percent)}%.`,
        );
      },
    },
    change_volume: {
      inputSchema: {
        steps: z
          .number()
          .int()
          .min(-20)
          .max(20)
          .describe("Steps up (positive) or down (negative)."),
      },
      handler: async (a) => {
        ctx.connected();
        await dm.command({ type: "volumeStepChange", delta: a.steps as number });
        return ok(`Volume nudged by ${String(a.steps)} step(s).`);
      },
    },
    set_mute: {
      inputSchema: { muted: z.boolean() },
      handler: async (a) => {
        ctx.connected();
        await dm.command({ type: "setMute", mute: a.muted as boolean });
        return ok(a.muted ? "Muted." : "Unmuted.");
      },
    },
    // ---- presets / sources / power / devices
    recall_preset: {
      inputSchema: { id: z.number().int().min(1).describe("Preset id from list_presets.") },
      handler: async (a) => {
        const s = ctx.connected();
        const preset = (s.presets?.presets ?? []).find((p) => p.id === a.id);
        if (!preset) return err(`No preset ${String(a.id)}. Use list_presets.`);
        await dm.command({ type: "recallPreset", presetId: a.id as number });
        return ok(`Recalled preset ${String(a.id)}${preset.name ? ` (${preset.name})` : ""}.`);
      },
    },
    set_source: {
      inputSchema: {
        id: z.string().describe("Source id from list_sources, e.g. MEDIA_PLAYER or IR."),
      },
      handler: async (a) => {
        const s = ctx.connected();
        const src = (s.sources?.sources ?? []).find((x) => x.id === a.id);
        if (!src) return err(`Unknown source '${String(a.id)}'. Use list_sources.`);
        await dm.command({ type: "setSource", sourceId: a.id as string });
        return ok(`Switched to ${src.name}.`);
      },
    },
    set_power: {
      inputSchema: { state: z.enum(["on", "standby"]) },
      handler: async (a) => {
        ctx.connected();
        await dm.command({ type: "power", power: a.state === "on" ? "ON" : "NETWORK" });
        return ok(a.state === "on" ? "Powering on." : "Going to network standby.");
      },
    },
    connect_device: {
      inputSchema: { host: z.string().describe("Host or IP from list_devices.") },
      handler: (a) => {
        dm.connect(a.host as string);
        return ok(`Connecting to ${String(a.host)}. Call get_status to confirm.`);
      },
    },
    // ---- sleep timer
    set_sleep_timer: {
      inputSchema: {
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
      handler: (a) => {
        const s = ctx.connected();
        const stored = getSettings().sleepAction;
        const action = (a.action ?? (stored === "pause" ? "pause" : "standby")) as
          "pause" | "standby";
        if (a.end_of_track) {
          const key = sleepTrackKey(s.playState);
          if (key == null) return err("Nothing identifiable is playing — use minutes instead.");
          dm.setSleep({ action, minutes: null, firesAt: null, trackKey: key });
          return ok(`Sleep timer armed: ${action} at the end of the current track.`);
        }
        if (typeof a.minutes !== "number") return err("Provide minutes, or end_of_track: true.");
        dm.setSleep({
          action,
          minutes: a.minutes,
          firesAt: Date.now() + a.minutes * 60_000,
          trackKey: null,
        });
        return ok(`Sleep timer armed: ${action} in ${a.minutes} minute(s).`);
      },
    },
    cancel_sleep_timer: {
      handler: () => {
        dm.setSleep(null);
        return ok("Sleep timer cleared.");
      },
    },
  };
}
