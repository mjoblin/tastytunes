import { PopoverCard } from "@/components/chrome/Overlay";

/**
 * The row ⋯ / right-click menu: a truncated title, then plain verbs. One
 * component because three screens (Favorites, Queue, Playlists) had grown
 * byte-identical private copies — the third one's own comment called itself
 * "third instance", which is the cue to extract.
 *
 * The portal, backdrop, clamp and card surface come from PopoverCard.
 */
export function RowMenu({
  title,
  at,
  items,
  onClose,
}: {
  /** What the menu is about — a track or favorite title, shown truncated. */
  title: string;
  at: { x: number; y: number };
  items: Array<{ label: string; run: () => void }>;
  onClose(): void;
}): React.JSX.Element {
  return (
    <PopoverCard
      at={at}
      width="w-52"
      onClose={onClose}
      rightClickCloses
      className="p-1.5 space-y-0.5"
    >
      <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint truncate">{title}</div>
      {items.map((it) => (
        <button
          key={it.label}
          onClick={() => {
            onClose();
            it.run();
          }}
          className="w-full px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim hover:text-ink hover:bg-veil transition-colors"
        >
          {it.label}
        </button>
      ))}
    </PopoverCard>
  );
}
