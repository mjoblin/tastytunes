import { useCallback, useEffect, useState } from "react";
import { type AppSettings } from "@shared/model";
import { tt } from "@/api";
import { SettingRow, Toggle } from "@/components/settings/SettingsKit";
import { SecretKeyRow, type SecretKeySpec } from "@/components/settings/SecretKey";

// The ListenBrainz section, split out of SettingsScreen.tsx 2026-09-13 (the Settings split: the screen had held every
// section and control at 2,142 lines); the shared rows and controls live in ./SettingsKit.

// the token is checked with ListenBrainz before it is kept (ipc/lookups setLbToken): one it
// refuses is not saved, and the dialog says so with the field still there to fix; a working one
// says what is next, the switch below when scrobbling is off
const lbToken = (scrobbling: boolean): SecretKeySpec => ({
  id: "lbToken",
  title: "ListenBrainz token",
  noun: "token",
  what: "ListenBrainz keeps a free, open log of what you listen to. With your token, TastyTunes can add what you play to it.",
  getStep:
    "Sign in to ListenBrainz (a MetaBrainz account is free) and copy your user token from its settings.",
  getLabel: "Open listenbrainz.org",
  getUrl: "https://listenbrainz.org/settings/",
  placeholder: "user token",
  check: (token) =>
    tt.setLbToken(token).then((got) =>
      got.verdict === "works"
        ? {
            verdict: "works",
            said: `The token works${got.userName ? `, for ${got.userName}` : ""}. ${scrobbling ? "What you play is scrobbled to it." : "Turn on “Scrobble to ListenBrainz” to start."}`,
          }
        : got.verdict === "unreachable"
          ? {
              verdict: "unreachable",
              said: "Couldn't reach listenbrainz.org to check the token. It's saved, and it will be tried when scrobbling.",
            }
          : {
              verdict: "refused",
              said: "ListenBrainz didn't accept this token. Check that it's the whole token and try again.",
            },
    ),
  remove: () => tt.setLbToken(null).then(() => {}),
  removeQuestion: "Remove your ListenBrainz token? Scrobbling stops until you add it again.",
});

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

  const status = !hasToken
    ? "Your user token from listenbrainz.org, for scrobbling what you play to your account."
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
        <SecretKeyRow
          spec={lbToken(settings.lbEnabled)}
          saved={hasToken}
          ends={stored?.ends ?? null}
          onChanged={refresh}
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
