import { presetVolumeKey } from "./model";
import { nameKey } from "./keys";
import {
  activeSourceId,
  isRadioMetadata,
  queueContentHash,
  type PresetItem,
  type QueueList,
  type SystemInfo,
  type SystemPower,
  type ZoneNowPlaying,
  type ZonePlayState,
  type ZoneState,
} from "./smoip";

/** Same art object regardless of scheme/query differences. */
function urlsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}

/** A radio preset, by its class or its type (one saved from the Radio screen has no airable id). */
function isRadioPreset(p: PresetItem): boolean {
  return /radio/i.test(p.class ?? "") || p.type === "Radio";
}

/** A station's preset: its play is radio (main/app/nowPlayingRules). */
export function isStationPreset(p: PresetItem): boolean {
  return p.airable_radio_id != null || isRadioPreset(p);
}

/** What the rule reads: the streamer's state as the window's store or main's cache holds it. */
export interface LitInput {
  zoneState: ZoneState | null;
  nowPlaying: ZoneNowPlaying | null;
  playState: ZonePlayState | null;
  queue: QueueList | null;
  systemInfo: SystemInfo | null;
  systemPower: SystemPower | null;
  /** A wake on its way (the app's own, single-flight). */
  waking: boolean;
  /** The preset last recalled through this app (main/device/deviceManager). */
  lastRecalledPresetId: number | null;
  /** Presets whose last recall came to nothing (main/device/recallWatch). */
  deadPresets: readonly number[];
  /** The saved queues' exact signatures (settings.queueSignatures). */
  queueSignatures: Record<string, string>;
  /** A recall issued while the streamer slept owns the lamp until it lands (screen-local state
   *  the Presets screen passes). */
  wakeRecallId?: number | null;
}

/**
 * Which presets are PLAYING — derived from what's actually playing, never from
 * the device's own flags. ONE HOME for the rule (0.17.0): the window's hook
 * (hooks/useLitPresets) and the display server's presets for another screen
 * (main/app/display) both call this; it was the window's alone, and a rule
 * this hard-won must not exist twice.
 *
 * THE STREAMER'S `is_playing` CANNOT BE TRUSTED, and this is the memo of why:
 *  - radio presets aren't cleared when you switch to local media (vibin hit
 *    this too — its `_fix_stale_preset_is_playing`), and
 *  - media (album) presets only report `is_playing` transiently around the
 *    recall; any later read returns false (vibinui's own TODO: "When the UI is
 *    refreshed, a stream.media.upnp preset will have an is_playing of false,
 *    even if it was playing"), and
 *  - a recall the firmware IGNORES (a preset whose album the server no longer
 *    has) sets the flag and keeps it: a preset read is_playing true while
 *    another album played (0.15.0-rc.2, 2026-11-08). So the flag lights an album
 *    preset only while what plays has no art or album to compare (mid-recall,
 *    before the words), and a preset main has said came to nothing never lights.
 * So the answer is derived statelessly: radio_id is authoritative for
 * stations, saved queues match on an exact signature or an art fingerprint,
 * album presets match by art URL or name against the current track. Stateless
 * also means it works at startup, when every flag reads false.
 *
 * ONE preset lights, in this priority:
 *  1. The preset most recently recalled through this app, while a content
 *     check confirms its stuff is still what's playing — the check is the
 *     validity guard, so a stale recall goes dark on its own. This is what
 *     disambiguates duplicate saved queues and stops an album preset stealing
 *     the lamp while its album plays inside a recalled queue.
 *  2. Stateless fallback (startup, recalls from other controllers): radio_id
 *     is authoritative; a saved queue lights only on a UNIQUE fingerprint
 *     match; album matching is suppressed while the queue is itself a
 *     recognised saved queue (the queue explains the track better than the
 *     album does); input presets trust the flag only off local media.
 */
export function litPresetIds(items: readonly PresetItem[], s: LitInput): Set<number> {
  const derived = derive(items, s);
  // a preset main has said came to nothing is not playing, whatever matched it
  const deadPresets = s.deadPresets;
  return deadPresets.some((id) => derived.has(id))
    ? new Set([...derived].filter((id) => !deadPresets.includes(id)))
    : derived;
}

