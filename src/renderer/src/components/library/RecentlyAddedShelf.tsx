import { useMemo, useRef, useState } from "react";
import type { MediaNode } from "@shared/model";
import { recentlyAdded } from "@shared/recentlyAdded";
import { useStore } from "@/store";
import { Chip } from "@/components/chrome/Chrome";
import { ContainerCard } from "@/components/library/LibraryCards";
import { RowMenu } from "@/components/media/RowMenu";
import { useColumns } from "@/hooks/useColumns";
import { useIndexPools } from "@/hooks/useIndexPools";
import { lensIndexOf } from "@/components/library/lenses/useLensIndex";
import { useCardDetails } from "@/components/library/useCardDetails";
import { fmtAdded, fmtCount } from "@/lib/format";
import { albumMenuItems, type MediaMenuItem } from "@/lib/mediaMenus";
import { openAlbumNode, playAlbumNode } from "@/lib/mediaActions";
import { fromNode } from "@/lib/mediaRef";
import { menuAt } from "@/lib/menuAt";
import { gridColumnsOf, ListKeysContext, useListKeys } from "@/hooks/useListKeys";
import { keyedEvent } from "@/lib/menuAt";

/** The shelf's cards against the reader's card size (0.8 and then 0.9 read a little small on a
 *  real library): the card size itself, each card its own width rather than stretched. */
const SHELF_SCALE = 1;

/**
 * RECENTLY ADDED ON THE LIBRARY'S FRONT PAGE (0.13.0 round 9: a shelf under the doors). One row
 * of the albums known to be recent, in shared/recentlyAdded's
 * order (the dated newest first, then a server's own list), as History's Rediscover shelves show
 * theirs: the Library's own album cards, at a step under the reader's card size and not stretched,
 * each saying when it arrived where the app knows it, on the card's note line under its names (a
 * surface's fact goes after the card's own). See all opens the Albums lens in the same order. Not
 * there when nothing is known.
 */
export function RecentlyAddedShelf({ seeAll }: { seeAll(): void }): React.JSX.Element | null {
  const pools = useIndexPools();
  // each card's format line, as the Albums lens's cards have it (useCardDetails)
  const detailsOf = useCardDetails(pools ? lensIndexOf(pools) : null);
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
  // FROM THE KEYBOARD (0.15.0): the shelf one Tab stop, the arrows across its
  // cards, Enter opens an album as its click does, "." its More menu (Play is there)
  const shown = albums.slice(0, columns);
  const gridEl = useRef<HTMLDivElement | null>(null);
  const keys = useListKeys({
    count: shown.length,
    columns: () => gridColumnsOf(gridEl.current),
    onEnter: (i) => {
      const a = shown[i];
      if (a) openAlbumNode(a);
    },
    onMenu: (i, el) => {
      const a = shown[i];
      if (a) openMenu(a, keyedEvent(el));
    },
  });
  if (albums.length === 0) return null;
  const openMenu = (album: MediaNode, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      key: `${album.serverUdn}|${album.id}`,
      title: album.title,
      ...menuAt(e),
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
        {...keys.container}
        ref={(node) => {
          gridEl.current = node;
          attach(node);
          keys.container.ref(node);
        }}
        aria-label="Recently added"
        className="grid"
        style={{ gap, gridTemplateColumns: `repeat(auto-fill, ${cardSize}px)`, paddingTop: 8 }}
      >
        <ListKeysContext.Provider value={true}>
          {shown.map((a, i) => {
            const key = `${a.serverUdn}|${a.id}`;
            return (
              <ContainerCard
                item={keys.item(i)}
                key={key}
                node={a}
                playing={false}
                menuOpen={menu?.key === key}
                details={detailsOf?.(a)}
                note={a.addedAt ? fmtAdded(a.addedAt) : undefined}
                onEnter={() => openAlbumNode(a)}
                onPlay={() => void playAlbumNode(a)}
                onMenu={(e) => openMenu(a, e)}
              />
            );
          })}
        </ListKeysContext.Provider>
      </div>
    </section>
  );
}
