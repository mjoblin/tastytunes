import { z } from "zod";
import { EQ_GAIN_MAX, EQ_GAIN_MIN, brightnessOptions } from "@shared/smoip";
import { getSettings } from "../../data/persist";
import { fetchArtistInfo } from "../../lookups/artistInfo";
import { fetchAlbumInfo } from "../../lookups/albumInfo";
import { fetchLyrics } from "../../lookups/lyrics";
import { type ToolContext, type ToolImpl, ok, err, lc, toneCaps } from "./toolkit";

// The MCP bridge's audio tools (audio: tone and EQ, the analysis readouts, the display, the
// lookups), one of six tool modules split out of mcpServer.ts 2026-09-13; the shapes and helpers
// they share live in ./toolkit.

export function audioTools(ctx: ToolContext): Record<string, ToolImpl> {
  const { dm } = ctx;
  return {
    // ---- tone & EQ (feature-detected; toneCaps errors cleanly without)
    get_audio_settings: {
      handler: () => {
        const { s, caps } = toneCaps(ctx);
        const za = s.zoneAudio;
        return ok({
          user_eq_enabled: za?.user_eq?.enabled ?? false,
          band_gains_db: za?.user_eq?.bands?.map((b) => b.gain) ?? null,
          tilt: za?.tilt_eq ?? null,
          balance: za?.balance ?? null,
          ranges: {
            band_gain_db: { min: EQ_GAIN_MIN, max: EQ_GAIN_MAX },
            tilt: caps.tilt ? caps.tiltRange : null,
            balance: caps.balance ? caps.balanceRange : null,
          },
          saved_presets: getSettings().eqPresets.map((p) => p.name),
        });
      },
    },
    set_eq_band: {
      inputSchema: {
        band: z
          .number()
          .int()
          .min(0)
          .max(6)
          .describe("Band index 0 (lowest) … 6 (highest frequency)."),
        gain_db: z.number().min(EQ_GAIN_MIN).max(EQ_GAIN_MAX),
      },
      handler: async (a) => {
        const { s } = toneCaps(ctx);
        if (s.zoneAudio?.user_eq?.enabled !== true)
          await dm.command({ type: "setUserEq", enabled: true });
        await dm.command({
          type: "setEqBandGain",
          index: a.band as number,
          gain: a.gain_db as number,
        });
        return ok(`Band ${String(a.band)} set to ${String(a.gain_db)} dB.`);
      },
    },
    set_tilt: {
      inputSchema: {
        intensity: z
          .number()
          .describe("Negative = warmer, positive = brighter (range from get_audio_settings)."),
      },
      handler: async (a) => {
        const { s, caps } = toneCaps(ctx);
        if (!caps.tilt) return err("This streamer has no tone tilt.");
        if (s.zoneAudio?.tilt_eq?.enabled !== true)
          await dm.command({ type: "setTiltEq", enabled: true });
        await dm.command({ type: "setTiltIntensity", intensity: a.intensity as number });
        return ok(`Tilt set to ${String(a.intensity)}.`);
      },
    },
    set_balance: {
      inputSchema: {
        balance: z
          .number()
          .describe("Negative = left, positive = right (range from get_audio_settings)."),
      },
      handler: async (a) => {
        const { caps } = toneCaps(ctx);
        if (!caps.balance) return err("This streamer has no balance control.");
        await dm.command({ type: "setBalance", balance: a.balance as number });
        return ok(`Balance set to ${String(a.balance)}.`);
      },
    },
    apply_eq_preset: {
      inputSchema: { name: z.string().describe("A saved preset name from get_audio_settings.") },
      handler: async (a) => {
        toneCaps(ctx);
        const preset = getSettings().eqPresets.find((p) => lc(p.name) === lc(a.name as string));
        if (!preset)
          return err(
            `No saved EQ preset named '${String(a.name)}'. get_audio_settings lists them.`,
          );
        await dm.command({ type: "setUserEq", enabled: true });
        await dm.command({ type: "setEqBands", gains: preset.gains });
        return ok(`Applied EQ preset "${preset.name}".`);
      },
    },
    reset_eq: {
      handler: async () => {
        toneCaps(ctx);
        await dm.command({ type: "setEqBands", gains: [0, 0, 0, 0, 0, 0, 0] });
        return ok("EQ reset to flat.");
      },
    },
    // ---- display
    set_display_brightness: {
      inputSchema: { level: z.enum(["off", "dim", "bright"]) },
      handler: async (a) => {
        const s = ctx.connected();
        const options = brightnessOptions(s.displaySpec);
        if (!options) return err("This streamer has no front-panel display.");
        if (!options.includes(a.level as string)) {
          return err(`This display only supports: ${options.join(", ")}.`);
        }
        await dm.command({ type: "setBrightness", brightness: a.level as string });
        return ok(`Display set to ${String(a.level)}.`);
      },
    },
    // ---- lookups (each behind its Connections toggle: off = no requests, ever)
    get_lyrics: {
      handler: async () => {
        if (!getSettings().lyrics) {
          return err(
            "Lyrics lookups are switched off in Settings › Connections (off means no requests, ever).",
          );
        }
        const s = ctx.connected();
        const md = s.playState?.metadata;
        if (!md?.title || !md.artist) return err("Need a playing track with a title and artist.");
        const r = await fetchLyrics({
          artist: md.artist,
          title: md.title,
          album: md.album ?? null,
          duration: md.duration ?? null,
        });
        if (!r) return ok("No lyrics found for this track.");
        if (r.instrumental) return ok("Instrumental — no lyrics.");
        return ok({ title: md.title, artist: md.artist, lyrics: r.plain ?? r.synced });
      },
    },
    get_artist_info: {
      inputSchema: { artist: z.string().optional().describe("Defaults to the playing artist.") },
      handler: async (a) => {
        if (!getSettings().artistInfo) {
          return err(
            "Artist context is switched off in Settings › Connections (off means no requests, ever).",
          );
        }
        const s = ctx.connected();
        const name = (a.artist as string | undefined) ?? s.playState?.metadata?.artist ?? null;
        if (!name) return err("No artist playing — pass artist explicitly.");
        const info = await fetchArtistInfo(name);
        if (!info) return ok(`No artist match for "${name}".`);
        return ok({
          name: info.name,
          summary: info.summary,
          wikipedia: info.wikipediaUrl,
          musicbrainz: info.musicbrainzUrl,
        });
      },
    },
    get_album_info: {
      inputSchema: {
        artist: z.string().optional().describe("Defaults to the playing artist."),
        album: z.string().optional().describe("Defaults to the playing album."),
      },
      handler: async (a) => {
        // one toggle governs both context tabs in the app — same here
        if (!getSettings().artistInfo) {
          return err(
            "Artist & album context is switched off in Settings › Connections (off means no requests, ever).",
          );
        }
        const s = ctx.connected();
        const artist = (a.artist as string | undefined) ?? s.playState?.metadata?.artist ?? null;
        const album = (a.album as string | undefined) ?? s.playState?.metadata?.album ?? null;
        if (!artist || !album) return err("No album playing — pass artist and album explicitly.");
        const info = await fetchAlbumInfo(artist, album, false, true);
        if (!info) return ok(`No album match for "${album}" by ${artist}.`);
        return ok({
          title: info.title,
          year: info.year,
          type: info.type,
          label: info.label,
          genres: info.genres,
          credits: info.credits,
          summary: info.summary,
          wikipedia: info.wikipediaUrl,
          musicbrainz: info.musicbrainzUrl,
        });
      },
    },
  };
}
