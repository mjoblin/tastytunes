import type { DiscoveredDevice, KnownDevice } from "@shared/model";

/**
 * The History screen's STREAMER facet (0.8.0): the record is one listening life
 * across every streamer the app has driven, and from 0.8.0 each line names the
 * one that played it. This is the one home for reading that back: the option
 * list the rail's pill offers, the label a udn wears, and the narrowing every
 * view applies. Offered only when the record holds more than one streamer.
 */

/** The facet value for lines written before the field existed. */
export const NO_STREAMER = "before-0.8.0";

export const streamerOf = (x: { streamer?: string | null }): string => x.streamer ?? NO_STREAMER;

/** A udn's name: the device book first (remembered streamers), live discovery
 *  second, then an honest placeholder. */
export function streamerLabel(
  udn: string,
  knownDevices: readonly KnownDevice[],
  devices: readonly DiscoveredDevice[],
): string {
  return (
    knownDevices.find((d) => d.udn === udn)?.friendlyName ??
    devices.find((d) => d.udn === udn)?.friendlyName ??
    "Another streamer"
  );
}

/** The pill's options from the record's census. Empty (the pill hides) unless
 *  at least two real streamers appear; the pre-0.8.0 bucket rides along only
 *  when such lines exist, and never counts as a streamer. */
export function streamerOptions(
  census: ReadonlyArray<{ streamer: string | null; count: number }> | null,
  knownDevices: readonly KnownDevice[],
  devices: readonly DiscoveredDevice[],
): Array<{ value: string; label: string; count: number }> {
  if (!census) return [];
  const real = census.filter((c) => c.streamer != null && c.count > 0);
  if (real.length < 2) return [];
  const out = real.map((c) => ({
    value: c.streamer as string,
    label: streamerLabel(c.streamer as string, knownDevices, devices),
    count: c.count,
  }));
  const old = census.find((c) => c.streamer == null);
  if (old && old.count > 0)
    out.push({ value: NO_STREAMER, label: "Before 0.8.0", count: old.count });
  return out;
}

/** The narrowing every view applies: null is All streamers. */
export function narrowToStreamer<T extends { streamer?: string | null }>(
  items: readonly T[],
  streamer: string | null,
): T[] {
  return streamer == null ? [...items] : items.filter((x) => streamerOf(x) === streamer);
}
