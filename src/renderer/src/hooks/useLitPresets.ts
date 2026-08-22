import { useMemo } from "react";
import { presetVolumeKey } from "@shared/model";
import { queueContentHash, type PresetItem } from "@shared/smoip";
import { useStore } from "@/store";
import { activeSourceId } from "@/lib/format";

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

/**
 * Which presets are PLAYING — derived from what's actually playing, never from
 * the device's own flags.
 *
 * THE STREAMER'S `is_playing` CANNOT BE TRUSTED, and this is the memo of why:
 *  - radio presets aren't cleared when you switch to local media (vibin hit
 *    this too — its `_fix_stale_preset_is_playing`), and
 *  - media (album) presets only report `is_playing` transiently around the
 *    recall; any later read returns false (vibinui's own TODO: "When the UI is
 *    refreshed, a stream.media.upnp preset will have an is_playing of false,
 *    even if it was playing").
 * So the answer is derived statelessly: radio_id is authoritative for
 * stations, saved queues match on an exact signature or an art fingerprint,
 * album presets match by art URL or name against the current track. Stateless
 * also means it works at startup, when every flag reads false.
 *
 * Lifted out of PresetsScreen 2026-07-28 so the tray panel gets the same
 * answer — it was lighting tiles straight off `is_playing` and therefore
 * mostly not lighting them at all. A rule this hard-won must not exist twice.
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
export function useLitPresets(
  items: PresetItem[],
  /** A recall issued while the streamer slept owns the lamp until it lands —
   *  screen-local state, so the caller passes it (see PresetsScreen). */
  wakeRecallId: number | null = null,
): Set<number> {
  const zoneState = useStore((s) => s.zoneState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const playState = useStore((s) => s.playState);
  const queue = useStore((s) => s.queue);
  const systemInfo = useStore((s) => s.systemInfo);
  const systemPower = useStore((s) => s.systemPower);
  const waking = useStore((s) => s.waking);
  const lastRecalledPresetId = useStore((s) => s.lastRecalledPresetId);
  const queueSignatures = useStore((s) => s.settings.queueSignatures);

  const activeSource = activeSourceId(zoneState, nowPlaying);
  const radioId = playState?.metadata?.radio_id ?? null;
  const md = playState?.metadata ?? null;
  // A LIT PRESET MEANS "THIS IS PLAYING" — so nothing lights while the
  // streamer is asleep or on its way back. A waking device re-announces its
  // RETAINED pre-standby play_state, so the old preset's content check passes
  // again mid-wake and follow glides at it, then glides again when the real
  // recall lands. Suppressing the lamp for the whole not-ON window removes the
  // transition rather than racing it.
  const asleep = (systemPower != null && systemPower.power !== "ON") || waking;

  // The live queue's leading distinct-album art sequence — the same
  // fingerprint the firmware bakes into a MediaQueue preset's art_urls.
  const queueArts = useMemo(() => {
    const seen: string[] = [];
    for (const it of queue?.items ?? []) {
      const a = it.metadata?.art_url;
      if (a && !seen.some((s) => urlsMatch(s, a))) seen.push(a);
    }
    return seen;
  }, [queue]);

  // Exact identity of the live queue (all tracks, in order).
  const liveQueueHash = useMemo(
    () => (queue?.items?.length ? queueContentHash(queue.items) : null),
    [queue],
  );

  return useMemo(() => {
    const lit = new Set<number>();
    if (asleep) return lit;
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
      if (p.is_playing === true) return true; // transiently correct after recall
      if (!md) return false;
      if (p.art_url != null && md.art_url != null && urlsMatch(p.art_url, md.art_url)) return true;
      if (p.name != null && md.album != null) {
        if (p.name === md.album) return true;
        if (md.artist != null && p.name.includes(md.album) && p.name.includes(md.artist))
          return true;
      }
      return false;
    };
    // Raw-URL radio presets (saved from the Radio screen) carry no airable id
    // — the station NAME is their identity.
    const isRadioPreset = (p: PresetItem): boolean =>
      /radio/i.test(p.class ?? "") || p.type === "Radio";
    const stationMatch = (p: PresetItem): boolean => {
      const station = md?.station?.trim().toLowerCase();
      return station != null && p.name?.trim().toLowerCase() === station;
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
      // local media is the active source.
      if (p.is_playing === true && activeSource !== "MEDIA_PLAYER") lit.add(p.id);
    }
    // A recall made from standby owns the lamp until it lands.
    if (wakeRecallId != null) {
      return lit.has(wakeRecallId) ? new Set([wakeRecallId]) : new Set<number>();
    }
    return lit;
  }, [
    items,
    lastRecalledPresetId,
    queueArts,
    queueSignatures,
    liveQueueHash,
    systemInfo,
    radioId,
    md,
    activeSource,
    asleep,
    wakeRecallId,
  ]);
}
