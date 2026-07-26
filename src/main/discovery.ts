// SSDP/UPnP discovery of Cambridge Audio StreamMagic streamers.
//
// Sends an M-SEARCH for MediaRenderer devices, fetches each responder's UPnP
// description.xml, and keeps the ones manufactured by Cambridge Audio — the same
// approach PunyTunes and vibin use.

import { createSocket } from 'node:dgram'
import { loggedFetch } from './netlog'
import { XMLParser } from 'fast-xml-parser'
import type { DiscoveredDevice } from '@shared/model'

// TASTYTUNES_SSDP_TARGET ('host:port') lets test harnesses stand in for the
// LAN: the M-SEARCH goes there unicast instead of to the multicast group, so
// harness runs never sweep (or find) the real network.
const OVERRIDE = process.env['TASTYTUNES_SSDP_TARGET']?.split(':')
const SSDP_ADDRESS = OVERRIDE?.[0] ?? '239.255.255.250'
const SSDP_PORT = OVERRIDE?.[1] ? Number(OVERRIDE[1]) : 1900
const SEARCH_TARGET = 'urn:schemas-upnp-org:device:MediaRenderer:1'

function mSearchDatagram(): Buffer {
  return Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      'MX: 2',
      `ST: ${SEARCH_TARGET}`,
      '',
      ''
    ].join('\r\n')
  )
}

/** Collect unique LOCATION header values from M-SEARCH responses. */
function ssdpSearch(timeoutMs: number): Promise<string[]> {
  return new Promise((resolvePromise) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    const locations = new Set<string>()

    const finish = (): void => {
      try {
        socket.close()
      } catch {
        // already closed
      }
      resolvePromise([...locations])
    }

    const timer = setTimeout(finish, timeoutMs)

    socket.on('error', () => {
      clearTimeout(timer)
      finish()
    })

    socket.on('message', (msg) => {
      const match = /^location:\s*(.+)$/im.exec(msg.toString())
      if (match) locations.add(match[1].trim())
    })

    socket.bind(() => {
      const datagram = mSearchDatagram()
      // Send twice — SSDP is UDP and responders routinely miss a single probe.
      socket.send(datagram, SSDP_PORT, SSDP_ADDRESS)
      setTimeout(() => {
        try {
          socket.send(datagram, SSDP_PORT, SSDP_ADDRESS)
        } catch {
          // socket may already be closed
        }
      }, 400)
    })
  })
}

interface DeviceDescription {
  manufacturer: string
  friendlyName: string
  model: string
  udn: string
}

async function fetchDescription(location: string): Promise<DeviceDescription | null> {
  const res = await loggedFetch('ssdp', location, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) return null
  const xml = await res.text()
  const parsed = new XMLParser({ ignoreAttributes: true }).parse(xml)
  const device = parsed?.root?.device
  if (!device) return null
  return {
    manufacturer: String(device.manufacturer ?? ''),
    friendlyName: String(device.friendlyName ?? ''),
    model: String(device.modelName ?? ''),
    udn: String(device.UDN ?? '')
  }
}

export async function discoverStreamers(timeoutMs = 3500): Promise<DiscoveredDevice[]> {
  const locations = await ssdpSearch(timeoutMs)
  const described = await Promise.all(
    locations.map(async (location) => {
      try {
        const desc = await fetchDescription(location)
        return desc ? { location, desc } : null
      } catch {
        return null
      }
    })
  )

  const devices = new Map<string, DiscoveredDevice>()
  for (const entry of described) {
    if (!entry) continue
    const { location, desc } = entry
    if (!/cambridge audio/i.test(desc.manufacturer)) continue
    const host = new URL(location).hostname
    const key = desc.udn || host
    if (!devices.has(key)) {
      devices.set(key, {
        host,
        friendlyName: desc.friendlyName || desc.model || host,
        model: desc.model,
        udn: desc.udn,
        descriptionUrl: location
      })
    }
  }
  return [...devices.values()]
}
