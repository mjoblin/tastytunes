import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayStatus } from "@shared/ipc";

// Second screen's wiring over stand-ins: a server that "listens" at once and opens no port, an
// address picker that answers 192.168.1.7 once a streamer on 192.168.1.x is connected (else
// 10.0.0.5), a token read and a New address the test answers, and the windows' pushes and the
// log collected. The screens file is the real one, in the stub's temporary userData.
const h = vi.hoisted(() => ({
  settings: {
    displayServer: { enabled: true, port: 8800 },
    displayControl: true,
    displayControlVolume: false,
    displayControlPresets: false,
  },
  connection: { phase: "idle", host: "" },
  token: (): Promise<string | null> => Promise.resolve("tok-1"),
  renew: (): Promise<boolean> => Promise.resolve(false),
  statuses: [] as DisplayStatus[],
  logs: [] as string[][],
}));

vi.mock("./runtime", () => ({
  connectedHost: () => (h.connection.phase === "connected" ? h.connection.host : null),
  deviceManager: {
    log: (level: string, scope: string, text: string) => h.logs.push([level, scope, text]),
    streamerNow: {},
    get connectionNow() {
      return h.connection;
    },
  },
}));
vi.mock("./broadcast", () => ({
  alsoHearSettings: () => {},
  broadcastDisplayScreens: () => {},
  broadcastDisplayStatus: (s: DisplayStatus) => h.statuses.push(s),
}));
vi.mock("../servers/displayServer", () => ({
  DisplayServer: class {
    running = false;
    port: number | null = null;
    push(): void {}
    pushControl(): void {}
    closeScreens(): void {}
    stop(): void {
      this.running = false;
      this.port = null;
    }
    start(port: number): Promise<void> {
      this.running = true;
      this.port = port;
      return Promise.resolve();
    }
  },
}));
vi.mock("../servers/lanAddress", () => ({
  lanAddress: (streamer: string | null) =>
    streamer?.startsWith("192.168.1.") ? "192.168.1.7" : "10.0.0.5",
}));
vi.mock("../data/persist", () => ({
  getSettings: () => h.settings,
  displayToken: () => h.token(),
  newDisplayToken: () => h.renew(),
}));
vi.mock("../data/playlists", () => ({ getPlaylists: () => [] }));
vi.mock("../lookups/artFetch", () => ({ artHostTrust: () => null, fetchPicture: () => null }));
vi.mock("../lookups/artThumbs", () => ({ artThumb: () => null }));
vi.mock("../lookups/lyrics", () => ({ fetchLyrics: () => null }));
vi.mock("../lookups/audioAnalysis", () => ({ audioAnalysisGet: () => null }));
vi.mock("../media/mediaInfo", () => ({ lookupMediaInfo: () => null }));

const screensPath = (): string => join(app.getPath("userData"), "display-screens.json");

/** The module fresh, so the screens file is read again and the server starts stopped. */
async function fresh(): Promise<typeof import("./display")> {
  vi.resetModules();
  return import("./display");
}

beforeEach(() => {
  h.settings.displayServer = { enabled: true, port: 8800 };
  h.connection = { phase: "idle", host: "" };
  h.token = () => Promise.resolve("tok-1");
  h.renew = () => Promise.resolve(false);
  h.statuses = [];
  h.logs = [];
  writeFileSync(screensPath(), "[]");
});

describe("Second screen's first address", () => {
  it("is said on the card and in the log when it couldn't be made, and made at the next try", async () => {
    const display = await fresh();
    h.token = () => Promise.reject(new Error("ENOSPC: no space left on device"));
    const status = await display.syncDisplay();
    expect(status).toEqual({
      running: false,
      url: null,
      error: "Couldn't make an address. Turn Second screen off and back on to try again.",
      addressUnreadable: false,
    });
    expect(h.statuses.at(-1)).toEqual(status);
    expect(h.logs).toContainEqual([
      "error",
      "display",
      "the address couldn't be made (ENOSPC: no space left on device)",
    ]);
    // off and back on tries again
    h.token = () => Promise.resolve("tok-1");
    h.settings.displayServer = { enabled: false, port: 8800 };
    await display.syncDisplay();
    h.settings.displayServer = { enabled: true, port: 8800 };
    expect(await display.syncDisplay()).toEqual({
      running: true,
      url: "http://10.0.0.5:8800/?t=tok-1",
      error: null,
      addressUnreadable: false,
    });
  });

  it("waits for New address when the saved one couldn't be read", async () => {
    const display = await fresh();
    h.token = () => Promise.resolve(null);
    expect(await display.syncDisplay()).toMatchObject({ running: false, addressUnreadable: true });
  });
});

describe("Second screen's address on a connect", () => {
  it("moves to the streamer's network when one connects after the server started", async () => {
    const display = await fresh();
    expect((await display.syncDisplay()).url).toBe("http://10.0.0.5:8800/?t=tok-1");
    const said = h.statuses.length;
    h.connection = { phase: "connected", host: "192.168.1.20" };
    await display.displayStreamerConnected();
    expect(h.statuses.at(-1)).toEqual({
      running: true,
      url: "http://192.168.1.7:8800/?t=tok-1",
      error: null,
      addressUnreadable: false,
    });
    // the same address again says nothing new
    await display.displayStreamerConnected();
    expect(h.statuses).toHaveLength(said + 1);
  });

  it("says nothing with Second screen off", async () => {
    const display = await fresh();
    h.settings.displayServer = { enabled: false, port: 8800 };
    await display.syncDisplay();
    const said = h.statuses.length;
    h.connection = { phase: "connected", host: "192.168.1.20" };
    await display.displayStreamerConnected();
    expect(h.statuses).toHaveLength(said);
  });
});

describe("New address", () => {
  it("says when the saved keys were set aside to make it, and refuses when it couldn't be made", async () => {
    const display = await fresh();
    h.renew = () => Promise.resolve(true);
    const made = await display.newDisplayAddress();
    expect(made.keysSetAside).toBe(true);
    expect(made.status).toMatchObject({ running: true, url: "http://10.0.0.5:8800/?t=tok-1" });
    h.renew = () => Promise.resolve(false);
    expect((await display.newDisplayAddress()).keysSetAside).toBe(false);
    h.renew = () => Promise.reject(new Error("couldn't be written"));
    await expect(display.newDisplayAddress()).rejects.toThrow();
  });
});

describe("a later version's screens", () => {
  const A = "a".repeat(32);
  const known = { id: A, name: "iPad · Safari", firstSeen: 5, allowed: true, scene: "later" };
  const later = { id: "e".repeat(64), name: "TV", firstSeen: 6, allowed: true };
  const written = (): unknown => JSON.parse(readFileSync(screensPath(), "utf-8"));

  it("are written back as found when the screens change, and a new address ends them too", async () => {
    writeFileSync(screensPath(), JSON.stringify({ format: 2, items: [known, later] }));
    const display = await fresh();
    expect(display.screenBook.list().screens).toEqual([known]);
    // a change through the normal path: the screen turned down in Settings
    display.screenBook.answer(A, false);
    expect(written()).toEqual({ format: 2, items: [{ ...known, allowed: false }, later] });
    // read again, still there
    const again = await fresh();
    again.screenBook.answer(A, true);
    expect(written()).toEqual({ format: 2, items: [known, later] });
    // a new address ends every approval, the later version's among them
    await again.newDisplayAddress();
    expect(written()).toEqual({ format: 2, items: [] });
  });
});
