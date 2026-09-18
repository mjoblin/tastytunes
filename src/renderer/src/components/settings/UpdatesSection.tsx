import { useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { version } from "../../../../../package.json";
import { type AppSettings, type UpdateCheckResult } from "@shared/model";
import { REPO_URL } from "@shared/ipc";
import { tt } from "@/api";
import { useStore } from "@/store";
import { HeaderChip, PrimaryButton } from "@/components/chrome/Chrome";
import { SettingRow, Toggle } from "@/components/settings/SettingsKit";

// The Updates section, split out of SettingsScreen.tsx 2026-09-13 (the Settings split: the screen had held every
// section and control at 2,142 lines); the shared rows and controls live in ./SettingsKit.

export function UpdatesSection({
  settings,
  save,
}: {
  settings: AppSettings;
  save(patch: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  const update = useStore((s) => s.update);
  // Manual-check feedback: 'checking' while in flight, then the outcomes the
  // consent panel won't announce itself ('none' / 'error'; 'update' clears
  // this — the panel and the dots take over).
  const [manual, setManual] = useState<"checking" | UpdateCheckResult | null>(null);
  const checkNow = async (): Promise<void> => {
    setManual("checking");
    const res = await tt.updateCheckNow();
    setManual(res.status === "update" ? null : res);
  };

  return (
    <section className="space-y-3">
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-5">
        <SettingRow label="Version" hint="The build you're running.">
          <span className="flex items-center gap-2.5">
            <span className="font-mono text-[12px] text-dim">v{version}</span>
            {/* The notes for THIS build, any time — not just at update time.
                Dev builds self-identify as the NEXT release, so the tag may
                not exist yet there; for packaged builds the tag-matches-
                version CI gate guarantees the page. */}
            <button
              onClick={() => void tt.openExternal(`${REPO_URL}/releases/tag/v${version}`)}
              aria-label={`Release notes for v${version}`}
              data-release-notes
              className="font-mono text-[11px] text-faint underline underline-offset-2 hover:text-dim transition-colors"
            >
              release notes
            </button>
          </span>
        </SettingRow>

        <Toggle
          label="Automatically check for updates"
          hint="Check for version updates at launch and every few hours. When a new version is available, a dot appears on the tastytunes name in the left nav and on this tab. TastyTunes will not download or install itself."
          checked={settings.updateCheck}
          onChange={(updateCheck) => void save({ updateCheck })}
        />
      </div>

      {update ? (
        <UpdatePanel />
      ) : (
        <div className="rounded-xl ring-1 ring-edge bg-panel/70 px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-dim min-w-0">
            {manual === "checking" ? (
              "Checking…"
            ) : manual?.status === "none" ? (
              `You're on the latest release, v${version}.`
            ) : manual?.status === "error" ? (
              <span className="text-alert break-all">Couldn&apos;t check: {manual.error}</span>
            ) : settings.updateCheck ? (
              `You're on v${version}; no newer version is known.`
            ) : (
              "Automatic update checks are off."
            )}
          </span>
          <HeaderChip
            onClick={() => void checkNow()}
            disabled={manual === "checking"}
            className="shrink-0 flex items-center gap-1.5 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90 disabled:opacity-50 disabled:pointer-events-none"
          >
            {manual === "checking" ? (
              <Loader2 size={13} className="motion-safe:animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            Check now
          </HeaderChip>
        </div>
      )}
    </section>
  );
}

/** The self-update consent panel (moved here from the Info modal — Updates
 *  is its home now; the nav dot deep-links to this tab). */
function UpdatePanel(): React.JSX.Element | null {
  const update = useStore((s) => s.update);
  if (!update) return null;

  return (
    <div className="w-full rounded-xl ring-1 ring-gold/40 bg-golddim px-4 py-3">
      {update.phase === "available" && (
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[13.5px] text-gold">v{update.version} is available</span>
            <span className="block font-mono text-[10.5px] text-faint mt-0.5">
              {update.canDownload
                ? "nothing downloads until you click Download"
                : "open the release page to download"}
              {update.canDownload && (
                <>
                  {" · "}
                  <button
                    onClick={() => void tt.openExternal(update.url)}
                    aria-label={`What's new in v${update.version}`}
                    className="underline underline-offset-2 hover:text-dim transition-colors"
                  >
                    what&apos;s new
                  </button>
                </>
              )}
            </span>
          </span>
          {update.canDownload ? (
            <PrimaryButton
              onClick={() => void tt.updateDownload()}
              className="shrink-0 text-[12.5px] px-3.5 py-1.5"
            >
              Download
            </PrimaryButton>
          ) : (
            <HeaderChip
              onClick={() => void tt.openExternal(update.url)}
              className="shrink-0 flex items-center gap-1.5 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
            >
              Release page <ExternalLink size={12} />
            </HeaderChip>
          )}
        </div>
      )}

      {update.phase === "downloading" && (
        <div>
          <div className="flex items-center justify-between text-[13.5px] text-gold">
            <span>Downloading v{update.version}…</span>
            <span className="font-mono text-[11px]">{update.percent ?? 0}%</span>
          </div>
          <div className="h-1 rounded-full bg-veil2 mt-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-gold transition-[width] duration-300"
              style={{ width: `${update.percent ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {update.phase === "downloaded" && (
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[13.5px] text-gold">v{update.version} is ready</span>
            <span className="block font-mono text-[10.5px] text-faint mt-0.5">
              installs when you quit, or restart now{" · "}
              <button
                onClick={() => void tt.openExternal(update.url)}
                aria-label={`What's new in v${update.version}`}
                className="underline underline-offset-2 hover:text-dim transition-colors"
              >
                what&apos;s new
              </button>
            </span>
          </span>
          <PrimaryButton
            onClick={() => void tt.updateInstall()}
            className="shrink-0 text-[12.5px] px-3.5 py-1.5"
          >
            Restart now
          </PrimaryButton>
        </div>
      )}

      {update.phase === "error" && (
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[13.5px] text-alert">Update failed</span>
            <span className="block font-mono text-[10.5px] text-faint mt-0.5 break-all">
              {update.error}
            </span>
          </span>
          <HeaderChip
            onClick={() => void tt.updateDownload()}
            className="shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90"
          >
            Try again
          </HeaderChip>
        </div>
      )}
    </div>
  );
}
