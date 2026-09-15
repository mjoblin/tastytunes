import { z, type ZodRawShape } from "zod";
import { type MenuCommand, type Snapshot } from "@shared/ipc";
import {
  type AppSettings,
  type ConnectionState,
  type MediaIndexPools,
  type MediaNode,
  type MediaQueueAction,
  type Schedule,
} from "@shared/model";
import { favoriteKey, resumeRun } from "@shared/model";
import { audioCaps } from "@shared/smoip";
import type { DeviceManager } from "../../device/deviceManager";
import { getSettings } from "../../data/persist";
import { pools as indexPools, revalidate } from "../../media/mediaIndex";

// The MCP bridge's TOOLKIT (2026-09-13, the bridge split: 74 tool implementations
// had sat in one 2,400-line member): the tool result and implementation shapes,
// the ok/err results, the streamer argument the history tools share, the pure
// helpers the tools reach, and the context a tool module takes from the bridge.
// The tools themselves live beside this file, one module per family, joined in
// the bridge's toolImpls.

export interface ToolResult {
  /** Text, or an image (get_album_art, 2026-09-14: base64 bytes and their type, the MCP
   *  image content block, which clients that render pictures show). */
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface ToolImpl {
  inputSchema?: ZodRawShape;
  handler(args: Record<string, unknown>): Promise<ToolResult> | ToolResult;
}

export const ok = (payload: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    },
  ],
});
export const err = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** First non-internal IPv4 address, for the reachable URL when bound to LAN. */

/** What resume_album finds: the run left unfinished and where it stands, or why not. */
export type ResumeOffer =
  | {
      run: ReturnType<typeof resumeRun> & object;
      node: MediaNode;
      target: MediaNode;
      position: number;
      total: number;
    }
  | { reason: string };

/** A snapshot proven connected (the bridge's connected() throws otherwise). */
export type ConnectedSnapshot = Snapshot & {
  connection: Extract<ConnectionState, { phase: "connected" }>;
};

/** What the tool modules reach of the bridge: the device manager, the
 *  connected-or-throw snapshot, the index kick, the resume offer and the
 *  schedules write. Built by the bridge per server build. */
export interface ToolContext {
  dm: DeviceManager;
  connected(): ConnectedSnapshot;
  kickIndex(): string;
  resumeOffer(): Promise<ResumeOffer>;
  mutateSchedules(fn: (list: Schedule[]) => Schedule[]): void;
  /** Persist a settings patch and push it to every window (the scene tools, 2026-09-14). */
  saveSettings(patch: Partial<AppSettings>): AppSettings;
  /** A menu command to the main window (display mode on or off). */
  sendCommand(command: MenuCommand): void;
  /** Whether display mode is on, as the renderer last reported. */
  displayModeOn(): boolean;
}

/** The app's own state an agent can ask about beside the streamer's (2026-09-14): display
 *  mode on or off and the scene chosen for it, and the Now Playing tile's scene. */
export const appState = (
  ctx: ToolContext,
): {
  display_mode: { on: boolean; scene: AppSettings["displayScene"] };
  now_playing_tile: { scene: AppSettings["nowPlayingScene"] };
} => {
  const st = getSettings();
  return {
    display_mode: { on: ctx.displayModeOn(), scene: st.displayScene },
    now_playing_tile: { scene: st.nowPlayingScene },
  };
};

/** The history tools' optional streamer: a name from the device book or a live
 *  device, or a udn; "before-0.8.0" for the lines written before the field. */
export const STREAMER_ARG = z
  .string()
  .optional()
  .describe(
    "Only what one streamer played: its name or udn (list_devices). 'before-0.8.0' for lines written before the record named streamers.",
  );
export function streamerKeep(
  arg: unknown,
  devices: ReadonlyArray<{ udn: string; friendlyName: string }>,
): ((e: { streamer?: string | null }) => boolean) | null {
  if (typeof arg !== "string" || arg.trim() === "") return null;
  const needle = arg.trim().toLowerCase();
  if (needle === "before-0.8.0") return (e) => e.streamer == null;
  const byName = [...getSettings().knownDevices, ...devices].find(
    (d) => d.friendlyName.trim().toLowerCase() === needle,
  );
  const udn = byName?.udn ?? arg.trim();
  return (e) => e.streamer === udn;
}

export const lc = (x: string | null | undefined): string => (x ?? "").trim().toLowerCase();

const nodeIn = (pool: MediaIndexPools, id: string): MediaNode | null =>
  pool.albums.find((n) => n.id === id) ??
  pool.tracks.find((n) => n.id === id) ??
  pool.artists.find((n) => n.id === id) ??
  null;

/**
 * THE ID AN AGENT HOLDS MAY HAVE ROTTED (2026-09-14, the USB report: the
 * streamer's own USB server re-mints every object id across standby and a
 * replug). The app's playlist activation revalidates a Browse-built index
 * before trusting an id; the tools queued the id as it came, so a listing
 * from before the standby played nothing. Now: revalidate first (a
 * search-built or unindexed server answers at once), and when the index was
 * rebuilt, find the same thing again by content and answer its new id — or say
 * plainly that it was not found again.
 */
export async function freshObjectId(
  host: string,
  udn: string,
  id: string,
): Promise<{ id: string } | { error: string }> {
  const before = indexPools().find((p) => p.udn === udn);
  const node = before ? nodeIn(before, id) : null;
  if (!(await revalidate(host, udn, id))) return { id };
  const after = indexPools().find((p) => p.udn === udn);
  const again =
    node && after
      ? (node.isContainer ? [...after.albums, ...after.artists] : after.tracks).find(
          (n) =>
            lc(n.title) === lc(node.title) &&
            lc(n.artist) === lc(node.artist) &&
            (node.isContainer || lc(n.album) === lc(node.album)),
        )
      : null;
  if (!again)
    return {
      error: `The server's object ids changed (the drive re-mounted) and '${node?.title ?? id}' was not found again — run search_library or list_albums for fresh ids.`,
    };
  return { id: again.id };
}

