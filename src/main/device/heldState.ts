import { join } from "node:path";
import { app } from "electron";
import type { HeldState, ListeningVia } from "@shared/model";
import { isRecord } from "@shared/guards";
import {
  isRadioMetadata,
  trackTitle,
  type SystemSources,
  type ZoneNowPlaying,
  type ZonePlayState,
  type ZoneState,
} from "@shared/smoip";
import { jsonFileStore } from "../data/jsonStore";

/** What the device reports, as the app's cache holds it. */
export interface HeldInput {
  streamer: string | null;
  power: string | null;
  playState: ZonePlayState | null;
  nowPlaying: ZoneNowPlaying | null;
  zoneState: ZoneState | null;
  sources: SystemSources | null;
  /** The playhead's last report, seconds. */
  position: number | null;
  via: ListeningVia | null;
  now: number;
}

/**
 * The state worth holding from what the device reports, or null when it reports nothing to
 * hold (asleep, idle, a library source with no track, the radio source with no station).
 * Pure, so the suite can feed it the shapes the Evo sends. See HeldState.
 */
export function heldFrom(d: HeldInput): HeldState | null {
  if (!d.streamer || d.power !== "ON") return null;
  const ps = d.playState;
  const sourceId = d.zoneState?.source ?? d.nowPlaying?.source?.id ?? null;
  if (!sourceId || sourceId === "IDLE" || ps?.state === "not_ready") return null;
  const md = ps?.metadata ?? null;
  const source = d.sources?.sources.find((s) => s.id === sourceId) ?? null;
  const base = {
    streamer: d.streamer,
    at: d.now,
    sourceId,
    sourceName: source?.name ?? d.nowPlaying?.source?.name ?? null,
    artist: null,
    album: null,
    artUrl: null,
    queueId: null,
    position: null,
    duration: null,
    via: null,
  };
  if (md && isRadioMetadata(md)) {
    const station = md.station ?? d.nowPlaying?.display?.line1 ?? null;
    if (!station) return null;
    return { ...base, kind: "radio", title: station, artUrl: md.art_url ?? null, via: d.via };
  }
  const title = trackTitle(md);
  if (ps?.queue_id != null && md && title) {
    return {
      ...base,
      kind: "queue",
      title,
      artist: md.artist ?? null,
      album: md.album ?? null,
      artUrl: md.art_url ?? null,
      queueId: ps.queue_id,
      position: d.position ?? ps.position ?? null,
      duration: md.duration ?? null,
      via: d.via,
    };
  }
  // the library and the radio hold nothing without a track or a station
  if (sourceId === "MEDIA_PLAYER" || sourceId === "IR") return null;
  // a streaming service (AirPlay, the Connect services, Cast, Roon) or an input (optical,
  // coax, the TV, a disc): the source is what comes back, with the last track for the card
  return {
    ...base,
    kind: source?.class.startsWith("stream.") ? "service" : "input",
    title,
    artist: md?.artist ?? null,
    album: md?.album ?? null,
    artUrl: md?.art_url ?? null,
  };
}

/** Held states by streamer, saved across restarts (userData/held.json). */
const store = jsonFileStore<Record<string, HeldState>>({
  pathOf: () => join(app.getPath("userData"), "held.json"),
  scope: "held state",
  load: (parsed) => {
    const out: Record<string, HeldState> = {};
    if (isRecord(parsed))
      for (const [udn, h] of Object.entries(parsed))
        if (isRecord(h) && typeof h.kind === "string" && typeof h.sourceId === "string")
          out[udn] = h as unknown as HeldState; // our own file, written by saveHeld
    return out;
  },
});

/** The demo's held state lives in memory only: its streamer is not a device to remember. */
const ephemeral = new Map<string, HeldState>();

export function heldFor(streamer: string | null): HeldState | null {
  if (!streamer) return null;
  return ephemeral.get(streamer) ?? store.get()[streamer] ?? null;
}

export function saveHeld(h: HeldState, persist = true): void {
  if (!persist) ephemeral.set(h.streamer, h);
  else store.set({ ...store.get(), [h.streamer]: h });
}
