import { MediaArt } from "@/components/media/MediaArt";

/**
 * The drag's face: a stacked card riding the cursor with the count — ONE
 * look for every drag that carries content somewhere (the queue's batch
 * drag, a single queue drag handed off to the nav rail, the Library's
 * drag-to-rail ghost). Owning it here keeps the three from drifting; the
 * queue's DragOverlay and the Library's pointer ghost both render this.
 */
export function DragChip({
  title,
  artUrl,
  count,
}: {
  title: string;
  artUrl?: string | null;
  count: number;
}): React.JSX.Element {
  return (
    <div className="relative w-[320px]" data-drag-chip>
      {count > 2 && (
        <span
          aria-hidden
          data-drag-stack
          className="absolute inset-x-3 top-3 -bottom-3 -z-20 rounded-lg bg-raised ring-1 ring-edge shadow-md"
        />
      )}
      {count > 1 && (
        <span
          aria-hidden
          data-drag-stack
          className="absolute inset-x-1.5 top-1.5 -bottom-1.5 -z-10 rounded-lg bg-raised ring-1 ring-edge2 shadow-lg"
        />
      )}
      <div className="flex items-center gap-2.5 rounded-lg bg-raised ring-1 ring-edge2 shadow-xl px-2.5 py-1.5">
        <MediaArt src={artUrl} kind="track" />
        <div className="min-w-0 flex-1 text-[13px] text-ink truncate">{title}</div>
        <span className="shrink-0 rounded-full bg-gold text-bg text-[10.5px] font-medium px-2 py-0.5">
          {count} {count === 1 ? "track" : "tracks"}
        </span>
      </div>
    </div>
  );
}
