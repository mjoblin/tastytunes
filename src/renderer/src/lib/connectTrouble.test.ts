import { describe, expect, it } from "vitest";
import { connectTrouble } from "./connectTrouble";

describe("connectTrouble", () => {
  it("says what each failure means, never its code", () => {
    for (const [reason, says] of [
      ["connect ECONNREFUSED 10.0.0.5:80", "refused the connection"],
      ["Unexpected server response: 404", "but not a StreamMagic streamer"],
      ["getaddrinfo ENOTFOUND evo.local", "That name isn't known on your network."],
      ["connect EHOSTUNREACH 10.0.0.5:80", "Nothing answers at that address."],
      ["Opening handshake has timed out", "Nothing answers at that address."],
      ["connect ETIMEDOUT 10.0.0.5:80", "Nothing answers at that address."],
    ] as const) {
      const text = connectTrouble(reason);
      expect(text).toContain(says);
      expect(text).not.toMatch(/E[A-Z]{4,}|\d{3}/);
    }
  });

  it("offers the Mac's Local Network setting beside an off streamer, only for no route to host", () => {
    const mac = { localNetworkPrivacy: true };
    const blocked = connectTrouble("connect EHOSTUNREACH 192.168.1.20:80", mac);
    expect(blocked).toBe(
      "Nothing answers at that address. It may be off or in eco standby. If it's on, your Mac may be blocking TastyTunes from your local network. Check System Settings › Privacy & Security › Local Network, and if TastyTunes is already on there, turn it off and on.",
    );
    // a timeout reached the network and found nothing there; a Mac without the setting has no line
    expect(connectTrouble("connect ETIMEDOUT 192.168.1.20:80", mac)).not.toContain("Local Network");
    expect(connectTrouble("connect EHOSTUNREACH 192.168.1.20:80")).not.toContain("Local Network");
  });

  it("has nothing to add for a reason that says nothing", () => {
    expect(connectTrouble("closed (code 1006)")).toBeNull();
    expect(connectTrouble(null)).toBeNull();
    expect(connectTrouble("socket hang up")).toBeNull();
  });
});
