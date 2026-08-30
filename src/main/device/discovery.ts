// SSDP/UPnP discovery of Cambridge Audio StreamMagic streamers.
//
// Sends an M-SEARCH for MediaRenderer devices, fetches each responder's UPnP
// description.xml, and keeps the ones manufactured by Cambridge Audio — the same
// approach PunyTunes and vibin use.

import { createSocket } from "node:dgram";
import { isRecord } from "@shared/guards";
import { loggedFetch } from "../netlog";
import { XMLParser } from "fast-xml-parser";
import type { DiscoveredDevice } from "@shared/model";

// TASTYTUNES_SSDP_TARGET ('host:port', comma-separated for several) lets test
// harnesses stand in for the LAN: the M-SEARCH goes there unicast instead of
// to the multicast group, so harness runs never sweep (or find) the real
// network. Multiple targets exist for the multi-streamer scenarios — each
// mock instance answers on its own port.
const TARGETS: Array<{ address: string; port: number }> = (
  process.env["TASTYTUNES_SSDP_TARGET"] ?? "239.255.255.250:1900"
)
  .split(",")
  .map((t) => {
    const [address, port] = t.trim().split(":");
    return { address, port: port ? Number(port) : 1900 };
  });
const OVERRIDDEN = process.env["TASTYTUNES_SSDP_TARGET"] != null;
const SEARCH_TARGET = "urn:schemas-upnp-org:device:MediaRenderer:1";

function mSearchDatagram(target: { address: string; port: number }): Buffer {
  return Buffer.from(
    [
      "M-SEARCH * HTTP/1.1",
      `HOST: ${target.address}:${target.port}`,
      'MAN: "ssdp:discover"',
      "MX: 2",
      `ST: ${SEARCH_TARGET}`,
      "",
      "",
    ].join("\r\n"),
  );
}

/** Collect unique LOCATION header values from M-SEARCH responses. */
function ssdpSearch(timeoutMs: number): Promise<string[]> {
  return new Promise((resolvePromise) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const locations = new Set<string>();

    const finish = (): void => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolvePromise([...locations]);
    };

    setTimeout(finish, timeoutMs);

    // A send to a DEAD unicast target surfaces here as an ICMP refusal
    // (ECONNREFUSED) — which is exactly what a powered-off streamer's port
    // does. Ending the sweep on it would let one dead device silence every
    // live one (the multi-streamer eco report), so errors are swallowed and
    // the timeout above is the only closer.
    socket.on("error", () => {});

    socket.on("message", (msg) => {
      const match = /^location:\s*(.+)$/im.exec(msg.toString());
      if (match) locations.add(match[1].trim());
    });

    socket.bind(() => {
      // Send twice per target — SSDP is UDP and responders routinely miss a
      // single probe.
      const sendAll = (): void => {
        for (const target of TARGETS) {
          try {
            socket.send(mSearchDatagram(target), target.port, target.address);
          } catch {
            // socket may already be closed
          }
        }
      };
      sendAll();
      setTimeout(sendAll, 400);
    });
  });
}

interface DeviceDescription {
  manufacturer: string;
  friendlyName: string;
  model: string;
  udn: string;
}

async function fetchDescription(location: string): Promise<DeviceDescription | null> {
  const res = await loggedFetch("ssdp", location, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) return null;
  const xml = await res.text();
  const parsed: unknown = new XMLParser({ ignoreAttributes: true }).parse(xml);
  const root = isRecord(parsed) ? parsed.root : undefined;
  const device = isRecord(root) ? root.device : undefined;
  if (!isRecord(device)) return null;
  return {
    manufacturer: String(device.manufacturer ?? ""),
    friendlyName: String(device.friendlyName ?? ""),
    model: String(device.modelName ?? ""),
    // ONE spelling for identity: the description writes "uuid:X" where
    // /system/info writes bare "X", and the device book keys on the latter —
    // an unstripped prefix made every remembered streamer fail to match its
    // own live discovery and render twice (user, 2026-08-30).
    udn: String(device.UDN ?? "").replace(/^uuid:/i, ""),
  };
}

export async function discoverStreamers(timeoutMs = 3500): Promise<DiscoveredDevice[]> {
  const locations = await ssdpSearch(timeoutMs);
  const described = await Promise.all(
    locations.map(async (location) => {
      try {
        const desc = await fetchDescription(location);
        return desc ? { location, desc } : null;
      } catch {
        return null;
      }
    }),
  );

  const devices = new Map<string, DiscoveredDevice>();
  for (const entry of described) {
    if (!entry) continue;
    const { location, desc } = entry;
    if (!/cambridge audio/i.test(desc.manufacturer)) continue;
    // Real streamers serve SMOIP on port 80 while the UPnP description lives
    // on its own port (8050 on the Evo), so the connect target is the bare
    // hostname. The harness override runs mock streamers whose SMOIP shares
    // the description port — there, the port IS the identity.
    const host = OVERRIDDEN ? new URL(location).host : new URL(location).hostname;
    const key = desc.udn || host;
    if (!devices.has(key)) {
      devices.set(key, {
        host,
        friendlyName: desc.friendlyName || desc.model || host,
        model: desc.model,
        udn: desc.udn,
        descriptionUrl: location,
      });
    }
  }
  return [...devices.values()];
}
