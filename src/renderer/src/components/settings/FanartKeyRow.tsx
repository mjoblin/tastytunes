import { useCallback, useEffect, useState } from "react";
import { tt } from "@/api";
import { SettingRow } from "@/components/settings/SettingsKit";
import { SecretKeyRow, type SecretKeySpec } from "@/components/settings/SecretKey";

/**
 * A PERSONAL FANART.TV KEY (0.13.0 round 11): fanart.tv's artist photos, the 1000 x 1000 ones Plex
 * offers, among Choose a picture's choices. The key is the reader's own (decisions/0001: none of
 * ours ships), checked with fanart.tv as it is saved (a key it refuses is not kept), then kept
 * encrypted in the secrets store and shown only by how it ends (SecretKeyRow). It rides Liner
 * notes' artist lookups (fanart.tv looks an artist up by the MusicBrainz id they found), so it
 * waits while those are off.
 */
const FANART: SecretKeySpec = {
  id: "fanartKey",
  title: "fanart.tv key",
  noun: "key",
  what: "fanart.tv has artist photos made by the community. With your key, they're among the choices in “Choose a picture” on an artist's page.",
  getStep: "Sign in to fanart.tv (an account is free) and copy your personal API key.",
  getLabel: "Open fanart.tv",
  getUrl: "https://fanart.tv/get-an-api-key/",
  placeholder: "personal API key",
  check: (key) =>
    tt.setFanartKey(key).then((got) =>
      got === "works"
        ? {
            verdict: "works",
            said: "The key works. fanart.tv's photos are now in “Choose a picture”.",
          }
        : got === "unreachable"
          ? {
              verdict: "unreachable",
              said: "Couldn't reach fanart.tv to check the key. It's saved, and it will be tried when you choose a picture.",
            }
          : {
              verdict: "refused",
              said: "fanart.tv didn't accept this key. Check that it's the whole key and try again.",
            },
    ),
  remove: () => tt.setFanartKey(null).then(() => {}),
  removeQuestion:
    "Remove your fanart.tv key? Its photos leave “Choose a picture” until you add it again.",
};

export function FanartKeyRow({ lookups }: { lookups: boolean }): React.JSX.Element {
  const [stored, setStored] = useState<{
    saved: boolean;
    ends: string | null;
    encrypted: boolean;
  } | null>(null);
  const refresh = useCallback((): void => {
    void tt
      .secretsStatus()
      .then((s) => setStored({ ...s.fanartKey, encrypted: s.encrypted }))
      .catch(() => {});
  }, []);
  useEffect(() => refresh(), [refresh]);
  const hint = !lookups
    ? "Turn on Liner notes above to use a fanart.tv key."
    : "Adds fanart.tv's artist photos to “Choose a picture” on an artist's page. Your key is kept encrypted on this computer.";
  const kept =
    stored?.saved && !stored.encrypted
      ? " This system has no keyring, so the key is kept unencrypted in a file only your account can read."
      : "";
  return (
    <div data-fanart-row className={lookups ? undefined : "opacity-40 pointer-events-none"}>
      <SettingRow label="fanart.tv key" hint={hint + kept}>
        <SecretKeyRow
          spec={FANART}
          saved={stored?.saved === true}
          ends={stored?.ends ?? null}
          onChanged={refresh}
        />
      </SettingRow>
    </div>
  );
}
