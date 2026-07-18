// Minimal ContentDirectory access for the spike: enough to prove the
// media-library seam works over the HTTP shim (server list via the
// streamer's /smoip/system/upnp — no SSDP, so no multicast entitlement —
// then SOAP Browse with paging).
//
// The desktop reference is src/main/upnpBrowser.ts; TODO(port): hoist its
// full DIDL mapping (classes, furniture rules, search grammar) into
// src/shared/ so both shells consume one implementation.
import { XMLParser } from 'fast-xml-parser'
import type { MediaNode, MediaServerInfo } from '../../src/shared/ipc'
import { httpRequest } from './http.js'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

interface ServerEndpoint extends MediaServerInfo {
  controlUrl: string
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v])

/** Servers the streamer knows about, with their ContentDirectory endpoints resolved. */
export async function fetchServers(streamerHost: string): Promise<ServerEndpoint[]> {
  const res = await httpRequest(`http://${streamerHost}/smoip/system/upnp`)
  if (res.status !== 200) throw new Error(`system/upnp -> ${res.status}`)
  const devices = (JSON.parse(res.body) as {
    data?: { devices?: Array<{ udn: string; name: string; model?: string; description_url: string }> }
  }).data?.devices
  const out: ServerEndpoint[] = []
  for (const d of devices ?? []) {
    const desc = await httpRequest(d.description_url)
    if (desc.status !== 200) continue
    const doc = parser.parse(desc.body) as {
      root?: { device?: { UDN?: string; serviceList?: { service?: unknown } } }
    }
    const services = asArray(doc.root?.device?.serviceList?.service) as Array<{
      serviceType?: string
      controlURL?: string
    }>
    const cd = services.find((s) => String(s.serviceType).includes('ContentDirectory'))
    if (!cd?.controlURL) continue
    out.push({
      udn: d.udn,
      name: d.name,
      model: d.model ?? null,
      isStreamer: false, // TODO(port): match against /system/info udn like upnpBrowser.ts
      searchable: false, // TODO(port): GetSearchCapabilities probe
      controlUrl: new URL(String(cd.controlURL), d.description_url).toString()
    })
  }
  return out
}

const text = (v: unknown): string | null => {
  if (v == null) return null
  if (typeof v === 'object') return String((v as { '#text'?: unknown })['#text'] ?? '')
  return String(v)
}

function didlToNodes(didlXml: string): MediaNode[] {
  const doc = parser.parse(didlXml) as {
    'DIDL-Lite'?: { container?: unknown; item?: unknown }
  }
  const lite = doc['DIDL-Lite']
  const nodes: MediaNode[] = []
  type RawEntry = Record<string, unknown> & { '@_id'?: string; '@_parentID'?: string }
  const push = (raw: RawEntry, isContainer: boolean): void => {
    nodes.push({
      id: String(raw['@_id'] ?? ''),
      parentId: raw['@_parentID'] != null ? String(raw['@_parentID']) : null,
      title: text(raw['dc:title']) ?? '',
      upnpClass: text(raw['upnp:class']) ?? (isContainer ? 'object.container' : 'object.item'),
      isContainer,
      artUrl: text(raw['upnp:albumArtURI']),
      artist: text(raw['upnp:artist']),
      album: text(raw['upnp:album']),
      year: text(raw['dc:date'])?.slice(0, 4) ?? null,
      trackNumber: raw['upnp:originalTrackNumber'] != null ? Number(text(raw['upnp:originalTrackNumber'])) : null,
      durationSecs: null // TODO(port): parse res@duration like upnpBrowser.ts
    })
  }
  for (const c of asArray(lite?.container) as RawEntry[]) push(c, true)
  for (const i of asArray(lite?.item) as RawEntry[]) push(i, false)
  return nodes
}

/** One paged ContentDirectory Browse (direct children). */
export async function browseChildren(controlUrl: string, objectId: string): Promise<MediaNode[]> {
  const out: MediaNode[] = []
  let start = 0
  // page like the desktop implementation — servers cap each response
  for (;;) {
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>
<u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
<ObjectID>${objectId}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter>
<StartingIndex>${start}</StartingIndex><RequestedCount>500</RequestedCount><SortCriteria></SortCriteria>
</u:Browse></s:Body></s:Envelope>`
    const res = await httpRequest(controlUrl, {
      method: 'POST',
      headers: {
        'content-type': 'text/xml; charset="utf-8"',
        soapaction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'
      },
      body: envelope
    })
    if (res.status !== 200) throw new Error(`Browse ${objectId} -> ${res.status}`)
    const resultXml = res.body.match(/<Result>([\s\S]*?)<\/Result>/)?.[1]
    const total = Number(res.body.match(/<TotalMatches>(\d+)<\/TotalMatches>/)?.[1] ?? 0)
    if (!resultXml) break
    // the Result element is entity-escaped DIDL — unescape then parse
    const didl = resultXml
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
    const page = didlToNodes(didl)
    out.push(...page)
    start += page.length
    if (page.length === 0 || start >= total) break
  }
  return out
}
