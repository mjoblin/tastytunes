import { afterEach, describe, expect, it, vi } from "vitest";
import { ART_MAX_BYTES, pageArt } from "./webBridge";

const ID = "/art/0123456789abcdef01234567";

function serve(body: Uint8Array, type = "image/png", length: number | null = body.length) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    asked.push(url);
    const headers = new Headers({ "content-type": type });
    if (length != null) headers.set("content-length", String(length));
    return Promise.resolve(new Response(body.buffer as ArrayBuffer, { status: 200, headers }));
  });
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe("the page's cover, for the scenes' colors", () => {
  it("hands back the server's own picture as a data URL", async () => {
    const asked = serve(new Uint8Array([137, 80, 78, 71]), "image/png; charset=binary");
    expect(await pageArt(ID)).toEqual({ dataUrl: "data:image/png;base64,iVBORw==" });
    expect(asked).toEqual([ID]);
  });

  it("asks for nothing but the server's own /art/<id>", async () => {
    const asked = serve(new Uint8Array([1]));
    for (const url of [
      "http://10.0.0.5:9790/aa/1/cover.jpg",
      "//evil.example/art/0123456789abcdef01234567",
      "/art/../api/snapshot",
      "/art/0123456789abcdef01234567?x=1",
      "data:image/png;base64,AAAA",
    ])
      expect(await pageArt(url)).toBeNull();
    expect(asked).toEqual([]);
  });

  it("refuses what isn't a picture, and a picture past the window's cap", async () => {
    serve(new Uint8Array([1]), "text/html");
    expect(await pageArt(ID)).toBeNull();
    serve(new Uint8Array([1]), "image/jpeg", ART_MAX_BYTES + 1);
    expect(await pageArt(ID)).toBeNull();
    // a server that names no length is counted as it arrives
    serve(new Uint8Array(ART_MAX_BYTES + 1), "image/jpeg", null);
    expect(await pageArt(ID)).toBeNull();
  });
});
