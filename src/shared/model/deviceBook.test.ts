import { describe, expect, it } from "vitest";
import { bookAfterConnect, bookAfterSweep, SEEN_REFRESH_MS, type KnownDevice } from "./settings";

const NOW = 1_800_000_000_000;
const lounge: KnownDevice = {
  udn: "uuid-lounge",
  host: "10.0.0.5",
  friendlyName: "Lounge",
  model: "Evo 150",
  lastSeenAt: NOW - 60_000,
};
const kitchen: KnownDevice = {
  udn: "uuid-kitchen",
  host: "10.0.0.9",
  friendlyName: "Kitchen",
  model: "Evo 75",
  lastSeenAt: NOW - 5 * 60_000,
};
const sighting = (d: KnownDevice, over: Partial<KnownDevice> = {}) => ({
  udn: d.udn,
  host: d.host,
  friendlyName: d.friendlyName,
  model: d.model,
  descriptionUrl: "",
  ...over,
});

describe("the device book after a sweep", () => {
  it("writes nothing for streamers seen as they were, within the hour", () => {
    expect(
      bookAfterSweep([lounge, kitchen], [sighting(lounge), sighting(kitchen)], NOW),
    ).toBeNull();
  });

  it("takes a new address at once, in place, without reordering", () => {
    const next = bookAfterSweep([lounge, kitchen], [sighting(kitchen, { host: "10.0.0.10" })], NOW);
    expect(next?.map((d) => d.udn)).toEqual(["uuid-lounge", "uuid-kitchen"]);
    expect(next?.[1]).toMatchObject({ host: "10.0.0.10", lastSeenAt: NOW });
    expect(next?.[0]).toBe(lounge);
  });

  it("refreshes the time only once it is an hour old", () => {
    const stale = { ...lounge, lastSeenAt: NOW - SEEN_REFRESH_MS };
    const next = bookAfterSweep([stale, kitchen], [sighting(stale), sighting(kitchen)], NOW);
    expect(next?.[0].lastSeenAt).toBe(NOW);
    expect(next?.[1]).toBe(kitchen);
  });

  it("keeps a known name when the sighting has none, and never learns a stranger", () => {
    const stranger = { ...sighting(kitchen), udn: "uuid-stranger" };
    expect(
      bookAfterSweep([lounge], [sighting(lounge, { friendlyName: "" }), stranger], NOW),
    ).toBeNull();
  });
});

describe("the device book after a connection", () => {
  it("writes nothing when the streamer is already first, unchanged and seen within the hour", () => {
    expect(bookAfterConnect([lounge, kitchen], sighting(lounge), NOW)).toBeNull();
  });

  it("puts the streamer first, the rest newest-seen first", () => {
    const older = { ...lounge, udn: "uuid-older", lastSeenAt: NOW - 10 * 60_000 };
    const next = bookAfterConnect([older, lounge, kitchen], sighting(kitchen), NOW);
    expect(next?.map((d) => d.udn)).toEqual(["uuid-kitchen", "uuid-lounge", "uuid-older"]);
    expect(next?.[0].lastSeenAt).toBe(NOW);
  });

  it("writes when the first streamer's address changed or its time is an hour old", () => {
    expect(bookAfterConnect([lounge], sighting(lounge, { host: "10.0.0.6" }), NOW)?.[0].host).toBe(
      "10.0.0.6",
    );
    const stale = { ...lounge, lastSeenAt: NOW - SEEN_REFRESH_MS };
    expect(bookAfterConnect([stale], sighting(stale), NOW)?.[0].lastSeenAt).toBe(NOW);
  });
});