export const kindOf = (n: MediaNode): "album" | "artist" | "track" | "folder" =>
  n.upnpClass.includes("musicAlbum")
    ? "album"
    : n.upnpClass.includes("Artist") || n.upnpClass.includes("person")
      ? "artist"
      : n.upnpClass.includes("audioItem")
        ? "track"
        : "folder";

export const QUEUE_MODES: Record<string, MediaQueueAction> = {
  play_now: "PLAY_NOW",
  play_next: "PLAY_NEXT",
  append: "APPEND",
  replace: "REPLACE",
};

/** The agent's side of the large-queue guard: the app asks the user in a
 *  dialog; an agent is told to ask, and how to say yes. */
export const largeQueueAsk = (tracks: number, tool: string): string =>
  `That item holds ${tracks.toLocaleString()} tracks. Ask the user before queueing that many, then call ${tool} again with confirm_large: true.`;

/** Tone/EQ gate: caps when the streamer has them, a clean error otherwise. */
export const toneCaps = (
  ctx: ToolContext,
): { s: Snapshot; caps: NonNullable<ReturnType<typeof audioCaps>> } => {
  const s = ctx.connected();
  const caps = audioCaps(s.audioSpec);
  if (!caps) throw new Error("This streamer has no tone/EQ controls.");
  return { s, caps };
};

/** The preset-save contract: an occupied slot needs overwrite: true. */
export const guardSlot = (s: Snapshot, slot: number, overwrite: boolean): void => {
  const existing = (s.presets?.presets ?? []).find((p) => p.id === slot);
  if (existing && !overwrite) {
    throw new Error(
      `Slot ${slot} already holds "${existing.name ?? "a preset"}". Pass overwrite: true to replace it.`,
    );
  }
};

export const status = (ctx: ToolContext): unknown => {
  const s = ctx.dm.snapshot();
  if (s.connection.phase !== "connected") {
    return {
      connection: s.connection.phase,
      hint: "Not connected. Use list_devices and connect_device.",
      ...appState(ctx),
    };
  }
  const md = s.playState?.metadata;
  const activeSourceId = s.zoneState?.source ?? s.nowPlaying?.source?.id ?? null;
  const sourceName =
    s.sources?.sources?.find((x) => x.id === activeSourceId)?.name ??
    s.nowPlaying?.source?.name ??
    null;
  return {
    connection: "connected",
    device: {
      name: s.systemInfo?.name ?? null,
      model: s.systemInfo?.model ?? null,
      host: s.connection.host,
    },
    power: s.systemPower?.power ?? null,
    source: activeSourceId ? { id: activeSourceId, name: sourceName } : null,
    ...appState(ctx),
    playback: {
      state: s.playState?.state ?? null,
      title: md?.title ?? null,
      artist: md?.artist ?? null,
      album: md?.album ?? null,
      station: md?.station ?? null,
      position_seconds: s.position?.position ?? s.playState?.position ?? null,
      duration_seconds: md?.duration ?? null,
      queue_index: s.playState?.queue_index ?? null,
      queue_length: s.playState?.queue_length ?? null,
      shuffle: s.playState?.mode_shuffle ?? null,
      repeat: s.playState?.mode_repeat ?? null,
      // Track-content match against the favorites (station URLs aren't
      // knowable from playback metadata, so stations report null here).
      favorited:
        md?.title != null && !md.station
          ? s.favorites.some(
              (f) =>
                favoriteKey(f) ===
                favoriteKey({
                  kind: "track",
                  addedAt: 0,
                  title: md.title!,
                  artist: md.artist ?? null,
                  album: md.album ?? null,
                  artUrl: null,
                  serverUdn: null,
                  serverName: null,
                  objectId: null,
                  titlePath: null,
                }),
            )
          : null,
      format: md
        ? {
            codec: md.codec,
            sample_rate: md.sample_rate,
            bit_depth: md.bit_depth,
            lossless: md.lossless,
            bitrate: md.bitrate,
          }
        : null,
    },
    volume: {
      percent: s.zoneState?.volume_percent ?? null,
      step: s.zoneState?.volume_step ?? null,
      muted: s.zoneState?.mute ?? null,
      limit_percent: getSettings().volumeLimitPercent,
    },
    // Tone/EQ — present only on streamers whose firmware has the controls.
    audio: (() => {
      const caps = audioCaps(s.audioSpec);
      if (!caps) return null;
      const za = s.zoneAudio;
      return {
        user_eq_enabled: za?.user_eq?.enabled ?? false,
        band_gains_db: za?.user_eq?.bands?.map((b) => b.gain) ?? null,
        tilt: za?.tilt_eq ? { enabled: za.tilt_eq.enabled, intensity: za.tilt_eq.intensity } : null,
        balance: za?.balance ?? null,
      };
    })(),
    display: s.systemDisplay ? { brightness: s.systemDisplay.brightness } : null,
    sleep_timer: s.sleep
      ? {
          action: s.sleep.action,
          fires_at: s.sleep.firesAt,
          end_of_track: s.sleep.minutes == null,
        }
      : null,
  };
};

/** Agent-facing schedule shape: 'wake' instead of the internal 'on'. */
export function scheduleOut(s: Schedule): Record<string, unknown> {
  return {
    id: s.id,
    enabled: s.enabled,
    time: s.time,
    days: s.days,
    action: s.action === "on" ? "wake" : "standby",
    preset_id: s.presetId,
    volume_percent: s.volumePercent,
  };
}
