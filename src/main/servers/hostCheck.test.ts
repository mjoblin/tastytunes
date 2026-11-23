import { describe, expect, it } from "vitest";
import { hostAllowed, hostName } from "./hostCheck";

describe("the host a request names", () => {
  it("reads the name without its port or brackets", () => {
    expect(hostName("Studio-Mac.local:8556")).toBe("studio-mac.local");
    expect(hostName("[fe80::1%en0]:8556")).toBe("fe80::1%en0");
    expect(hostName(undefined)).toBe("");
  });

  it("lets this machine's names in on the loopback reach, nothing else", () => {
    expect(hostAllowed("127.0.0.1:8765", "loopback")).toBe(true);
    expect(hostAllowed("localhost:8765", "loopback")).toBe(true);
    expect(hostAllowed("192.168.1.2:8765", "loopback")).toBe(false);
    expect(hostAllowed("evil.example.com", "loopback")).toBe(false);
  });

  it("lets a network's own names in on the network reach, never a public name", () => {
    for (const ok of [
      "192.168.1.2:8556",
      "[::1]:8556",
      "studio-mac",
      "studio-mac.local",
      "mac.lan",
    ])
      expect(hostAllowed(ok, "network")).toBe(true);
    for (const no of ["evil.example.com", "rebind.attacker.net:8556", "", undefined])
      expect(hostAllowed(no, "network")).toBe(false);
  });
});
