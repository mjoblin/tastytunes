import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { protocol } from "electron";
import { isDeviceArt } from "@shared/artUrl";
import { pickedPath } from "../data/artistChoices";
import { artHostTrust } from "../lookups/artFetch";
import { artThumb } from "../lookups/artThumbs";
import { deviceManager } from "./runtime";

/** A copied picture's type by its file's kind (data/artistChoices: a JPEG or PNG made by the
 *  app, or a chosen picture kept as it came). */
const PICKED_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/** Serves the tt-art scheme app/boot registered (split out of index.ts in the 0.11.0 sweep);
 *  called once, in whenReady. */
export function serveArtProtocol(): void {
  // tt-art://thumb/<tier>/<key>?u=<origin>: the cache answers, or makes the
  // thumbnail from the origin once; our own responses carry a long lifetime
  // so the browser cache answers re-draws without asking main
  protocol.handle("tt-art", async (req) => {
    const url = new URL(req.url);
    // tt-art://picked/<file>: a picture file chosen for an artist, read only from the folder the
    // app copied it into, by a name the app made (data/artistChoices)
    if (url.host === "picked") {
      const path = pickedPath(decodeURIComponent(url.pathname.slice(1)));
      if (!path) return new Response(null, { status: 404 });
      try {
        return new Response(new Uint8Array(await readFile(path)), {
          headers: {
            "content-type": PICKED_TYPES[extname(path)] ?? "image/jpeg",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    }
    const [, tier, key] = url.pathname.split("/");
    const origin = url.searchParams.get("u");
    if ((tier !== "thumb" && tier !== "card") || !key || !origin)
      return new Response(null, { status: 400 });
    // the streamer's own art server is fetched one picture at a time
    const conn = deviceManager.snapshot().connection;
    const streamer = conn.phase === "connected" ? conn.host : null;
    const device = isDeviceArt(origin, streamer);
    // the origin comes from the renderer, so it is checked like every picture fetch
    const got = await artThumb(
      decodeURIComponent(key),
      tier,
      origin,
      artHostTrust(streamer),
      device,
    );
    if (!got) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(got.bytes), {
      headers: {
        "content-type": got.type,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });
}
