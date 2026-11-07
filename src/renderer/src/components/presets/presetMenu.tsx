// A PRESET'S ⋯ MENU and the album a preset references. Moved out of PresetsScreen.tsx as it was
// (0.15.0, the hygiene pass).
import { useState } from "react";
import { type PresetItem } from "@shared/smoip";
import { type MediaNode } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { useConfirmPopover } from "@/components/chrome/Confirm";
import { RowMenu } from "@/components/media/RowMenu";
import { openArtistInLibrary, openRefInLibrary } from "@/lib/mediaActions";
import { fromNode } from "@/lib/mediaRef";
import { menuAt } from "@/lib/menuAt";
import { nameKey } from "@shared/keys";
import { PopoverStop, usePresetVolumePopover } from "./presetVolume";

/**
 * THE ARTWORK IS THE FINGERPRINT: a media preset's album in the library is the one album whose
 * art URL is the preset's (the streamer keeps no object id worth trusting, Asset re-mints them
 * on a rescan, but the art id survives; 44/44 of the author's UPnP presets matched this way).
 * One home: the repair chip finds the album's current id with it, the ⋯ menu's Open in Library
 * and Go to artist find the album.
 *
 * A preset with no picture (0.13.0-rc.6, his preset 24, left "[No title]" by a repair that saved
 * a blank) is found by what it last played (listeningRecord.presetLastAlbum): that play's
 * picture, or its album and artist, in every library that has it. `by` says which way it was
 * found and `last` names the album History has, for the repair's words.
 */
export async function presetAlbums(
  preset: PresetItem,
): Promise<{ albums: MediaNode[]; by: "picture" | "history" | null; last: string | null }> {
  const pools = await tt.mediaIndexPools();
  const all = pools.flatMap((pool) => pool.albums);
  const pictured = (url: string): MediaNode[] => all.filter((a) => a.artUrl === url);
  if (preset.art_url) return { albums: pictured(preset.art_url), by: "picture", last: null };
  const last = preset.id == null ? null : await tt.presetLastAlbum(preset.id);
  if (!last) return { albums: [], by: null, last: null };
  const byPicture = last.artUrl ? pictured(last.artUrl) : [];
  if (byPicture.length > 0) return { albums: byPicture, by: "history", last: last.album };
  const named = all.filter(
    (a) =>
      nameKey(a.title) === nameKey(last.album) &&
      (last.artist == null || nameKey(a.artist) === nameKey(last.artist)),
  );
  return { albums: named, by: "history", last: last.album };
}

/** The preset's one album, or null when no album, or more than one, is it. */
async function presetAlbum(preset: PresetItem): Promise<MediaNode | null> {
  const { albums } = await presetAlbums(preset);
  return albums.length === 1 ? albums[0] : null;
}

/**
 * A PRESET'S ⋯ (0.12.0, his call after a user's email asked why a preset plays rather than
 * opening): a click still recalls (a preset is the streamer's button, and the streamer keeps no
 * track list for it), and the ⋯, where the trash used to be, holds the rest. Play; Open in
 * Library and Go to artist for a media preset (by its art, presetAlbum; a station or a saved
 * queue has nothing to open); Rename… in place; Preset volume…; Delete preset, last and
 * confirmed, only here. Right-click opens it too.
 */
export function usePresetMenu(
  preset: PresetItem,
  d: {
    onRecall(): void;
    pv: ReturnType<typeof usePresetVolumePopover>;
    canVolume: boolean;
    startRename(): void;
    /** A preset that didn't load: its repair, the chip's, in the menu too (0.14.0, for the
     *  keyboard, which the chip is out of the way of). */
    repair?: () => void;
  },
): {
  open(e: React.MouseEvent): void;
  isOpen: boolean;
  popovers: React.ReactNode;
} {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const confirmDelete = useConfirmPopover();
  const showToast = useStore((s) => s.showToast);
  const name = preset.name ?? `Preset ${preset.id}`;
  // what the menu offers opens where the menu stood (the ⋯ clicked, or the right-click's point),
  // so a choice turns into its popover in place
  const [from, setFrom] = useState<{ x: number; y: number } | null>(null);
  const here = (): { x: number; y: number } => from ?? { x: 0, y: 0 };
  // A MEDIA PRESET by its class: the Evo calls a library album's preset type "UPnP" (read
  // 2026-10-17; the mock had "MEDIA"), a station "Radio", an input "Input", and a saved queue is a
  // "MediaQueue" with a collage of covers, nothing to open
  const media =
    /^stream\.media/.test(preset.class ?? "") &&
    preset.type !== "MediaQueue" &&
    !(preset.art_urls && preset.art_urls.length > 1);
  const withAlbum = (then: (album: MediaNode) => void): void => {
    void presetAlbum(preset).then((album) => {
      if (album) then(album);
      else showToast({ kind: "error", text: `Couldn't find “${name}” in your library.` });
    });
  };
  const items = [
    { label: "Play", run: d.onRecall },
    ...(d.repair ? [{ label: "Repair…", run: d.repair }] : []),
    ...(media
      ? [
          {
            label: "Open in Library",
            run: () => withAlbum((a) => void openRefInLibrary(fromNode(a, a.serverUdn))),
          },
          {
            label: "Go to artist",
            run: () =>
              withAlbum((a) => {
                if (a.artist) openArtistInLibrary(a.artist);
                else showToast({ kind: "error", text: `“${name}” has no artist in your library.` });
              }),
          },
        ]
      : []),
    { label: "Rename…", run: d.startRename },
    ...(d.canVolume ? [{ label: "Preset volume…", run: () => d.pv.openAt(here()) }] : []),
    {
      label: "Delete preset",
      run: () =>
        confirmDelete.askAt(here(), {
          question: `Delete “${name}”?`,
          onConfirm: () => {
            if (preset.id != null) void tt.command({ type: "presetDelete", presetId: preset.id });
          },
        }),
    },
  ];
  return {
    open: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setAt(menuAt(e));
      setFrom(menuAt(e));
    },
    isOpen: at != null,
    // rendered only while something is open: a row's grid counts its children (S2's anatomy)
    popovers:
      at || confirmDelete.popover ? (
        <PopoverStop>
          {at && <RowMenu title={name} at={at} items={items} onClose={() => setAt(null)} />}
          {confirmDelete.popover}
        </PopoverStop>
      ) : null,
  };
}
