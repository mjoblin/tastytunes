import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/**
 * THE ADDRESS ANOTHER COMPUTER ON THE LOCAL NETWORK REACHES, for the agents' server's setup lines
 * and Display on other screens' address and QR code (servers/mcpServer, app/display): an IPv4 on
 * this computer's network, never the loopback.
 *
 * - The interface whose network holds the connected streamer wins: the screens and agents that
 *   want this computer sit on that network.
 * - Without one (no streamer connected, or one reached by name or across a router), a private
 *   address on a physical interface first. A VPN's address (0.16.0: the first external address
 *   found could be a VPN's, and the setup line then reached nothing) and a virtual machine's or a
 *   container's adapter (Hyper-V and WSL, VMware, VirtualBox, a bridge, Docker), which only this
 *   computer and its guests reach, go last. A tie keeps the system's order.
 */

const VPN = /^(utun|tun|tap|ppp|wg|ipsec|zt|tailscale|gpd)/i;
const VIRTUAL = /^(vEthernet|vmnet|vboxnet|vnic|bridge|docker|br-|virbr|veth)|VMware|VirtualBox/i;
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** A dotted IPv4 address as a number, or null for anything else. */
function ipv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

/** Whether `host` is an IPv4 address on the network of `address` with `netmask`. */
function onNetwork(host: string, address: string, netmask: string): boolean {
  const h = ipv4(host);
  const a = ipv4(address);
  const m = ipv4(netmask);
  if (h == null || a == null || m == null || m === 0) return false;
  // bitwise in 32 bits, unsigned
  return (h & m) >>> 0 === (a & m) >>> 0;
}

/** The choice, from what the system lists (`interfaces`) and the connected streamer's address. */
export function pickLanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  streamer: string | null,
): string | null {
  const found: { name: string; address: string; netmask: string }[] = [];
  for (const [name, addrs] of Object.entries(interfaces))
    for (const a of addrs ?? [])
      if (a.family === "IPv4" && !a.internal)
        found.push({ name, address: a.address, netmask: a.netmask });
  const rank = (c: { name: string; address: string; netmask: string }): number =>
    streamer != null && onNetwork(streamer, c.address, c.netmask)
      ? -1
      : (VPN.test(c.name) || VIRTUAL.test(c.name) ? 2 : 0) + (PRIVATE.test(c.address) ? 0 : 1);
  return found.sort((x, y) => rank(x) - rank(y))[0]?.address ?? null;
}

/** This computer's address on the local network, by the rules above. */
export function lanAddress(streamer: string | null = null): string | null {
  return pickLanAddress(networkInterfaces(), streamer);
}
