import { protocol } from "electron";
import { artThumb } from "../lookups/artThumbs";
import { deviceManager } from "./runtime";

/** Serves the tt-art scheme app/boot registered (split out of index.ts in the 0.11.0 sweep);
 *  called once, in whenReady. */
export function serveArtProtocol(): void {
  // tt-art://thumb/<tier>/<key>?u=<origin>: the cache answers, or makes the
  // thumbnail from the origin once; our own responses carry a long lifetime
  // so the browser cache answers re-draws without asking main
  protocol.handle("tt-art", async (req) => {
    const url = new URL(req.url);
    const [, tier, key] = url.pathname.split("/");
    const origin = url.searchParams.get("u");
    if ((tier !== "thumb" && tier !== "card") || !key || !origin)
      return new Response(null, { status: 400 });
    // the streamer's own art server is fetched one picture at a time
    let device = false;
    try {
      const conn = deviceManager.snapshot().connection;
      device = conn.phase === "connected" && new URL(origin).hostname === conn.host.split(":")[0];
    } catch {
      device = false;
    }
    const got = await artThumb(decodeURIComponent(key), tier, origin, device);
    if (!got) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(got.bytes), {
      headers: {
        "content-type": got.type,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });
}
