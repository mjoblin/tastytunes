import { useMemo, useState } from "react";
import type { MediaNode } from "@shared/model";
import { recentlyAdded } from "@shared/recentlyAdded";
import { useStore } from "@/store";
import { Chip } from "@/components/chrome/Chrome";
import { ContainerCard } from "@/components/library/LibraryCards";
import { RowMenu } from "@/components/media/RowMenu";
import { useColumns } from "@/hooks/useColumns";
import { useIndexPools } from "@/hooks/useIndexPools";
import { fmtAdded, fmtCount } from "@/lib/format";
import { albumMenuItems, type MediaMenuItem } from "@/lib/mediaMenus";
import { openAlbumNode, playAlbumNode } from "@/lib/mediaActions";
import { fromNode } from "@/lib/mediaRef";

/** The shelf's cards against the reader's card size: smaller, so the doors above stay the
 *  page's lead and more of a batch fits (his note, 2026-10-25: "a little smaller"; then, on his
 *  library, "a little small now. bump them a bit bigger": 0.8 became 0.9). */
const SHELF_SCALE = 0.9;

/**
 * RECENTLY ADDED ON THE LIBRARY'S FRONT PAGE (0.13.0 round 9, his pick on the decision page: a
 * shelf under the doors). One row of the albums known to be recent, in shared/recentlyAdded's
 * order (the dated newest first, then a server's own list), as History's Rediscover shelves show
 * theirs: the Library's own album cards, at a step under the reader's card size and not stretched,
 * each saying when it arrived where the app knows it (his pick: "when it arrived, where known"),
 * on the card's note line under its names (his rule, 2026-09-11: a surface's fact goes after the
 * card's own). See all opens the Albums lens in the same order. Not there when nothing is known.
 */
export function RecentlyAddedShelf({ seeAll }: { seeAll(): void }): React.JSX.Element | null {
  const pools = useIndexPools();
  const cardSize = Math.round(useStore((s) => s.settings.presetCardSize) * SHELF_SCALE);
  const gap = useStore((s) => s.settings.presetGap);
  const [attach, columns] = useColumns(cardSize, gap);
  const albums = useMemo(
    () => (pools ? recentlyAdded(pools.flatMap((p) => p.albums)) : []),
    [pools],
  );
  const [menu, setMenu] = useState<{
    key: string;
    title: string;
    x: number;
    y: number;
    items: MediaMenuItem[];
  } | null>(null);
  if (albums.length === 0) return null;
  const openMenu = (album: MediaNode, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      key: `${album.serverUdn}|${album.id}`,
      title: album.title,
      x: e.clientX,
      y: e.clientY,
      items: albumMenuItems(fromNode(album, album.serverUdn, album.serverName), {
        playNow: () => void playAlbumNode(album),
        openInLibrary: () => openAlbumNode(album),
      }),
    });
  };
  return (
    <section data-recently-added={albums.length}>
      {menu && (
        <RowMenu
          title={menu.title}
          at={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={menu.items}
        />
      )}
      <div className="flex items-center gap-2 mb-0.5 px-1">
        <div className="microlabel">Recently added</div>
        <span className="text-[11px] text-faint tabular-nums">{fmtCount(albums.length)}</span>
        <Chip data-recently-added-all onClick={seeAll} className="ml-auto">
          See all
        </Chip>
      </div>
      <div
        ref={attach}
        className="grid"
        style={{ gap, gridTemplateColumns: `repeat(auto-fill, ${cardSize}px)`, paddingTop: 8 }}
      >
        {albums.slice(0, columns).map((a) => {
          const key = `${a.serverUdn}|${a.id}`;
          return (
            <ContainerCard
              key={key}
              node={a}
              playing={false}
              menuOpen={menu?.key === key}
              note={a.addedAt ? fmtAdded(a.addedAt) : undefined}
              onEnter={() => openAlbumNode(a)}
              onPlay={() => void playAlbumNode(a)}
              onMenu={(e) => openMenu(a, e)}
            />
          );
        })}
      </div>
    </section>
  );
}
