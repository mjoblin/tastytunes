import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ConnectionState, type McpStatus } from "@shared/model";

// The agents' server over a stand-in HTTP server (it "listens" at once and opens no port) and a
// stand-in address picker: the address on 192.168.1.x once a streamer there is connected, else
// another interface's.
vi.mock("node:http", async (actual) => ({
  ...(await actual<typeof import("node:http")>()),
  createServer: () => ({
    on: () => {},
    listen: (_port: number, _host: string, done: () => void) => done(),
    closeAllConnections: () => {},
    close: () => {},
  }),
}));
vi.mock("./lanAddress", () => ({
  lanAddress: (streamer: string | null) =>
    streamer?.startsWith("192.168.1.") ? "192.168.1.7" : "10.0.0.5",
}));

const { McpBridge } = await import("./mcpServer");

/** A bridge over a device manager that holds only its connection and what Settings was told. */
function bridge() {
  let connection: ConnectionState = { phase: "idle" };
  const said: McpStatus[] = [];
  const dm = {
    get connectionNow() {
      return connection;
    },
    setMcpStatus: (status: McpStatus | null) => {
      if (status) said.push(status);
    },
    log: () => {},
  };
  const b = new McpBridge(dm as never);
  return {
    b,
    said,
    connect: (host: string) => {
      connection = { phase: "connected", host };
      b.streamerConnected();
    },
  };
}

const mcp = (bind: "lan" | "localhost") => ({
  mcp: { ...DEFAULT_SETTINGS.mcp, enabled: true, bind, port: 8765 },
});

describe("the agents' address", () => {
  it("moves to the streamer's network when one connects after the server started", () => {
    const { b, said, connect } = bridge();
    b.sync(mcp("lan"));
    expect(said.at(-1)?.url).toBe("http://10.0.0.5:8765/mcp");
    connect("192.168.1.20");
    expect(said.at(-1)).toEqual({ running: true, url: "http://192.168.1.7:8765/mcp", error: null });
    // the same address again says nothing new
    const n = said.length;
    connect("192.168.1.20");
    expect(said).toHaveLength(n);
    b.stop();
  });

  it("says nothing new on this computer alone, or with the server off", () => {
    const local = bridge();
    local.b.sync(mcp("localhost"));
    const n = local.said.length;
    local.connect("192.168.1.20");
    expect(local.said).toHaveLength(n);
    expect(local.said.at(-1)?.url).toBe("http://127.0.0.1:8765/mcp");
    local.b.stop();
    const off = bridge();
    off.connect("192.168.1.20");
    expect(off.said).toEqual([]);
  });
});
