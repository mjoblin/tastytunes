import { describe, expect, it } from "vitest";
import { allowed, localOnly, privateAddress, v6Groups } from "./fetchGuard";

describe("v6Groups", () => {
  it("reads the compressed, dotted and expanded forms alike", () => {
    const mapped = [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1];
    expect(v6Groups("::ffff:7f00:1")).toEqual(mapped);
    expect(v6Groups("::ffff:127.0.0.1")).toEqual(mapped);
    expect(v6Groups("0:0:0:0:0:ffff:7f00:1")).toEqual(mapped);
    expect(v6Groups("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(v6Groups("fe80::1%en0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("refuses what is not an address", () => {
    expect(v6Groups("1::2::3")).toBeNull();
    expect(v6Groups("gggg::1")).toBeNull();
    expect(v6Groups("1:2:3:4:5:6:7")).toBeNull();
    expect(v6Groups("::ffff:300.0.0.1")).toBeNull();
  });
});

describe("privateAddress", () => {
  it("judges IPv4 by its ranges", () => {
    expect(privateAddress("127.0.0.1")).toBe(true);
    expect(privateAddress("192.168.50.45")).toBe(true);
    expect(privateAddress("10.1.2.3")).toBe(true);
    expect(privateAddress("169.254.1.1")).toBe(true);
    expect(privateAddress("224.0.0.1")).toBe(true);
    expect(privateAddress("8.8.8.8")).toBe(false);
  });

  it("judges an IPv4 address carried in IPv6 as that address, in every spelling", () => {
    // the 0.11 re-score's bypass: the URL parser writes [::ffff:127.0.0.1] this way
    expect(privateAddress("::ffff:7f00:1")).toBe(true);
    expect(privateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(privateAddress("0:0:0:0:0:ffff:c0a8:322d")).toBe(true);
    expect(privateAddress("::7f00:1")).toBe(true);
    expect(privateAddress("64:ff9b::7f00:1")).toBe(true);
    expect(privateAddress("::ffff:808:808")).toBe(false);
    expect(privateAddress("64:ff9b::808:808")).toBe(false);
  });

  it("judges IPv6 by its ranges", () => {
    expect(privateAddress("::1")).toBe(true);
    expect(privateAddress("::")).toBe(true);
    expect(privateAddress("fd12:3456::1")).toBe(true);
    expect(privateAddress("fe80::1")).toBe(true);
    expect(privateAddress("ff02::1")).toBe(true);
    expect(privateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("counts an address it cannot read as private", () => {
    expect(privateAddress("not-an-address")).toBe(true);
  });
});

describe("allowed", () => {
  const none = (): boolean => false;
  const resolveTo =
    (...addresses: string[]) =>
    (): Promise<{ address: string }[]> =>
      Promise.resolve(addresses.map((address) => ({ address })));

  it("refuses a loopback address written as IPv4-mapped IPv6", async () => {
    expect(await allowed(new URL("http://[::ffff:127.0.0.1]:8123/art"), none)).toBe(false);
    expect(await allowed(new URL("http://[::ffff:7f00:1]/"), none)).toBe(false);
    expect(await allowed(new URL("http://[::1]/"), none)).toBe(false);
  });

  it("lets a trusted host on the local network through, and no other", async () => {
    const nas = (h: string): boolean => h === "192.168.50.101";
    expect(await allowed(new URL("http://192.168.50.101:9790/aa/1/cover.jpg"), nas)).toBe(true);
    expect(await allowed(new URL("http://192.168.50.102/x.jpg"), nas)).toBe(false);
  });

  it("refuses other schemes and local names", async () => {
    expect(await allowed(new URL("file:///etc/passwd"), none)).toBe(false);
    expect(await allowed(new URL("ftp://example.com/x.jpg"), none)).toBe(false);
    expect(await allowed(new URL("http://localhost/x.jpg"), none)).toBe(false);
    expect(await allowed(new URL("http://nas.local/x.jpg"), none)).toBe(false);
    expect(await allowed(new URL("http://nas/x.jpg"), none)).toBe(false);
  });

  it("checks what a name resolves to", async () => {
    const url = new URL("https://art.example.com/cover.jpg");
    expect(await allowed(url, none, resolveTo("93.184.216.34"))).toBe(true);
    expect(await allowed(url, none, resolveTo("10.0.0.5"))).toBe(false);
    expect(await allowed(url, none, resolveTo("93.184.216.34", "::ffff:7f00:1"))).toBe(false);
    expect(await allowed(url, none, resolveTo())).toBe(false);
  });
});

describe("localOnly", () => {
  it("is a private address or a name only the local network has", () => {
    expect(localOnly("192.168.50.101")).toBe(true);
    expect(localOnly("10.0.0.4")).toBe(true);
    expect(localOnly("localhost")).toBe(true);
    expect(localOnly("nas.local")).toBe(true);
    expect(localOnly("minimserver")).toBe(true);
  });
  it("is not a public address or a dotted public name", () => {
    expect(localOnly("8.8.8.8")).toBe(false);
    expect(localOnly("upload.wikimedia.org")).toBe(false);
  });
});
