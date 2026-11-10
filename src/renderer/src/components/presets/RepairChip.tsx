// A PRESET'S REPAIR CHIP, for a recall that loaded nothing. Moved out of PresetsScreen.tsx as it
// was (0.15.0, the hygiene pass).
import { useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { objectGone } from "@shared/ipc";
import { type PresetItem } from "@shared/smoip";
import { tt } from "@/api";
import { useInListKeys } from "@/hooks/useListKeys";
import { cx } from "@/lib/format";
import { PopoverChrome } from "@/hooks/usePopover";
import { POPOVER_CARD } from "@/components/chrome/Overlay";
import { cardChip } from "@/components/chrome/Chrome";
import { ConfirmActions } from "@/components/chrome/Confirm";
import { isAlbumPreset, presetAlbums } from "./presetMenu";

/**
 * A preset that points at content its media server no longer resolves. The
 * firmware accepts the recall and silently ignores it, so the app has to name
 * the failure — and can usually fix it: Asset re-mints object ids on a
 * rescan, but the ART id survives, which makes the artwork a reliable
 * fingerprint for finding the same album's CURRENT id in the media index
 * (44/44 of the author's UPnP presets matched this way).
 *
 * Radio presets are out of scope: an airable id has no index to match against.
 */
export function RepairChip({
  preset,
  variant,
  buttonRef,
  onRepaired,
}: {
  preset: PresetItem;
  variant: "card" | "row";
  /** The chip itself, for the preset menu's Repair… to press. */
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
  onRepaired(): void;
}): React.JSX.Element {
  const inList = useInListKeys();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  // undefined = looking
  const [found, setFound] = useState<Awaited<ReturnType<typeof presetAlbums>> | undefined>(
    undefined,
  );
  const [pick, setPick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const WIDTH = 268;
  const match = found?.albums[pick] ?? null;

  const openFrom = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    if (open) return setOpen(false);
    const r = e.currentTarget.getBoundingClientRect();
    setAnchor({
      left: Math.min(Math.max(8, r.left), window.innerWidth - WIDTH - 8),
      top: Math.min(r.bottom + 8, window.innerHeight - 200),
    });
    setFound(undefined);
    setPick(0);
    setFailed(null);
    setOpen(true);
    // the artwork is the fingerprint, then History, then an album preset's name (presetAlbums)
    setFound(await presetAlbums(preset));
  };

  const repair = async (): Promise<void> => {
    if (!match?.serverUdn || preset.id == null) return;
    setSaving(true);
    setFailed(null);
    try {
      await tt.mediaPresetSave(match.serverUdn, match.id, preset.id);
      setOpen(false);
      onRepaired();
    } catch (e) {
      // main looked for the album under its current id first (ipc/media withCurrentIds)
      setFailed(
        objectGone(e)
          ? "Couldn't save the preset. The server no longer has this album."
          : "Couldn't save the preset.",
      );
    } finally {
      setSaving(false);
    }
  };

  const chip =
    variant === "card" ? (
      <button
        ref={buttonRef}
        tabIndex={inList ? -1 : undefined}
        data-preset-dead
        data-tip="Didn't load. Click to repair."
        aria-label="Repair preset (didn't load)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => void openFrom(e)}
        className={cx("tip-bottom absolute top-2 left-2 z-10 text-alert", cardChip(true))}
      >
        <AlertTriangle size={14} />
      </button>
    ) : (
      <button
        ref={buttonRef}
        tabIndex={inList ? -1 : undefined}
        data-preset-dead
        data-tip="Didn't load. Click to repair."
        aria-label="Repair preset (didn't load)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => void openFrom(e)}
        className="tip-bottom p-1 rounded text-alert hover:text-ink transition-colors"
      >
        <AlertTriangle size={13} />
      </button>
    );

  return (
    <>
      {chip}
      {open &&
        anchor &&
        createPortal(
          <>
            <PopoverChrome onClose={() => setOpen(false)} />
            <span
              className="fixed inset-0 z-30 cursor-default"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            />
            <span
              data-preset-repair-popover
              style={anchor}
              className={cx("fixed z-40 w-[268px] p-3 block cursor-default", POPOVER_CARD)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="microlabel text-dim block mb-2">preset didn't load</span>
              <span className="block text-[11px] text-faint leading-relaxed">
                This preset points at something the media server no longer has. Its id changed, most
                likely when the library was rescanned. The streamer accepts the recall and then does
                nothing.
              </span>
              {found === undefined && (
                <span className="block text-[11px] text-faint mt-2.5">Looking in the index…</span>
              )}
              {found != null && match == null && (
                <span className="block text-[11px] text-faint mt-2.5">
                  {found.by === "picture"
                    ? isAlbumPreset(preset)
                      ? "No match in the library index for this preset's artwork or name, so there's nothing safe to save. Re-save it by hand from the Library."
                      : "No match in the library index for this preset's artwork, so there's nothing safe to save. Re-save it by hand from the Library."
                    : found.last != null
                      ? `This preset last played “${found.last}”, which isn't in the library index. Re-save it by hand from the Library.`
                      : "This preset has no picture to match by, and History has no plays of it. Re-save it by hand from the Library."}
                </span>
              )}
              {found != null && match != null && (
                <>
                  {(found.by !== "picture" || found.albums.length > 1) && (
                    <span
                      data-preset-repair-by={found.by}
                      className="block text-[11px] text-faint mt-2.5"
                    >
                      {found.by === "picture"
                        ? "More than one album has this preset's picture. Choose the one to save."
                        : found.by === "name"
                          ? found.albums.length > 1
                            ? "More than one album has the same name as the preset. Choose the one to save."
                            : "This album has the same name as the preset."
                          : found.albums.length > 1
                            ? "This preset last played this album, and there's more than one copy. Choose the one to save."
                            : "This preset last played this album."}
                    </span>
                  )}
                  {found.albums.length > 1 ? (
                    <span data-preset-repair-copies className="block mt-2 space-y-1">
                      {found.albums.map((a, i) => (
                        <button
                          key={`${a.serverUdn ?? ""}|${a.id}`}
                          data-preset-repair-copy
                          aria-pressed={i === pick}
                          onClick={() => setPick(i)}
                          className={cx(
                            "block w-full text-left rounded px-2 py-1 transition-colors",
                            i === pick ? "bg-amberdim text-ink" : "text-dim hover:text-ink",
                          )}
                        >
                          <span className="block text-[12px] truncate">{a.title}</span>
                          <span className="block text-[11px] truncate">
                            {[a.artist, a.serverName].filter(Boolean).join(" · ")}
                          </span>
                        </button>
                      ))}
                    </span>
                  ) : (
                    <>
                      <span className="block text-[12px] text-ink mt-2.5 truncate">
                        {match.title}
                      </span>
                      <span className="block text-[11px] text-dim truncate">
                        {[match.artist, match.serverName].filter(Boolean).join(" · ")}
                      </span>
                    </>
                  )}
                  {failed && (
                    <span data-preset-repair-failed className="block text-[11px] text-alert mt-2">
                      {failed}
                    </span>
                  )}
                  <ConfirmActions
                    tone="gold"
                    busy={saving}
                    verb={saving ? "Repairing…" : `Save to slot ${preset.id}`}
                    onCancel={() => setOpen(false)}
                    onConfirm={() => void repair()}
                  />
                </>
              )}
            </span>
          </>,
          document.body,
        )}
    </>
  );
}
