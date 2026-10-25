import { useCallback, useEffect, useState } from "react";
import { type AppSettings } from "@shared/model";
import { tt } from "@/api";
import { SavedSecret, SettingRow, Toggle } from "@/components/settings/SettingsKit";

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
    void tt.setLbToken(token).then(refresh);
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
        <SavedSecret
          id="lbToken"
          saved={hasToken}
          ends={stored?.ends ?? null}
          placeholder="user token"
          label="ListenBrainz user token"
          getLabel="Get token"
          getUrl="https://listenbrainz.org/settings/"
          onSave={(token) => keep(token)}
          onRemove={() => keep(null)}
        />
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
