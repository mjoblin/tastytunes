import { z } from "zod";
import { type Schedule, trackPosition } from "@shared/model";
import { resumeTarget } from "@shared/model";
import { getSettings } from "../../data/persist";
import { randomUUID } from "node:crypto";
import { browseChildrenOf, presetSave, queueAdd } from "../../media/upnpBrowser";
import { pools as indexPools } from "../../media/mediaIndex";
import {
  type ToolContext,
  type ToolImpl,
  ok,
  err,
  guardSlot,
  scheduleOut,
  freshObjectId,
} from "./toolkit";

// The MCP bridge's edit tools (the writes with a contract: queue edits, preset saves, schedules),
// one of six tool modules split out of mcpServer.ts 2026-09-13; the shapes and helpers they share
// live in ./toolkit.

export function editTools(ctx: ToolContext): Record<string, ToolImpl> {
  const { dm } = ctx;
  return {
    // ---- queue editing (opt-in cluster)
    remove_queue_item: {
      inputSchema: { id: z.number().int().describe("Queue item id from list_queue.") },
      handler: async (a) => {
        const s = ctx.connected();
        const item = (s.queue?.items ?? []).find((i) => i.id === a.id);
        if (!item) return err(`No queue item ${String(a.id)}. Use list_queue.`);
        await dm.command({ type: "queueDelete", id: a.id as number });
        return ok(`Removed "${item.metadata?.title ?? `item ${String(a.id)}`}" from the queue.`);
      },
    },
    clear_queue: {
      handler: async () => {
        const s = ctx.connected();
        const n = s.queue?.total ?? s.queue?.items?.length ?? 0;
        await dm.command({ type: "queueClear" });
        return ok(`Queue cleared (${n} items removed).`);
      },
    },
    resume_playback: {
      handler: async () => {
        const s = ctx.connected();
        const offer = await ctx.resumeOffer();
        if ("reason" in offer) return err(offer.reason);
        // the album's OWN browse listing supplies the container and track ids —
        // a pooled track's id and parentId belong to the index's search scope
        // (Play from here on that container once queued 2,528 tracks)
        const udn = offer.node.serverUdn;
        if (!udn) return err("The album's server is unknown.");
        // the album's id came from the index: a USB server's may have rotted since
        const fresh = await freshObjectId(s.connection.host, udn, offer.node.id);
        if ("error" in fresh) return err(fresh.error);
        const kids = (await browseChildrenOf(s.connection.host, udn, fresh.id)) ?? [];
        const tracks = kids
          .filter((k) => !k.isContainer)
          .sort((x, y) => (trackPosition(x) ?? 0) - (trackPosition(y) ?? 0));
        if (tracks.length === 0 || tracks.length > 100)
          return err("The album could not be browsed as an album-sized container.");
        const target = resumeTarget(offer.run, tracks);
        if (!target) return err("The run reached the album's end; nothing to resume.");
        await queueAdd(s.connection.host, udn, fresh.id, "PLAY_FROM_HERE", target.id);
        return ok(
          `Resuming "${offer.node.title}" from track ${tracks.indexOf(target) + 1}, "${target.title}".`,
        );
      },
    },
    move_queue_item: {
      inputSchema: {
        id: z.number().int().describe("Queue item id from list_queue."),
        to_position: z.number().int().min(0).describe("New 0-based position."),
      },
      handler: async (a) => {
        const s = ctx.connected();
        const item = (s.queue?.items ?? []).find((i) => i.id === a.id);
        if (!item || item.position == null)
          return err(`No queue item ${String(a.id)}. Use list_queue.`);
        const total = s.queue?.total ?? 0;
        if ((a.to_position as number) >= total) return err(`to_position must be below ${total}.`);
        await dm.command({
          type: "queueMove",
          id: a.id as number,
          from: item.position,
          to: a.to_position as number,
        });
        return ok(
          `Moved "${item.metadata?.title ?? `item ${String(a.id)}`}" to position ${String(a.to_position)}.`,
        );
      },
    },
    // ---- preset saving (opt-in cluster; explicit-overwrite contract)
    save_queue_as_preset: {
      inputSchema: {
        slot: z.number().int().min(1).max(99).describe("Preset slot 1–99."),
        name: z.string().min(1).describe("Name for the saved queue."),
        overwrite: z.boolean().optional().describe("Must be true to replace an occupied slot."),
      },
      handler: async (a) => {
        const s = ctx.connected();
        if ((s.queue?.total ?? 0) === 0) return err("The queue is empty.");
        guardSlot(s, a.slot as number, a.overwrite === true);
        await dm.command({
          type: "queueSavePreset",
          slot: a.slot as number,
          name: a.name as string,
        });
        return ok(`Saved the queue to preset ${String(a.slot)} as "${String(a.name)}".`);
      },
    },
    repair_preset: {
      inputSchema: {
        slot: z.number().int().min(1).max(99).describe("The preset slot that will not play."),
      },
      handler: async (a) => {
        const s = ctx.connected();
        const slot = a.slot as number;
        const preset = (s.presets?.presets ?? []).find((p) => p.id === slot);
        if (!preset) return err(`Preset slot ${slot} is empty.`);
        if (!preset.art_url)
          return err(`Preset ${slot} has no artwork to match on, so it cannot be repaired here.`);
        // The art id survives the object-id churn that breaks presets, which
        // is what makes this a lookup rather than a guess.
        const hits = indexPools().flatMap((pool) =>
          pool.albums.filter((alb) => alb.artUrl != null && alb.artUrl === preset.art_url),
        );
        if (hits.length === 0)
          return err(
            `Nothing in the library index matches preset ${slot}'s artwork. Build the index for the server that holds it (rebuild_library_index) and try again.`,
          );
        if (hits.length > 1)
          return err(
            `Preset ${slot}'s artwork matches ${hits.length} albums, so the right one is ambiguous — repair it from the app instead.`,
          );
        const match = hits[0];
        if (!match.serverUdn)
          return err("The matched album has no server — index may be mid-build.");
        await presetSave(s.connection.host, match.serverUdn, match.id, slot);
        return ok({
          slot,
          repaired_to: match.title,
          artist: match.artist ?? null,
          server: match.serverName ?? null,
        });
      },
    },
    save_playing_to_preset: {
      inputSchema: {
        slot: z.number().int().min(1).max(99).describe("Preset slot 1–99."),
        name: z
          .string()
          .optional()
          .describe("Optional rename (the firmware derives a name otherwise)."),
        overwrite: z.boolean().optional().describe("Must be true to replace an occupied slot."),
      },
      handler: async (a) => {
        const s = ctx.connected();
        if (s.playState?.state !== "play" && s.playState?.state !== "pause") {
          return err("Nothing is playing to save.");
        }
        guardSlot(s, a.slot as number, a.overwrite === true);
        await dm.command({ type: "zoneSavePreset", slot: a.slot as number });
        if (typeof a.name === "string" && a.name.length > 0) {
          await dm.command({ type: "presetRename", slot: a.slot as number, name: a.name });
        }
        return ok(
          `Saved the current playback to preset ${String(a.slot)}${a.name ? ` as "${String(a.name)}"` : ""}.`,
        );
      },
    },
    // ---- schedules (opt-in cluster; list_schedules lives with Status & lists)
    create_schedule: {
      inputSchema: {
        time: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .describe("Local 24h 'HH:MM', e.g. '07:30'."),
        days: z
          .array(z.number().int().min(0).max(6))
          .min(1)
          .describe("Days it fires: 0 = Sunday … 6 = Saturday."),
        action: z
          .enum(["wake", "standby"])
          .describe("wake = power on (optionally recall a preset); standby = power down."),
        preset_id: z
          .number()
          .int()
          .min(1)
          .max(99)
          .optional()
          .describe("Wake only: preset to recall after powering on."),
        volume_percent: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Wake only: volume to set after the preset settles."),
        enabled: z.boolean().optional().describe("Default true."),
      },
      handler: (a) => {
        if (a.action === "standby" && (a.preset_id != null || a.volume_percent != null)) {
          return err("preset_id and volume_percent only apply to wake schedules.");
        }
        const sched: Schedule = {
          id: randomUUID(),
          enabled: a.enabled !== false,
          time: a.time as string,
          days: [...new Set(a.days as number[])].sort(),
          action: a.action === "wake" ? "on" : "standby",
          presetId: (a.preset_id as number | undefined) ?? null,
          volumePercent: (a.volume_percent as number | undefined) ?? null,
        };
        ctx.mutateSchedules((list) => [...list, sched]);
        return ok({
          created: scheduleOut(sched),
          note: "Schedules fire only while TastyTunes is running and connected.",
        });
      },
    },
    set_schedule_enabled: {
      inputSchema: {
        id: z.string().describe("Schedule id from list_schedules."),
        enabled: z.boolean(),
      },
      handler: (a) => {
        const found = getSettings().schedules.find((x) => x.id === a.id);
        if (!found) return err(`No schedule '${String(a.id)}'. Use list_schedules.`);
        ctx.mutateSchedules((list) =>
          list.map((x) => (x.id === a.id ? { ...x, enabled: a.enabled as boolean } : x)),
        );
        return ok(`Schedule ${a.enabled ? "enabled" : "disabled"}.`);
      },
    },
    delete_schedule: {
      inputSchema: { id: z.string().describe("Schedule id from list_schedules.") },
      handler: (a) => {
        const found = getSettings().schedules.find((x) => x.id === a.id);
        if (!found) return err(`No schedule '${String(a.id)}'. Use list_schedules.`);
        ctx.mutateSchedules((list) => list.filter((x) => x.id !== a.id));
        return ok("Schedule deleted.");
      },
    },
  };
}
