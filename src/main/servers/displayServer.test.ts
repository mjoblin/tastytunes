import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Snapshot } from "@shared/ipc";
import { DEFAULT_SETTINGS } from "@shared/model";
import { DisplayServer } from "./displayServer";

const TOKEN = "tok-123";
const snapshot = {
  connection: { phase: "connected", host: "192.168.1.5" },
  settings: { ...DEFAULT_SETTINGS, lastHost: "192.168.1.5" },
  playState: { state: "play", metadata: { title: "Song", art_url: "http://192.168.1.5/a.jpg" } },
  nowPlaying: null,
  position: null,
  systemPower: { power: "ON" },
} as unknown as Snapshot;

let server: DisplayServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
});

async function rig() {
  const page = mkdtempSync(join(tmpdir(), "tt-display-"));
  writeFileSync(join(page, "display.html"), "<html>page</html>");
  mkdirSync(join(page, "assets"));
  writeFileSync(join(page, "assets", "a.js"), "js");
  writeFileSync(join(tmpdir(), "outside.txt"), "outside");
  const fetched: string[] = [];
  server = new DisplayServer({
    snapshot: () => snapshot,
    lyrics: () => Promise.resolve({ plain: "words" } as never),
    lyricsAllowed: () => true,
    picture: (url) => {
      fetched.push(url);
      return Promise.resolve({ bytes: Buffer.from("img"), type: "image/jpeg" });
    },
    token: () => Promise.resolve(TOKEN),
    pageDir: page,
    log: () => {},
  });
  await server.start(0, "127.0.0.1");
  const port = server.port!;
  const get = (path: string, opts: { cookie?: string; method?: string } = {}) =>
    new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: opts.method ?? "GET",
          headers: opts.cookie ? { cookie: opts.cookie } : {},
        },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  return { get, fetched };
}

const cookie = `tt_display=${TOKEN}`;

describe("Display on other screens' server", () => {
  it("lets in only the address's token, trades it for a cookie, and takes it out of the address", async () => {
    const { get } = await rig();
    expect((await get("/")).status).toBe(401);
    expect((await get("/?t=wrong")).status).toBe(401);
    const first = await get(`/?t=${TOKEN}`);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/");
    expect(String(first.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(first.headers["set-cookie"])).toContain("SameSite=Strict");
    const page = await get("/", { cookie });
    expect(page.status).toBe(200);
    expect(page.body).toBe("<html>page</html>");
    expect(String(page.headers["content-security-policy"])).toContain("default-src 'self'");
  });

  it("answers GET only", async () => {
    const { get } = await rig();
    expect((await get("/api/snapshot", { cookie, method: "POST" })).status).toBe(405);
    expect((await get("/api/snapshot", { cookie, method: "PUT" })).status).toBe(405);
  });

  it("serves the reduced snapshot, with pictures by id", async () => {
    const { get } = await rig();
    const res = await get("/api/snapshot", { cookie });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("192.168.1.5");
    const art = (JSON.parse(res.body) as Snapshot).playState?.metadata?.art_url ?? "";
    expect(art).toMatch(/^\/art\/[0-9a-f]{24}$/);
  });

  it("serves only the pictures it handed out, and never fetches an address it is given", async () => {
    const { get, fetched } = await rig();
    expect((await get(`/art/${"0".repeat(24)}`, { cookie })).status).toBe(404);
    expect((await get("/art/x?u=http://evil.example/a.jpg", { cookie })).status).toBe(404);
    const snap = JSON.parse((await get("/api/snapshot", { cookie })).body) as Snapshot;
    const pic = await get(snap.playState!.metadata!.art_url!, { cookie });
    expect(pic.status).toBe(200);
    expect(pic.headers["content-type"]).toBe("image/jpeg");
    expect(fetched).toEqual(["http://192.168.1.5/a.jpg"]);
  });

  it("serves the built page's files and nothing outside it", async () => {
    const { get } = await rig();
    expect((await get("/assets/a.js", { cookie })).body).toBe("js");
    expect((await get("/assets/../../outside.txt", { cookie })).status).toBe(404);
    expect((await get("/assets/%2e%2e/%2e%2e/outside.txt", { cookie })).status).toBe(404);
    expect((await get("/settings.json", { cookie })).status).toBe(404);
  });
});