function derive(items: readonly PresetItem[], s: LitInput): Set<number> {
  const { playState, queue, systemInfo, systemPower, waking, lastRecalledPresetId } = s;
  const { queueSignatures } = s;
  const wakeRecallId = s.wakeRecallId ?? null;
  const activeSource = activeSourceId(s.zoneState, s.nowPlaying);
  const radioId = playState?.metadata?.radio_id ?? null;
  const md = playState?.metadata ?? null;
  // A LIT PRESET MEANS "THIS IS PLAYING" — so nothing lights while the
  // streamer is asleep or on its way back. A waking device re-announces its
  // RETAINED pre-standby play_state, so the old preset's content check passes
  // again mid-wake and follow glides at it, then glides again when the real
  // recall lands. Suppressing the lamp for the whole not-ON window removes the
  // transition rather than racing it.
  const asleep = (systemPower != null && systemPower.power !== "ON") || waking;
  const lit = new Set<number>();
  if (asleep) return lit;

  // The live queue's leading distinct-album art sequence — the same
  // fingerprint the firmware bakes into a MediaQueue preset's art_urls.
  const queueArts: string[] = [];
  for (const it of queue?.items ?? []) {
    const a = it.metadata?.art_url;
    if (a && !queueArts.some((x) => urlsMatch(x, a))) queueArts.push(a);
  }
  // Exact identity of the live queue (all tracks, in order).
  const liveQueueHash = queue?.items?.length ? queueContentHash(queue.items) : null;

  const mediaOk = activeSource == null || activeSource === "MEDIA_PLAYER";

  const sigOf = (p: PresetItem): string | undefined =>
    p.id != null ? queueSignatures[presetVolumeKey(systemInfo?.udn, p.id)] : undefined;
  const sigMatch = (p: PresetItem): boolean =>
    mediaOk && liveQueueHash != null && sigOf(p) === liveQueueHash;
  const fingerprint = (p: PresetItem): boolean => {
    if (!mediaOk) return false;
    const want = p.art_urls ?? [];
    if (want.length === 0 || want.length > queueArts.length) return false;
    return want.every((u, i) => urlsMatch(u, queueArts[i]));
  };
  const mqContent = (p: PresetItem): boolean => (sigOf(p) != null ? sigMatch(p) : fingerprint(p));
  const albumMatch = (p: PresetItem): boolean => {
    if (!mediaOk) return false;
    // the flag only while there is nothing to compare: what plays overrules it (see above)
    if (md?.art_url == null && md?.album == null) return p.is_playing === true;
    if (p.art_url != null && md.art_url != null && urlsMatch(p.art_url, md.art_url)) return true;
    if (p.name != null && md.album != null) {
      if (p.name === md.album) return true;
      if (md.artist != null && p.name.includes(md.album) && p.name.includes(md.artist)) return true;
    }
    return false;
  };
  // Raw-URL radio presets (saved from the Radio screen) carry no airable id
  // — the station NAME is their identity.
  const stationMatch = (p: PresetItem): boolean => {
    const station = md?.station != null ? nameKey(md.station) : null;
    return station != null && p.name != null && nameKey(p.name) === station;
  };
  /** null = this preset type has no content to check (inputs etc.) */
  const contentCheck = (p: PresetItem): boolean | null => {
    if (p.airable_radio_id != null && radioId != null) return p.airable_radio_id === radioId;
    if (p.type === "MediaQueue") return mqContent(p);
    if ((p.class ?? "").startsWith("stream.media")) return albumMatch(p);
    if (isRadioPreset(p)) return stationMatch(p);
    return null;
  };

  const recalled = items.find((p) => p.id === lastRecalledPresetId);
  if (recalled?.id != null && contentCheck(recalled) === true) {
    lit.add(recalled.id);
    return lit;
  }

  // Signature matches are exact (all tracks, in order) — light the first one
  // even without a recall on record. Collage fingerprints stay a fallback:
  // only an unambiguous single match lights.
  const sigFirst = items.find((p) => p.type === "MediaQueue" && sigMatch(p));
  const mqMatches = items.filter((p) => p.type === "MediaQueue" && mqContent(p));
  if (sigFirst?.id != null) lit.add(sigFirst.id);
  else if (mqMatches.length === 1 && mqMatches[0].id != null) lit.add(mqMatches[0].id);
  for (const p of items) {
    if (p.id == null || p.type === "MediaQueue") continue;
    if (p.airable_radio_id != null && radioId != null) {
      if (p.airable_radio_id === radioId) lit.add(p.id);
      continue;
    }
    if ((p.class ?? "").startsWith("stream.media")) {
      if (mqMatches.length === 0 && sigFirst == null && albumMatch(p)) lit.add(p.id);
      continue;
    }
    if (isRadioPreset(p) && stationMatch(p)) {
      lit.add(p.id);
      continue;
    }
    // Radio/input presets with nothing to match: trust the flag except while
    // local media is the active source. NEVER for a radio preset while a
    // station is playing: the firmware leaves a recalled station's flag on
    // when another station is streamed by URL (a raw stream carries no
    // radio_id, so the id check above never runs), and the old preset stayed
    // lit through the whole new station. A radio preset
    // lights by id or by name, or not at all, once radio metadata is present.
    if (
      p.is_playing === true &&
      activeSource !== "MEDIA_PLAYER" &&
      !(isRadioPreset(p) && md != null && isRadioMetadata(md))
    )
      lit.add(p.id);
  }
  // A recall made from standby owns the lamp until it lands.
  if (wakeRecallId != null) {
    return lit.has(wakeRecallId) ? new Set([wakeRecallId]) : new Set<number>();
  }
  return lit;
}
