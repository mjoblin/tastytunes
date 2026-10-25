import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fetchDiscTracks } from "../lookups/discTracks";
import { DISC } from "./demo/demoDisc";
import { startDemoStreamer, stopDemoStreamer } from "./demoStreamer";

interface Frame {
  path?: string;
  params?: { data?: unknown };
}

/** A socket to the demo, keeping the latest data pushed for each path. */
async function openSocket(host: string): Promise<{ ws: WebSocket; seen: Map<string, unknown> }> {
  const ws = new WebSocket(`ws://${host}/smoip`, { headers: { Origin: `http://${host}` } });
  const seen = new Map<string, unknown>();
  ws.on("message", (raw) => {
    try {
      const f = JSON.parse(String(raw)) as Frame;
      if (f.path) seen.set(f.path, f.params?.data);
    } catch {
      // not a frame
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, seen };
}

/** Whatever `read` gives once `done` holds of it, or its last reading after four seconds. */
async function until<T>(read: () => T, done: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 40; i++) {
    const v = read();
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return read();
}

interface Preset {
  id: number;
  name: string;
}

describe("startDemoStreamer: every preset write the app posts is answered", () => {
  let host: string;
  let socket: { ws: WebSocket; seen: Map<string, unknown> };
  let before: Preset[];
  const presets = (): Preset[] | null =>
    (socket.seen.get("/presets/list") as { presets?: Preset[] } | undefined)?.presets ?? null;
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`http://${host}/smoip${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    host = await startDemoStreamer();
    socket = await openSocket(host);
    socket.ws.send(JSON.stringify({ path: "/presets/list", params: {} }));
    before = (await until(presets, (l) => l != null && l.length >= 3)) ?? [];
  });

  afterAll(() => {
    socket.ws.close();
    stopDemoStreamer();
  });

  it("moves a preset, the entry re-seating into the target's slot and the slot numbers staying put", async () => {
    const [a, b] = before;
    const res = await post("/presets/move", { from: a?.id, to: b?.id });
    const moved = await until(presets, (l) => l?.find((x) => x.id === a?.id)?.name === b?.name);
    expect(res.ok).toBe(true);
    expect(moved?.find((x) => x.id === a?.id)?.name).toBe(b?.name);
    expect(moved?.find((x) => x.id === b?.id)?.name).toBe(a?.name);
    expect(moved?.length).toBe(before.length);
  });

  it("deletes a preset, its slot leaving the list", async () => {
    const gone = before[2];
    const res = await post("/presets/delete", { preset: gone?.id });
    const after = await until(presets, (l) => l != null && !l.some((x) => x.id === gone?.id));
    expect(res.ok).toBe(true);
    expect(after?.length).toBe(before.length - 1);
    expect(after?.some((x) => x.id === gone?.id)).toBe(false);
  });
});

interface PlayState {
  state?: string;
  metadata?: { class?: string; title?: string | null };
}
interface NowPlaying {
  display?: { context?: string | null };
  queue?: { position?: number | null };
}

describe("startDemoStreamer: the disc", () => {
  let host: string;
  let socket: { ws: WebSocket; seen: Map<string, unknown> };
  const playState = (): PlayState | undefined =>
    socket.seen.get("/zone/play_state") as PlayState | undefined;
  const send = (path: string, params: object): void =>
    socket.ws.send(JSON.stringify({ path, params }));

  beforeAll(async () => {
    host = await startDemoStreamer();
    socket = await openSocket(host);
  });

  afterAll(() => {
    socket.ws.close();
    stopDemoStreamer();
  });

  it("lists the CD among its sources", async () => {
    send("/system/sources", { update: 1 });
    const listed = await until(
      () =>
        socket.seen.get("/system/sources") as
          { sources?: Array<{ id?: string; class?: string; ui_selectable?: boolean }> } | undefined,
      (s) => s != null,
    );
    expect(
      (listed?.sources ?? []).some(
        (x) => x.id === "CD" && x.class === "digital.cd" && x.ui_selectable,
      ),
    ).toBe(true);
  });

  it("shows the disc stopped as the owner's readout does, and next plays track 2 with its place in now_playing", async () => {
    send("/zone/state", { source: "CD" });
    const stopped = await until(playState, (p) => p?.metadata?.class === "md.track.cd");
    expect(stopped?.state).toBe("stop");
    expect(stopped?.metadata?.title ?? "").toMatch(/^Tracks: 10 Length: \d+:\d{2}$/);
    expect("queue_index" in (stopped ?? {})).toBe(false);

    send("/zone/play_control", { skip_track: 1 });
    const playing = await until(playState, (p) => p?.state === "play");
    const np = socket.seen.get("/zone/now_playing") as NowPlaying | undefined;
    expect(playing?.metadata?.title).toBe(DISC.tracks[1][0]);
    expect(np?.display?.context).toBe("2/10");
    expect(np?.queue?.position).toBe(1);
  });

  it("answers the disc's release itself when the app asks it in MusicBrainz's place", async () => {
    const named = await fetchDiscTracks(DISC.release, 10, null, `http://${host}`);
    expect(named?.tracks.length).toBe(10);
    expect(named?.tracks[0].title).toBe(DISC.tracks[0][0]);
  });

  it("gives the Media Library back on the way out", async () => {
    send("/zone/state", { source: "CD" });
    await until(playState, (p) => p?.metadata?.class === "md.track.cd");
    send("/zone/state", { source: "MEDIA_PLAYER" });
    const back = await until(playState, (p) => p?.metadata?.class !== "md.track.cd");
    expect(back?.metadata?.class).not.toBe("md.track.cd");
    expect(back?.metadata?.title).not.toBeNull();
    expect(back?.metadata?.title).toBeDefined();
  });
});
