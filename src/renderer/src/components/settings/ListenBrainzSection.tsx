import { useCallback, useEffect, useState } from "react";
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
  // THE TOKEN IS WRITE-ONLY HERE (0.13.0 round 10, the secrets store): the window learns only
  // whether one is saved and how it ends; it is pasted in, replaced or removed, never shown
  const [stored, setStored] = useState<{
    saved: boolean;
    ends: string | null;
    encrypted: boolean;
  } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const refresh = useCallback((): void => {
    void tt
      .secretsStatus()
      .then((s) => setStored({ ...s.lbToken, encrypted: s.encrypted }))
      .catch(() => {});
  }, []);
  useEffect(() => refresh(), [refresh]);
  const hasToken = stored?.saved === true;
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
    // re-checked per token: whether one is saved, and how it ends
  }, [hasToken, stored?.ends]);

  const keep = (token: string | null): void => {
    void tt.setLbToken(token).then(() => {
      setReplacing(false);
      refresh();
    });
  };

  const status = !hasToken
    ? "Paste your user token from listenbrainz.org/settings."
    : tokenStatus === "checking" || tokenStatus === "idle"
      ? "Checking token…"
      : tokenStatus === null
        ? "Can't reach listenbrainz.org. It will be retried when scrobbling."
        : tokenStatus.valid
          ? `Token valid, scrobbling as ${tokenStatus.userName ?? "you"}.`
          : "Token rejected by ListenBrainz.";
  const kept =
    stored && !stored.encrypted
      ? " This system has no keyring, so the token is kept unencrypted in a file only your account can read."
      : "";

  return (
    <div className="space-y-4 pt-1 border-t border-edge">
      <SettingRow label="ListenBrainz token" hint={status + kept}>
        <div className="flex items-center gap-2" data-lb-token={hasToken ? "saved" : "none"}>
          {hasToken && !replacing ? (
            <>
              <span className="text-[12.5px] text-dim whitespace-nowrap">
                Saved, ending in <span className="font-mono text-ink">{stored?.ends}</span>
              </span>
              <HeaderChip
                onClick={() => setReplacing(true)}
                className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
              >
                Replace
              </HeaderChip>
              <HeaderChip
                onClick={() => keep(null)}
                className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
              >
                Remove
              </HeaderChip>
            </>
          ) : (
            <>
              <TokenField onCommit={(token) => keep(token)} />
              {replacing ? (
                <HeaderChip
                  onClick={() => setReplacing(false)}
                  className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
                >
                  Cancel
                </HeaderChip>
              ) : (
                <HeaderChip
                  onClick={() => void tt.openExternal("https://listenbrainz.org/settings/")}
                  className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
                >
                  Get token
                </HeaderChip>
              )}
            </>
          )}
        </div>
      </SettingRow>
      <Toggle
        label="Scrobble to ListenBrainz"
        hint={
          hasToken
            ? "Log what you listen to at listenbrainz.org: artist, title, and album are sent as tracks play. Queue and streamed tracks with real metadata only. Radio is never scrobbled."
            : "Add your user token above first. The switch is enabled once a token is saved."
        }
        disabled={!hasToken}
        checked={settings.lbEnabled}
        onChange={(lbEnabled) => void save({ lbEnabled })}
      />
    </div>
  );
}

/** A token pasted in: masked, committed on blur or Enter (Escape clears), never filled back. */
function TokenField({ onCommit }: { onCommit(next: string): void }): React.JSX.Element {
  const [draft, setDraft] = useState("");

  const commit = (): void => {
    if (draft.trim()) onCommit(draft.trim());
    setDraft("");
  };

  return (
    <input
      type="password"
      autoComplete="off"
      spellCheck={false}
      value={draft}
      placeholder="user token"
      aria-label="ListenBrainz user token"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft("");
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
