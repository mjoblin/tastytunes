import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { DEFAULT_SETTINGS, type AppSettings, type McpBind, type McpSettings } from "@shared/model";
import { MCP_CLUSTERS, mcpClusterEnabled, type McpClusterInfo } from "@shared/mcpCatalog";
import { AGENTS_GUIDE_URL } from "@shared/ipc";
import { tt } from "@/api";
import { useStore } from "@/store";
import { cx } from "@/lib/format";
import { HeaderChip } from "@/components/chrome/Chrome";
import { SettingRow, Toggle, NumberField } from "@/components/settings/SettingsKit";
import { Segmented } from "@/components/controls/Segmented";

// The MCP section, split out of SettingsScreen.tsx 2026-09-13 (the Settings split: the screen had held every
// section and control at 2,142 lines); the shared rows and controls live in ./SettingsKit.

export function McpSection({
  settings,
  save,
}: {
  settings: AppSettings;
  save(patch: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  const mcp = settings.mcp;
  const status = useStore((s) => s.mcpStatus);
  const [copied, setCopied] = useState<string | null>(null);

  const saveMcp = (patch: Partial<McpSettings>): void => {
    void save({ mcp: { ...mcp, ...patch } });
  };
  const clusterOn = (c: McpClusterInfo): boolean => mcpClusterEnabled(c, mcp);
  const toggleCluster = (c: McpClusterInfo, on: boolean): void => {
    if (c.optIn) {
      // Opt-in clusters live in an explicit allow-list — absence means off.
      saveMcp({
        enabledClusters: on
          ? [...(mcp.enabledClusters ?? []), c.id]
          : (mcp.enabledClusters ?? []).filter((x) => x !== c.id),
      });
    } else {
      saveMcp({
        disabledClusters: on
          ? mcp.disabledClusters.filter((x) => x !== c.id)
          : [...mcp.disabledClusters, c.id],
      });
    }
  };
  const toolOff = (name: string): boolean => mcp.disabledTools.includes(name);
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const toggleTool = (name: string): void =>
    saveMcp({
      disabledTools: toolOff(name)
        ? mcp.disabledTools.filter((t) => t !== name)
        : [...mcp.disabledTools, name],
    });

  const copy = (key: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1600);
    });
  };

  const enabledTools = MCP_CLUSTERS.reduce(
    (n, c) => (clusterOn(c) ? n + c.tools.filter((t) => !toolOff(t.name)).length : n),
    0,
  );

  return (
    <section className="space-y-3">
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
        <Toggle
          label="MCP server"
          hint="Let AI agents and other MCP clients see and control the streamer over the Model Context Protocol."
          checked={mcp.enabled}
          onChange={(enabled) => saveMcp({ enabled })}
        />

        {/* the guide is the way in for anyone who has not connected a client yet, so it is
            its own row under the switch, live whether the server is on or off */}
        <SettingRow
          label="Setup guide"
          hint="How to connect Claude Code, Cursor, VS Code, Claude Desktop and other clients, and what an agent can and cannot do."
        >
          <HeaderChip
            active
            onClick={() => void tt.openExternal(AGENTS_GUIDE_URL)}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] motion-safe:active:scale-90"
          >
            <ExternalLink size={13} />
            Open the guide
          </HeaderChip>
        </SettingRow>

        {/* live status + ways to connect a client */}
        {mcp.enabled && (
          <div className="rounded-lg bg-bg ring-1 ring-edge px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-2.5">
              <span
                className={cx(
                  "led",
                  status.running ? "led-on" : status.error ? "led-off" : "led-busy",
                )}
              />
              <span className="text-[12px] text-dim">
                {status.running ? <>Serving {enabledTools} tools</> : (status.error ?? "Starting…")}
              </span>
            </div>
            {status.running && status.url && (
              <div className="space-y-1.5 pt-0.5">
                <CopyRow
                  label="Endpoint"
                  text={status.url}
                  copied={copied === "endpoint"}
                  onCopy={() => copy("endpoint", status.url!)}
                />
                <CopyRow
                  label="Claude Code"
                  text={`claude mcp add --transport http tastytunes ${status.url}`}
                  copied={copied === "claude"}
                  onCopy={() =>
                    copy("claude", `claude mcp add --transport http tastytunes ${status.url}`)
                  }
                />
                <CopyRow
                  label="JSON config"
                  text={`"tastytunes": { "type": "http", "url": "${status.url}" }`}
                  copied={copied === "json"}
                  onCopy={() => copy("json", mcpJsonSnippet(status.url!))}
                  hint='For Cursor and other clients that take an "mcpServers" block with a url; copies the full block.'
                />
              </div>
            )}
          </div>
        )}

        <div className={cx("space-y-5", !mcp.enabled && "opacity-40 pointer-events-none")}>
          <SettingRow
            label="Reachable from"
            hint="Your streamer already accepts commands from anything on your local network, so allowing that here is no wider. This computer is the cautious default."
          >
            <Segmented<McpBind>
              value={mcp.bind}
              onChange={(bind) => saveMcp({ bind })}
              options={[
                { value: "localhost", label: "This computer" },
                { value: "lan", label: "Local network" },
              ]}
            />
          </SettingRow>

          <SettingRow label="Port" hint="The HTTP port the MCP endpoint listens on.">
            <NumberField
              value={mcp.port}
              min={1024}
              max={65535}
              widthClass="w-24"
              onCommit={(port) => saveMcp({ port: port ?? DEFAULT_SETTINGS.mcp.port })}
            />
          </SettingRow>

          <div className="space-y-4">
            {/* full-strength rule: Tools opens its own region, a step above
                the groups' softer edge/60 separators */}
            <div className="pt-4 border-t border-edge">
              {/* the top of the three-level ladder: Tools (16 bold) > group
                  headings (14.5 medium) > cluster toggles (13.5) */}
              <div className="font-display font-bold text-[16px] tracking-tight">Tools</div>
              <div className="text-[11.5px] text-faint max-w-sm">
                What connected agents are allowed to do. Switch off whole clusters, or click
                individual tools to toggle them. Changes apply to the next agent request.
              </div>
            </div>
            {MCP_GROUPS.map((g) => {
              const clusters = MCP_CLUSTERS.filter((c) => c.group === g.id);
              if (clusters.length === 0) return null;
              return (
                <div key={g.id} className="space-y-3.5">
                  {/* the group header must out-rank its cluster rows (13.5px
                      toggles) — a size step up plus the indented rail below */}
                  <div className="pt-1 border-t border-edge/60 first:border-t-0 first:pt-0">
                    <div className="pt-2 text-[14.5px] font-medium">{g.label}</div>
                    <div className="text-[11.5px] text-faint">{g.note}</div>
                  </div>
                  <div className="pl-4 ml-1 border-l-2 border-edge/50 space-y-3.5">
                    {clusters.map((cluster) => {
                      const on = clusterOn(cluster);
                      const open = openTools[cluster.id] === true;
                      const activeCount = cluster.tools.filter((t) => !toolOff(t.name)).length;
                      return (
                        <div key={cluster.id}>
                          <Toggle
                            label={cluster.title}
                            hint={cluster.description}
                            checked={on}
                            onChange={(v) => toggleCluster(cluster, v)}
                          />
                          {/* tools stay tucked away — one small line per cluster
                            instead of a wall of chips */}
                          <button
                            onClick={() => setOpenTools((o) => ({ ...o, [cluster.id]: !open }))}
                            aria-expanded={open}
                            className="mt-1 font-mono text-[10.5px] text-faint hover:text-dim transition-colors"
                          >
                            {open
                              ? "▾ hide tools"
                              : `▸ ${activeCount === cluster.tools.length ? cluster.tools.length : `${activeCount} of ${cluster.tools.length}`} tools`}
                          </button>
                          {open && (
                            <div
                              className={cx(
                                "mt-2 flex flex-wrap gap-1.5",
                                !on && "opacity-40 pointer-events-none",
                              )}
                            >
                              {cluster.tools.map((t) => {
                                const toolOn = !toolOff(t.name);
                                return (
                                  <button
                                    key={t.name}
                                    onClick={() => toggleTool(t.name)}
                                    aria-pressed={toolOn}
                                    data-tip={t.description}
                                    className={cx(
                                      "tip-top tip-wide px-2.5 py-1 rounded-full font-mono text-[10.5px] ring-1 transition-colors",
                                      // quiet grays: filled = enabled, hollow + struck = off
                                      toolOn
                                        ? "ring-edge2 bg-veil2 text-ink/80 hover:text-ink"
                                        : "ring-edge text-faint/70 line-through hover:text-dim",
                                    )}
                                  >
                                    {t.name}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

/** The Settings-side grouping of MCP clusters by what they can affect. */
const MCP_GROUPS: Array<{ id: McpClusterInfo["group"]; label: string; note: string }> = [
  { id: "read", label: "Read-only", note: "Seeing and looking things up; nothing changes." },
  {
    id: "control",
    label: "Control",
    note: "Playing, tuning, and adjusting; transient, like pressing the buttons yourself.",
  },
  {
    id: "write",
    label: "Edits & saves",
    note: "Changes saved things (queue order, preset slots). Overwriting an occupied preset slot additionally requires the agent to say so explicitly per call.",
  },
];

/** The "mcpServers" JSON block with a url, the shape Cursor-style clients take. Claude Desktop
 *  is stdio-only and reaches the server through a bridge, and VS Code wants a "servers" root:
 *  the Setup guide covers each one. */
function mcpJsonSnippet(url: string): string {
  return JSON.stringify({ mcpServers: { tastytunes: { type: "http", url } } }, null, 2);
}

function CopyRow({
  label,
  text,
  copied,
  onCopy,
  hint,
}: {
  label: string;
  text: string;
  copied: boolean;
  onCopy(): void;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="microlabel w-24 shrink-0">{label}</span>
      <code className="flex-1 min-w-0 truncate font-mono text-[11px] text-faint">{text}</code>
      <button
        onClick={onCopy}
        data-tip={copied ? "Copied" : (hint ?? "Copy")}
        aria-label={`Copy ${label}`}
        className="tip-top shrink-0 p-1.5 rounded text-dim hover:text-ink transition-colors"
      >
        {copied ? <Check size={13} className="text-led" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- primitives
