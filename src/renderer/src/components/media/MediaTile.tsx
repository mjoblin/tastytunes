import { cx } from "@/lib/format";
import { CARD_TRANSITION } from "@/lib/cardHover";
import { MediaArt } from "@/components/media/MediaArt";

/**
 * A TILE of a list shown as cards (another screen's queue and presets, display/PageTransport): the
 * art square, then the name and a second line, the playing one wearing the tiles' gold ring
 * (tile-playing) and its name in gold, as on the Presets screen; one on its way to playing
 * half-lit, as MediaRow's tuning. Sized for a finger: a press shows at once.
 */
export function MediaTile({
  attrs,
  art,
  kind,
  title,
  sub,
  playing,
  tuning = false,
  onPress,
}: {
  attrs: Record<string, string>;
  art: string | null;
  kind: "track" | "preset";
  title: string;
  sub?: string | null;
  playing: boolean;
  tuning?: boolean;
  onPress(): void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      {...attrs}
      onClick={onPress}
      className={cx(
        // the column's width exactly, whatever the picture's own size: sized to its content, a
        // tile grew to each cover's pixels (a library's covers differ; the mock's don't)
        "group relative block w-full min-w-0 overflow-hidden rounded-lg text-left [-webkit-tap-highlight-color:transparent] motion-safe:active:scale-[0.97]",
        CARD_TRANSITION,
        playing ? "tile-playing" : tuning ? "ring-1 ring-gold/40" : "ring-1 ring-edge",
      )}
    >
      <div className="aspect-square w-full overflow-hidden bg-raised">
        <MediaArt src={art} kind={kind} size="card" />
      </div>
      <div className="px-2.5 py-2">
        <div className={cx("truncate text-[13.5px]", playing ? "text-gold" : "text-ink")}>
          {title}
        </div>
        {sub && <div className="truncate text-[12px] text-dim">{sub}</div>}
      </div>
    </button>
  );
}
