import { useCallback, useEffect, useState } from "react";
import { tt } from "@/api";
import { SavedSecret, SettingRow } from "@/components/settings/SettingsKit";

/**
 * A PERSONAL FANART.TV KEY (0.13.0 round 11): fanart.tv's artist photos, the 1000 x 1000 ones Plex
 * offers, among Choose a picture's choices. The key is the reader's own (decisions/0001: none of
 * ours ships), checked with fanart.tv as it is saved (a key it refuses is not kept), then kept
 * encrypted in the secrets store and shown only by how it ends (SavedSecret). It rides Liner
 * notes' artist lookups (fanart.tv looks an artist up by the MusicBrainz id they found), so it
 * waits while those are off.
 */
export function FanartKeyRow({ lookups }: { lookups: boolean }): React.JSX.Element {
  const [stored, setStored] = useState<{
    saved: boolean;
    ends: string | null;
    encrypted: boolean;
  } | null>(null);
  const [verdict, setVerdict] = useState<"works" | "refused" | "unreachable" | "checking" | null>(
    null,
  );
  const refresh = useCallback((): void => {
    void tt
      .secretsStatus()
      .then((s) => setStored({ ...s.fanartKey, encrypted: s.encrypted }))
      .catch(() => {});
  }, []);
  useEffect(() => refresh(), [refresh]);
  const keep = (key: string | null): void => {
    setVerdict(key ? "checking" : null);
    void tt.setFanartKey(key).then((got) => {
      setVerdict(got === "removed" ? null : got);
      refresh();
    });
  };
  const said =
    verdict === "checking"
      ? "Checking the key with fanart.tv…"
      : verdict === "works"
        ? "Key works."
        : verdict === "refused"
          ? "fanart.tv didn't accept this key."
          : verdict === "unreachable"
            ? "Couldn't reach fanart.tv to check the key. It's saved and will be tried when you choose a picture."
            : null;
  const hint = !lookups
    ? "Turn on Liner notes above to use a fanart.tv key."
    : (said ??
      "Adds fanart.tv's artist photos to Choose a picture on an artist's page. Paste your personal API key from fanart.tv. It's kept encrypted on this computer.");
  const kept =
    stored?.saved && !stored.encrypted
      ? " This system has no keyring, so the key is kept unencrypted in a file only your account can read."
      : "";
  return (
    <div data-fanart-row className={lookups ? undefined : "opacity-40 pointer-events-none"}>
      <SettingRow label="fanart.tv key" hint={hint + kept}>
        <SavedSecret
          id="fanartKey"
          saved={stored?.saved === true}
          ends={stored?.ends ?? null}
          placeholder="personal API key"
          label="fanart.tv personal API key"
          getLabel="Get key"
          getUrl="https://fanart.tv/get-an-api-key/"
          onSave={(key) => keep(key)}
          onRemove={() => keep(null)}
        />
      </SettingRow>
    </div>
  );
}
