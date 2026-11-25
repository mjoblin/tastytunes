import { createServer, IncomingMessage, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Socket } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { acceptBothForSdk, acceptForSdk, SDK_ACCEPT } from "./accept";

const request = (raw: string[]): IncomingMessage => {
  const req = new IncomingMessage(new Socket());
  req.rawHeaders = raw;
  for (let i = 0; i < raw.length; i += 2) req.headers[raw[i].toLowerCase()] = raw[i + 1];
  return req;
};

describe("the Accept the MCP transport is handed", () => {
  it("keeps a client's own when it lists both types", () => {
    expect(acceptForSdk("application/json, text/event-stream")).toBeNull();
    expect(acceptForSdk("text/event-stream;q=0.9, application/json")).toBeNull();
  });

  it("gives both to a request with none, a wildcard, or only one of them", () => {
    expect(acceptForSdk(undefined)).toBe(SDK_ACCEPT);
    expect(acceptForSdk("*/*")).toBe(SDK_ACCEPT);
    expect(acceptForSdk("application/json")).toBe(SDK_ACCEPT);
  });

  it("rewrites the raw pairs as well as the parsed header, once", () => {
    const req = request(["Host", "localhost", "accept", "*/*", "Content-Type", "application/json"]);
    acceptBothForSdk(req);
    expect(req.headers.accept).toBe(SDK_ACCEPT);
    expect(req.rawHeaders).toEqual([
      "Host",
      "localhost",
      "Content-Type",
      "application/json",
      "Accept",
      SDK_ACCEPT,
    ]);
  });

  it("adds the pair to a request that sent none, and leaves a good one alone", () => {
    const bare = request(["Host", "localhost"]);
    acceptBothForSdk(bare);
    expect(bare.rawHeaders).toEqual(["Host", "localhost", "Accept", SDK_ACCEPT]);
    const good = request(["Accept", "application/json, text/event-stream"]);
    acceptBothForSdk(good);
    expect(good.rawHeaders).toEqual(["Accept", "application/json, text/event-stream"]);
  });
});

describe("the SDK's transport behind it", () => {
  /** A stateless server answering in JSON, as mcpServer.ts runs it, with and without the fix. */
  async function post(accept: string | null, fixed: boolean): Promise<number> {
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        if (fixed) acceptBothForSdk(req);
        const mcp = new McpServer({ name: "t", version: "1" });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => void transport.close());
        await mcp.connect(transport);
        await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString()));
      })();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (accept != null) headers.accept = accept;
      // node:http, not fetch: fetch adds an Accept of its own, and "none" must mean none
      return await new Promise<number>((resolve, reject) => {
        const out = httpRequest(
          { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        out.on("error", reject);
        out.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
      });
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  it("refuses a wildcard on its own, so the fix is what serves it", async () => {
    expect(await post("*/*", false)).toBe(406);
  });

  it("serves no Accept and a wildcard once given both", async () => {
    expect(await post("*/*", true)).toBe(200);
    expect(await post(null, true)).toBe(200);
    expect(await post("application/json, text/event-stream", true)).toBe(200);
  });
});
