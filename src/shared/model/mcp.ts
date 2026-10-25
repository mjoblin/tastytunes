// The MCP server's configuration and status. What the server is configured WITH lives here
// (it is part of AppSettings); what it OFFERS is the catalog's business (mcpCatalog.ts).

// ------------------------------------------------------------------- MCP server

/** Which interface the MCP server binds to. */
export type McpBind = "localhost" | "lan";

export interface McpSettings {
  /** Master switch — the server only exists while this is on. */
  enabled: boolean;
  /** localhost = this computer only; lan = any machine on the network. */
  bind: McpBind;
  port: number;
  /** Cluster ids switched off (everything is on by default). */
  disabledClusters: string[];
  /** Opt-in cluster ids the user explicitly enabled (write-capable clusters
   *  are OFF until they appear here). */
  enabledClusters: string[];
  /** Individual tool names switched off. The bearer token an agent on another machine sends
   *  while the server is reachable from the local network (0.10.0) is the secrets store's
   *  mcpToken since 0.13.0, never here: minted by main, renewed by its New token. */
  disabledTools: string[];
}

export interface McpStatus {
  running: boolean;
  /** Reachable endpoint while running, e.g. http://192.168.1.20:8555/mcp. */
  url: string | null;
  error: string | null;
}

// The CATALOG — MCP_CLUSTERS, McpClusterInfo, McpToolInfo, mcpClusterEnabled —
// lives in mcpCatalog.ts (2026-07-26). What the server is configured WITH stays
// here (it is part of AppSettings); what it OFFERS is the catalog's business.
