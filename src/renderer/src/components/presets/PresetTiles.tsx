// A PRESET AS A ROW AND AS A CARD, with its glyph and its name's inline edit. Moved out of
// PresetsScreen.tsx as it was (0.15.0, the hygiene pass).
import { useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { Loader2, MoreHorizontal, Play, Volume2 } from "lucide-react";
import { type PresetItem } from "@shared/smoip";
import { tt } from "@/api";
import { Eqbars } from "@/components/media/Eqbars";
import { lockVertical, ROW_MOTION, sortableStyle } from "@/lib/dnd";
import { CARD_GLYPH_STROKE, MEDIA_ART_FALLBACK } from "@/components/media/MediaArt";
import { OrderHandle } from "@/components/controls/OrderHandle";
import { useInListKeys, type ListItemAttrs } from "@/hooks/useListKeys";
import { cx } from "@/lib/format";
import { ArtImage } from "@/components/media/ArtImage";
import { cardChip } from "@/components/chrome/Chrome";
import { artSrc } from "@/lib/artSrc";
import { CARD_HOVER, CARD_MOTION } from "@/lib/cardHover";
import { type PresetVolumeProps, usePresetVolumePopover } from "./presetVolume";
import { usePresetMenu } from "./presetMenu";
import { RepairChip } from "./RepairChip";

/** The same glyph the tray panel's preset tiles fall back to — one table. */
const PresetGlyph = MEDIA_ART_FALLBACK.preset;

/** A preset's name, edited in place: Enter or leaving the field saves it (trimmed, if changed),
 *  Escape keeps the old one. The streamer's own rename verb, until now only offered at save. */
function PresetNameEdit({
  preset,
  className,
  onDone,
}: {
  preset: PresetItem;
  className: string;
  onDone(): void;
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean): void => {
    if (done.current) return;
    done.current = true;
    const name = ref.current?.value.trim() ?? "";
    if (save && name && name !== preset.name && preset.id != null)
      void tt.command({ type: "presetRename", slot: preset.id, name });
    onDone();
  };
  return (
    <input
      ref={ref}
      data-preset-rename
      defaultValue={preset.name ?? ""}
      aria-label={`Rename preset ${preset.id}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      className={cx(
        "w-full min-w-0 rounded-md bg-panel ring-1 ring-edge2 px-1.5 py-0.5 outline-none focus:ring-accent/60",
        className,
      )}
    />
  );
}

/** Row view of a preset — mirrors the queue row's anatomy. */
export function PresetRow({
  preset,
  playing,
  dead,
  onRepaired,
  tuning,
  onRecall,
  volume,
  canSetVolume,
  onVolume,
  listItem,
}: {
  /** In the keyed list (hooks/useListKeys, 0.14.0): the item's id and index. */
  listItem?: ListItemAttrs;
  preset: PresetItem;
  playing: boolean;
  /** Recall was accepted and then silently ignored — see RepairChip. */
  dead?: boolean;
  onRepaired?(): void;
  tuning: boolean;
  onRecall(): void;
} & PresetVolumeProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: preset.id as number,
  });
  const pv = usePresetVolumePopover(volume, onVolume);
  const [renaming, setRenaming] = useState(false);
  const repairRef = useRef<HTMLButtonElement | null>(null);
  const menu = usePresetMenu(preset, {
    onRecall,
    pv,
    canVolume: canSetVolume || volume != null,
    startRename: () => setRenaming(true),
    repair: dead ? () => repairRef.current?.click() : undefined,
  });
  // in the keyed list a preset is reached with the arrows, its actions through More (K1, K4)
  const inList = useInListKeys();

  return (
    <div
      ref={setNodeRef}
      style={sortableStyle(lockVertical(transform), transition, ROW_MOTION)}
      {...listItem}
      onContextMenu={menu.open}
      data-playing={playing || undefined}
      className={cx(
        // FIVE columns for five children — the sixth column outlived the
        // trailing grip when it moved into the position cell (OrderHandle),
        // and an empty grid track still costs its gap.
        "group grid grid-cols-[26px_44px_1fr_auto_auto] items-center gap-3 rounded-lg px-3 py-1.5",
        "cursor-default",
        isDragging && "z-10 bg-raised shadow-xl",
        // hold the hover highlight while this row's volume popover is open —
        // the pointer leaves the row, but the row is still what's being edited
        playing ? "row-playing bg-gold/10" : pv.open || menu.isOpen ? "bg-veil" : "hover:bg-veil",
      )}
      onClick={renaming ? undefined : onRecall}
    >
      <OrderHandle
        label={`Reorder preset ${preset.id}`}
        attributes={attributes}
        listeners={listeners}
      >
        {playing ? (
          <Eqbars />
        ) : tuning ? (
          <Loader2 data-preset-tuning size={13} className="spin text-gold/80" />
        ) : (
          <span className="font-mono text-[10.5px] text-faint tabular-nums">
            {String(preset.id).padStart(2, "0")}
          </span>
        )}
      </OrderHandle>

      <div className="h-10 w-10 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage
          src={artSrc(preset.art_url, 40)}
          lazy
          fallback={<PresetGlyph size={16} className="text-faint" />}
        />
      </div>

      <div className="min-w-0">
        {renaming ? (
          <PresetNameEdit
            preset={preset}
            className="text-[13.5px] text-ink"
            onDone={() => setRenaming(false)}
          />
        ) : (
          <div className={cx("text-[13.5px] truncate", playing ? "text-gold" : "text-ink")}>
            {preset.name ?? `Preset ${preset.id}`}
          </div>
        )}
        <div className="text-[12px] text-dim truncate">
          {preset.class ? preset.class.replace(/^stream\./, "") : ""}
        </div>
      </div>

      <span className="inline-flex items-center" onPointerDown={(e) => e.stopPropagation()}>
        {dead && (
          <RepairChip
            preset={preset}
            variant="row"
            buttonRef={repairRef}
            onRepaired={() => onRepaired?.()}
          />
        )}
        {/* a set volume shows as its status (it changes what a recall does); setting one is the
            ⋯ menu's Preset volume… (0.12.0: the hover speaker went with the menu's arrival) */}
        {volume != null && (
          <button
            tabIndex={inList ? -1 : undefined}
            data-tip={`Recalled at ${volume}% volume`}
            aria-label="Preset volume"
            onClick={pv.openFrom}
            data-preset-volume-badge
            className="tip-bottom flex items-center gap-1 p-1 rounded font-mono text-[10px] text-faint hover:text-ink transition-colors tabular-nums"
          >
            <Volume2 size={11} />
            {volume}%
          </button>
        )}
        {pv.popover}
      </span>

      <button
        tabIndex={inList ? -1 : undefined}
        aria-label="More actions"
        data-preset-menu
        onPointerDown={(e) => e.stopPropagation()}
        onClick={menu.open}
        className={cx(
          "p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all",
          menu.isOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-kbd:opacity-100",
        )}
      >
        <MoreHorizontal size={14} />
      </button>
      {menu.popovers}
    </div>
  );
}

export function PresetCard({
  preset,
  playing,
  dead,
  onRepaired,
  tuning,
  onRecall,
  volume,
  canSetVolume,
  onVolume,
  listItem,
}: {
  /** In the keyed list (hooks/useListKeys, 0.14.0): the item's id and index. */
  listItem?: ListItemAttrs;
  preset: PresetItem;
  playing: boolean;
  /** Recall was accepted and then silently ignored — see RepairChip. */
  dead?: boolean;
  onRepaired?(): void;
  tuning: boolean;
  onRecall(): void;
} & PresetVolumeProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: preset.id as number,
  });
  const pv = usePresetVolumePopover(volume, onVolume);
  const [renaming, setRenaming] = useState(false);
  const repairRef = useRef<HTMLButtonElement | null>(null);
  const menu = usePresetMenu(preset, {
    onRecall,
    pv,
    canVolume: canSetVolume || volume != null,
    startRename: () => setRenaming(true),
    repair: dead ? () => repairRef.current?.click() : undefined,
  });
  // in the keyed list a preset is reached with the arrows, its actions through More (K1, K4)
  const inList = useInListKeys();

  return (
    <div
      ref={setNodeRef}
      style={sortableStyle(transform, transition, CARD_MOTION)}
      {...attributes}
      {...listeners}
      {...listItem}
      tabIndex={inList ? -1 : attributes.tabIndex}
      onContextMenu={menu.open}
      data-playing={playing || undefined}
      className={cx(
        // Inset tile: the gold highlight wraps the gray tile, never the art, so
        // it stays legible on gold/orange album covers.
        // Hover: a slight grow + lift (scale is layout-free, so edge-clipped
        // cards just clip at the scrollport; z-10 keeps the grown card on top).
        "group relative text-left rounded-2xl p-2 pb-2.5",
        CARD_HOVER,
        isDragging && "z-10 opacity-90",
        playing ? "bg-goldtile/70 tile-playing" : "bg-raised/50 ring-1 ring-edge card-hover-glow",
        // held while this card's volume popover is open — the pointer has left,
        // but the card is still what's being edited
        (pv.open || menu.isOpen) && "ring-1 ring-edge2",
      )}
    >
      {/* relative wrapper bounds exactly the art, so the corner chips anchor
          to the artwork: playing top-left, a set volume's speaker top-right, the ⋯
          bottom-right (the card grammar's corner) */}
      <div className="relative">
        <button
          className="relative block w-full cursor-pointer"
          tabIndex={inList ? -1 : undefined}
          onClick={onRecall}
        >
          {/* the art well is a veil lift, never a panel hole — see LibraryCards */}
          <div className="aspect-square w-full rounded-lg overflow-hidden bg-veil flex items-center justify-center">
            {preset.art_urls && preset.art_urls.length > 1 ? (
              // saved-queue (MediaQueue) presets: collage of the queue's albums
              <div
                className={cx(
                  "grid w-full h-full grid-cols-2",
                  preset.art_urls.length > 2 ? "grid-rows-2" : "grid-rows-1",
                )}
              >
                {preset.art_urls.slice(0, 4).map((u) => (
                  <ArtImage
                    key={u}
                    src={artSrc(u, 120)}
                    lazy
                    fallback={<div className="bg-veil h-full w-full" />}
                  />
                ))}
              </div>
            ) : (
              <ArtImage
                src={artSrc(preset.art_url, 240)}
                lazy
                fallback={
                  <PresetGlyph size={34} strokeWidth={CARD_GLYPH_STROKE} className="text-faint" />
                }
              />
            )}

            {/* hover overlay — the whole card recalls the preset; the chip is the affordance */}
            <div className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 group-kbd:opacity-100 transition-opacity flex items-center justify-center">
              <span
                className="h-11 w-11 rounded-full bg-accent text-bg flex items-center justify-center
                         transition-all duration-150 motion-safe:hover:scale-110
                         hover:shadow-[0_0_24px_rgb(var(--accent-rgb)_/_0.6)]"
              >
                <Play size={18} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />
              </span>
            </div>

            {playing && (
              // h/w match the corner buttons so the four corners feel weighted
              <span className={cx("absolute top-2 left-2", cardChip())}>
                <Eqbars />
              </span>
            )}
            {tuning && (
              // same corner the playing chip will claim — spinner hands over to bars
              <span data-preset-tuning className={cx("absolute top-2 left-2", cardChip())}>
                <Loader2 size={14} className="spin text-gold/90" />
              </span>
            )}
          </div>
        </button>

        {/* the alert takes the corner the tuning spinner hands over, and is a
          sibling of the recall button (not a child) — nested buttons are
          invalid, and this one must not also fire the recall */}
        {dead && (
          <RepairChip
            preset={preset}
            variant="card"
            buttonRef={repairRef}
            onRepaired={() => onRepaired?.()}
          />
        )}

        {/* the speaker shows a set volume (presence and color are the status, the tooltip
          carries the percentage, a click adjusts it); setting one is the ⋯ menu's Preset
          volume… (0.12.0: the hover-revealed speaker went with the menu's arrival) */}
        {volume != null && (
          <button
            tabIndex={inList ? -1 : undefined}
            data-tip={`Recalled at ${volume}% volume`}
            aria-label="Preset volume"
            onClick={pv.openFrom}
            onPointerDown={(e) => e.stopPropagation()}
            data-preset-volume
            className={cx(
              "tip-bottom absolute top-2 right-2 z-10 text-accent hover:text-ink transition-all",
              cardChip(),
            )}
          >
            <Volume2 size={14} />
          </button>
        )}
        <button
          tabIndex={inList ? -1 : undefined}
          aria-label="More actions"
          data-preset-menu
          onPointerDown={(e) => e.stopPropagation()}
          onClick={menu.open}
          className={cx(
            "absolute bottom-2 right-2 z-10 transition-all text-dim hover:text-ink",
            cardChip(),
            menu.isOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-kbd:opacity-100",
          )}
        >
          <MoreHorizontal size={15} />
        </button>
      </div>

      {/* the label is part of the card — clicking it recalls too (it used to
          be a dead zone below the artwork button, which read as a broken card) */}
      <div className="mt-2 px-1 cursor-pointer" onClick={renaming ? undefined : onRecall}>
        {renaming ? (
          <PresetNameEdit
            preset={preset}
            className="text-[12.5px] leading-snug text-ink"
            onDone={() => setRenaming(false)}
          />
        ) : (
          <div
            className={cx(
              "text-[12.5px] leading-snug line-clamp-2",
              playing ? "text-gold" : "text-ink",
            )}
          >
            {preset.name ?? `Preset ${preset.id}`}
          </div>
        )}
        <div className="microlabel mt-1">
          {String(preset.id).padStart(2, "0")}
          {preset.class ? ` · ${preset.class.replace(/^stream\./, "")}` : ""}
        </div>
      </div>
      {pv.popover}
      {menu.popovers}
    </div>
  );
}
