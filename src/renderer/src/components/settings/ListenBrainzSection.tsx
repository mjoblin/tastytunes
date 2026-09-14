import { useEffect, useState } from "react";
import { type AppSettings } from "@shared/model";
import { tt } from "@/api";
import { HeaderChip } from "@/components/chrome/Chrome";
import { SettingRow, Toggle } from "@/components/settings/SettingsKit";

// The ListenBrainz section, split out of SettingsScreen.tsx 2026-09-13 (the Settings split: the screen had held every
// section and control at 2,142 lines); the shared rows and controls live in ./SettingsKit.

export function ListenBrainzSection({
  settings,
  save,
}: {
  settings: AppSettings;
  save(patch: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  const hasToken = settings.lbToken.trim().length > 0;
  const [tokenStatus, setTokenStatus] = useState<
    { valid: boolean; userName: string | null } | null | "checking" | "idle"
  >("idle");

  const validate = async (): Promise<void> => {
    setTokenStatus("checking");
    setTokenStatus(await tt.lbValidate());
  };
  useEffect(() => {
    if (hasToken) void validate();
    else setTokenStatus("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-check per token
  }, [settings.lbToken]);

  const status = !hasToken
    ? "Paste your user token from listenbrainz.org/settings."
    : tokenStatus === "checking" || tokenStatus === "idle"
      ? "Checking token…"
      : tokenStatus === null
        ? "Can't reach listenbrainz.org; it will be retried when scrobbling."
        : tokenStatus.valid
          ? `Token valid, scrobbling as ${tokenStatus.userName ?? "you"}.`
          : "Token rejected by ListenBrainz.";

  return (
    <div className="space-y-4 pt-1 border-t border-edge">
      <SettingRow label="ListenBrainz token" hint={status}>
        <div className="flex items-center gap-2">
          <TokenField value={settings.lbToken} onCommit={(lbToken) => void save({ lbToken })} />
          <HeaderChip
            onClick={() => void tt.openExternal("https://listenbrainz.org/settings/")}
            className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
          >
            Get token
          </HeaderChip>
        </div>
      </SettingRow>
      <Toggle
        label="Scrobble to ListenBrainz"
        hint={
          hasToken
            ? "Log what you listen to at listenbrainz.org: artist, title, and album are sent as tracks play. Queue and streamed tracks with real metadata only; radio is never scrobbled."
            : "Add your user token above first; the switch is enabled once a token is saved."
        }
        disabled={!hasToken}
        checked={settings.lbEnabled}
        onChange={(lbEnabled) => void save({ lbEnabled })}
      />
    </div>
  );
}

/** Masked text input, committed on blur/Enter (Escape reverts). */
function TokenField({
  value,
  onCommit,
}: {
  value: string;
  onCommit(next: string): void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
    setDraft(null);
  };

  return (
    <input
      type="password"
      autoComplete="off"
      spellCheck={false}
      value={draft ?? value}
      placeholder="user token"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(null);
      }}
      className="w-48 bg-bg rounded-lg ring-1 ring-edge px-3 py-1.5 text-[12.5px] font-mono outline-none focus:ring-edge2 placeholder:text-faint"
    />
  );
}

/**
 * Numeric input that lets you actually type: edits live in a draft and are
 * clamped + committed on blur/Enter (Escape reverts). Clamping per keystroke
 * made intermediate values impossible — typing "45" became 10, then 100.
 */
