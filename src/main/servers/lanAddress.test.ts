import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { pickLanAddress } from "./lanAddress";

/** One IPv4 address as the system lists it. */
const v4 = (address: string, netmask = "255.255.255.0"): NetworkInterfaceInfo => ({
  address,
  netmask,
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal: false,
  cidr: null,
});
const loopback: NetworkInterfaceInfo = { ...v4("127.0.0.1", "255.0.0.0"), internal: true };

describe("the address another computer on the network reaches", () => {
  it("takes the interface whose network holds the connected streamer, wherever it is listed", () => {
    const listed = {
      lo0: [loopback],
      en0: [v4("10.0.0.5")],
      en7: [v4("192.168.1.7")],
    };
    expect(pickLanAddress(listed, "192.168.1.20")).toBe("192.168.1.7");
    expect(pickLanAddress(listed, "10.0.0.9")).toBe("10.0.0.5");
  });

  it("takes the streamer's network even on an adapter it would otherwise rank down", () => {
    const listed = { en0: [v4("10.0.0.5")], "vEthernet (External)": [v4("172.20.0.4")] };
    expect(pickLanAddress(listed, "172.20.0.30")).toBe("172.20.0.4");
  });

  it("prefers the physical interface when a VPN's or a virtual adapter's wide mask holds the streamer too", () => {
    // both hold 10.1.2.20, the VPN listed first: the system's order no longer decides
    expect(
      pickLanAddress({ utun3: [v4("10.8.0.2", "255.0.0.0")], en0: [v4("10.1.2.7")] }, "10.1.2.20"),
    ).toBe("10.1.2.7");
    expect(
      pickLanAddress(
        { "vEthernet (WSL)": [v4("172.16.0.1", "255.240.0.0")], "Wi-Fi": [v4("172.20.0.4")] },
        "172.20.0.30",
      ),
    ).toBe("172.20.0.4");
    // and a VPN that alone holds the streamer still beats a physical interface that doesn't
    expect(
      pickLanAddress(
        { en0: [v4("192.168.1.7")], utun3: [v4("10.8.0.2", "255.0.0.0")] },
        "10.1.2.20",
      ),
    ).toBe("10.8.0.2");
  });

  it("ranks virtual machines' and containers' adapters below a physical one", () => {
    for (const name of [
      "vEthernet (WSL)",
      "vEthernet (Default Switch)",
      "VMware Network Adapter VMnet8",
      "VirtualBox Host-Only Network",
      "vmnet8",
      "vboxnet0",
      "bridge100",
      "docker0",
      "br-3f2a9c",
    ])
      expect(
        pickLanAddress({ [name]: [v4("172.18.0.1")], "Wi-Fi": [v4("192.168.1.7")] }, null),
      ).toBe("192.168.1.7");
  });

  it("falls back to today's ranking without a streamer, or with one on no listed network", () => {
    const listed = {
      utun3: [v4("10.8.0.2")],
      en0: [v4("203.0.113.9")],
      en1: [v4("192.168.1.7")],
    };
    // a private address on a physical interface, then the rest, the VPN last
    expect(pickLanAddress(listed, null)).toBe("192.168.1.7");
    expect(pickLanAddress(listed, "198.51.100.4")).toBe("192.168.1.7");
    expect(pickLanAddress(listed, "streamer.local")).toBe("192.168.1.7");
    expect(pickLanAddress({ utun3: [v4("10.8.0.2")], en0: [v4("203.0.113.9")] }, null)).toBe(
      "203.0.113.9",
    );
  });

  it("keeps the system's order in a tie, and answers null with nothing to offer", () => {
    expect(pickLanAddress({ en0: [v4("192.168.1.7")], en1: [v4("192.168.2.8")] }, null)).toBe(
      "192.168.1.7",
    );
    expect(pickLanAddress({ lo0: [loopback] }, null)).toBeNull();
    expect(pickLanAddress({}, "192.168.1.20")).toBeNull();
  });
});
