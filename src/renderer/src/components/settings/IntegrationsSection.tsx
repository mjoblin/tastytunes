// THE INTEGRATIONS TAB (0.16.0's settings diet): what other apps and devices use to drive TastyTunes,
// the tastytunes:// action links (a Stream Deck, a shortcut) and the MCP server for AI agents, in one
// tab where the links had sat in Behavior and the server in its own. Display on other screens
// (0.17.0) sits above the MCP server, whose list of tools runs long: below it, it went unseen.
import { ActionLinks } from "@/components/settings/ActionLinks";
import { McpSection } from "@/components/settings/McpSection";
import { DisplayServerSection } from "@/components/settings/DisplayServerSection";
import { SettingsCard, type SectionProps } from "@/components/settings/SettingsKit";

export function IntegrationsSection(props: SectionProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <SettingsCard>
        <ActionLinks />
      </SettingsCard>
      <DisplayServerSection {...props} />
      <McpSection {...props} />
    </div>
  );
}
