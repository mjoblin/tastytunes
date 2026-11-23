import type { IncomingMessage } from "node:http";

/** What the MCP SDK's transport requires a POST to accept; with anything less it answers 406. */
export const SDK_ACCEPT = "application/json, text/event-stream";

/** The Accept header a request is handed to the transport with: its own when it lists both of the
 *  SDK's types, else both. Clients that send no Accept or a wildcard (Home Assistant's
 *  rest_command, curl) are answered with JSON like any other, since this server never streams. */
export function acceptForSdk(accept: string | string[] | undefined): string | null {
  const value = Array.isArray(accept) ? accept.join(", ") : (accept ?? "");
  return value.includes("application/json") && value.includes("text/event-stream")
    ? null
    : SDK_ACCEPT;
}

/** Gives the request the Accept the transport needs, in both places a reader may look: the
 *  parsed headers and the raw pairs (the SDK's Node wrapper builds its Request from rawHeaders). */
export function acceptBothForSdk(req: IncomingMessage): void {
  const accept = acceptForSdk(req.headers.accept);
  if (accept == null) return;
  req.headers.accept = accept;
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) {
    if (raw[i].toLowerCase() === "accept") raw.splice(i, 2);
  }
  raw.push("Accept", accept);
}
