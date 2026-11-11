import { describe, expect, it } from "vitest";
import { connectTrouble } from "./connectTrouble";

describe("connectTrouble", () => {
  it("says what each failure means, never its code", () => {
    for (const [reason, says] of [
      ["connect ECONNREFUSED 10.0.0.5:80", "turned the connection away"],
      ["Unexpected server response: 404", "but not a StreamMagic streamer"],
      ["getaddrinfo ENOTFOUND evo.local", "That name isn't known on your network."],
      ["connect EHOSTUNREACH 10.0.0.5:80", "Nothing answers at that address."],
      ["Opening handshake has timed out", "Nothing answered at that address in time."],
      ["connect ETIMEDOUT 10.0.0.5:80", "Nothing answered at that address in time."],
    ] as const) {
      const text = connectTrouble(reason);
      expect(text).toContain(says);
      expect(text).not.toMatch(/E[A-Z]{4,}|\d{3}/);
    }
  });

  it("has nothing to add for a reason that says nothing", () => {
    expect(connectTrouble("closed (code 1006)")).toBeNull();
    expect(connectTrouble(null)).toBeNull();
    expect(connectTrouble("socket hang up")).toBeNull();
  });
});
