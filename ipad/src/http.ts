// HTTP shim: CapacitorHttp when the native bridge is present (native URLSession
// requests — no CORS, which SMOIP HTTP posts and UPnP SOAP need), plain fetch
// otherwise (dev harnesses, desktop browser previews).

export interface HttpResponse {
  status: number
  /** Response body as text (SOAP XML or JSON — caller parses). */
  body: string
}

interface CapacitorHttpPlugin {
  request(options: {
    url: string
    method: string
    headers?: Record<string, string>
    data?: string
    responseType?: string
  }): Promise<{ status: number; data: unknown }>
}

const capacitorHttp = (): CapacitorHttpPlugin | null => {
  const cap = (globalThis as { Capacitor?: { Plugins?: { CapacitorHttp?: CapacitorHttpPlugin } } })
    .Capacitor
  return cap?.Plugins?.CapacitorHttp ?? null
}

export async function httpRequest(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<HttpResponse> {
  const native = capacitorHttp()
  if (native) {
    const res = await native.request({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers,
      data: init?.body,
      responseType: 'text'
    })
    return { status: res.status, body: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) }
  }
  const res = await fetch(url, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body })
  return { status: res.status, body: await res.text() }
}
