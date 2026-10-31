import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, UserRound } from "lucide-react";
import type { ArtistChoice, MediaIndexPools, PictureOffer } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { ModalShell } from "@/components/chrome/Overlay";
import { ConfirmActions } from "@/components/chrome/Confirm";
import { CloseButton } from "@/components/controls/CloseButton";
import { Segmented } from "@/components/controls/Segmented";
import { ArtImage } from "@/components/media/ArtImage";
import { artSrc } from "@/lib/artSrc";
import { PICKED_ART } from "@shared/artUrl";
import {
  coverOffers,
  refreshArtistPicture,
  useArtistChoice,
  type CoverOffer,
} from "@/lib/artistPictures";
import { cx, fmtCount } from "@/lib/format";
import { FACT_SEP } from "@/lib/mediaFacts";
import { useIndexPools } from "@/hooks/useIndexPools";
import { useLensIndex } from "@/components/library/lenses/useLensIndex";
import { lc } from "@/components/library/lenses/lensShared";

/**
 * CHOOSING AN ARTIST'S PICTURE (0.13.0 round 7; a user's report, 2026-10-24: Wikipedia's lead image is
 * often a poor stage photo). An artist's menu opens this, anywhere (ArtistPictureHost): the images in the
 * artist's Wikipedia article (with Liner notes on), the covers of their albums in the library,
 * and a picture file, copied into the app's data so the original can move. One is chosen and
 * "Use this picture" keeps it until another is chosen or the menu's reset clears it
 * (decisions/0013: the person asks). Main checks the choice is one it offered
 * (ipc/lookups setArtistChoice).
 *
 * ONE TAB PER SOURCE (his look, 2026-10-25: "the layout is awkward. the modal moves as things pop
 * in"): Wikipedia, fanart.tv, Album covers and File, each with how many it holds, over a grid of a
 * fixed size that alone scrolls, so nothing moves as the sources answer. It opens on the tab
 * holding the picture chosen now, else Wikipedia's, moving once to the first tab with pictures
 * if that one answers empty before a tab is clicked. A source that cannot answer says why in its
 * tab (Liner notes off, no fanart.tv key) with the way to Settings › Connections.
 *
 * MORE TO CHOOSE FROM, AND A LOOK FIRST (0.14.0, his call on a user's email, Plex's picture
 * editor): a Commons tab, the photos in the artist's Wikimedia Commons category the article
 * doesn't show; and every picture opens large before it is used (double-click it, or its corner
 * button), with its full size and file page where its source says (Wikipedia, Commons), the
 * tab's others a step away (the arrow keys or the chevrons) and "Use this picture" there too.
 * The size is the large view's alone (his look, 2026-10-30: "let's not show the resolution for
 * these images"; it was under each tile).
 */
type Tile = {
  key: string;
  /** What the tile shows (a smaller copy where the source has one). */
  url: string;
  /** What the large view shows and the choice keeps. */
  full: string;
  label: string;
  /** Where it comes from, as the chosen line says it. */
  from: string;
  choice: ArtistChoice;
  width: number | null;
  height: number | null;
  page: string | null;
};
type Source = "wiki" | "commons" | "fanart" | "covers" | "file";

/** Four tiles to a row in the dialog's width, with room for the scrollbar (his look, 2026-10-30:
 *  "this feels a bit cramped", then "larger still, with a slightly larger gap"; they were 88
 *  with an 8 gap, five to a row). */
const TILE_PX = 140;
const GAP_PX = 16;
/** Three rows of tiles and their gaps, with the ring's room: the grid's fixed height, the same
 *  on every tab so nothing moves. */
const GRID_H = 3 * TILE_PX + 2 * GAP_PX + 8;
/** A full size as the large view says it. */
const sizeText = (t: Pick<Tile, "width" | "height">): string | null =>
  t.width && t.height ? `${fmtCount(t.width)} × ${fmtCount(t.height)}` : null;
/** A tile for an offer from Wikipedia or Commons. */
const offerTile = (o: PictureOffer, label: string, from: string): Tile => ({
  key: o.url,
  url: o.thumb ?? o.url,
  full: o.url,
  label,
  from,
  choice: { kind: "image", url: o.url },
  width: o.width,
  height: o.height,
  page: o.page,
});

/** The tab a choice lives on, as far as can be told before the sources answer. */
const tabOf = (
  current: { kind: ArtistChoice["kind"] } | null,
  lookups: boolean,
  covers: number,
): Source =>
  current?.kind === "cover"
    ? "covers"
    : current?.kind === "file"
      ? "file"
      : lookups || current
        ? "wiki"
        : covers > 0
          ? "covers"
          : "file";

export function ArtistPictureDialog({
  name,
  open,
  onClose,
  covers,
  current,
}: {
  name: string;
  open: boolean;
  onClose(): void;
  /** The covers of the artist's albums, each once. */
  covers: readonly CoverOffer[];
  /** The picture chosen now: the address it was offered at, so its tile starts selected, and
   *  the one it draws from (its kept copy, 0.14.0). */
  current: { kind: ArtistChoice["kind"]; url: string; drawn: string } | null;
}): React.JSX.Element {
  const lookups = useStore((s) => s.settings.artistInfo);
  const jumpToSettingsTab = useStore((s) => s.jumpToSettingsTab);
  /** The tab clicked, if one was: the dialog no longer moves to another on its own. */
  const [clicked, setClicked] = useState<Source | null>(null);
  const [images, setImages] = useState<{ of: string; offers: PictureOffer[] } | null>(null);
  // Commons' photos (0.14.0), the ones the article doesn't show
  const [commons, setCommons] = useState<{ of: string; offers: PictureOffer[] } | null>(null);
  /** The picture open large, if one is. */
  const [viewing, setViewing] = useState<Tile | null>(null);
  // fanart.tv's photos (0.13.0 round 11), asked only with a key saved: none saved, its tab says how
  const [fanart, setFanart] = useState<{ of: string; urls: string[]; keyed: boolean } | null>(null);
  const [file, setFile] = useState<{ file: string; url: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Why the last step did not happen, in the notice form. */
  const [notice, setNotice] = useState<string | null>(null);
  // the choice by value: the window's map is read again with new objects (an index built)
  const currentKind = current?.kind ?? null;
  const currentUrl = current?.url ?? null;
  useEffect(() => {
    if (!open) return;
    // a file chosen before is offered again, so it can stay chosen
    setFile(
      currentKind === "file" && currentUrl
        ? { file: currentUrl.slice(PICKED_ART.length), url: currentUrl }
        : null,
    );
    setSaving(false);
    setNotice(null);
    setSelected(currentUrl);
    setClicked(null);
    setViewing(null);
    if (!lookups) return;
    let live = true;
    void tt
      .artistImages(name)
      .then((offers) => {
        if (live) setImages({ of: name, offers });
      })
      .catch(() => {
        if (live) setImages({ of: name, offers: [] });
      });
    void tt
      .artistCommons(name)
      .then((offers) => {
        if (live) setCommons({ of: name, offers });
      })
      .catch(() => {
        if (live) setCommons({ of: name, offers: [] });
      });
    void tt
      .secretsStatus()
      .then(async (s) => {
        const urls = s.fanartKey.saved ? await tt.artistFanart(name) : [];
        if (live) setFanart({ of: name, urls, keyed: s.fanartKey.saved });
      })
      .catch(() => {
        if (live) setFanart({ of: name, urls: [], keyed: false });
      });
    return () => {
      live = false;
    };
  }, [open, name, lookups, currentKind, currentUrl]);
  const fan = fanart?.of === name ? fanart : null;
  const unsized = { width: null, height: null, page: null };
  const fanartTiles: Tile[] = (fan?.urls ?? []).map((url, i) => ({
    key: url,
    url,
    full: url,
    label: `fanart.tv photo ${i + 1}`,
    from: "fanart.tv",
    choice: { kind: "image", url },
    ...unsized,
  }));
  const wiki = images?.of === name ? images.offers : null;
  const wikiTiles: Tile[] = (wiki ?? []).map((o, i) =>
    offerTile(o, `Wikipedia image ${i + 1}`, "Wikipedia"),
  );
  const fromCommons = commons?.of === name ? commons.offers : null;
  const commonsTiles: Tile[] = (fromCommons ?? []).map((o, i) =>
    offerTile(o, `Commons photo ${i + 1}`, "Wikimedia Commons"),
  );
  const coverTiles: Tile[] = covers.map((c) => ({
    key: c.url,
    url: c.url,
    full: c.url,
    label: `Cover of ${c.album}`,
    from: `Cover of ${c.album}`,
    choice: { kind: "cover", url: c.url, album: c.album, serverUdn: c.serverUdn },
    ...unsized,
  }));
  const fileTiles: Tile[] = file
    ? [
        {
          key: file.url,
          url: file.url,
          full: file.url,
          label: "Chosen file",
          from: "File from this computer",
          choice: { kind: "file", file: file.file },
          ...unsized,
        },
      ]
    : [];
  const all = [...wikiTiles, ...commonsTiles, ...fanartTiles, ...coverTiles, ...fileTiles];
  // until a tab is clicked: a fanart.tv photo chosen now is shown on its tab once fanart.tv
  // answers, and an opening tab that answers empty gives way to the first with pictures
  const opening = tabOf(current, lookups, coverTiles.length);
  const tab: Source =
    clicked ??
    (current?.kind === "image" && fan?.urls.includes(current.url)
      ? "fanart"
      : current?.kind === "image" && fromCommons?.some((o) => o.url === current.url)
        ? "commons"
        : current || opening !== "wiki" || wiki == null || wiki.length > 0 || (lookups && !fan)
          ? opening
          : commonsTiles.length > 0
            ? "commons"
            : fanartTiles.length > 0
              ? "fanart"
              : coverTiles.length > 0
                ? "covers"
                : opening);
  const pick = all.find((t) => t.key === selected) ?? null;
  // the large view steps through the tab it was opened from
  const shown =
    tab === "wiki"
      ? wikiTiles
      : tab === "commons"
        ? commonsTiles
        : tab === "fanart"
          ? fanartTiles
          : tab === "covers"
            ? coverTiles
            : fileTiles;
  const use = (): void => {
    if (pick) commit(pick);
  };
  const commit = (pick: Tile): void => {
    setSaving(true);
    setNotice(null);
    const failed = (): void => {
      setSaving(false);
      setNotice("Couldn’t use that picture.");
    };
    void tt
      .setArtistChoice(name, pick.choice)
      .then((kept) => {
        if (!kept) return failed();
        refreshArtistPicture(name);
        onClose();
      })
      .catch(failed);
  };
  const chooseFile = (): void => {
    void tt
      .pickArtistPictureFile()
      .then((got) => {
        if (got === "unreadable") return setNotice("Couldn’t read that file.");
        if (!got) return;
        setNotice(null);
        setFile(got);
        setSelected(got.url);
      })
      .catch(() => {});
  };
  const openConnections = (): void => {
    onClose();
    jumpToSettingsTab("connections");
  };
  return (
    <ModalShell
      open={open}
      // Escape and a click outside close the large view first, then the dialog
      onClose={() => (viewing ? setViewing(null) : onClose())}
      escapeCloses
      label={`Picture for ${name}`}
      className="w-[42rem] max-w-[calc(100vw-3rem)] p-5"
    >
      <div data-artist-picture-dialog className="relative">
        {/* the app's close X at the top right, beside Cancel (his ask, 2026-10-30); its margin
            keeps the heading's line height, so nothing below moves */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-[13px] font-medium text-ink">Picture for {name}</div>
          <CloseButton onClick={onClose} className="-my-1.5" />
        </div>
        <div data-artist-picture-tabs className="mt-3">
          <Segmented<Source>
            modal
            className="w-fit"
            value={tab}
            onChange={setClicked}
            options={[
              // a count still being asked keeps its room (null); a source that can't answer has
              // none (Liner notes off, no fanart.tv key, said before the dialog has faded in)
              {
                value: "wiki",
                label: "Wikipedia",
                count: lookups ? (wiki?.length ?? null) : undefined,
              },
              {
                value: "commons",
                label: "Commons",
                count: lookups ? (fromCommons?.length ?? null) : undefined,
              },
              {
                value: "fanart",
                label: "fanart.tv",
                count: !lookups
                  ? undefined
                  : fan == null
                    ? null
                    : fan.keyed
                      ? fan.urls.length
                      : undefined,
              },
              { value: "covers", label: "Album covers", count: coverTiles.length },
              { value: "file", label: "File" },
            ]}
          />
        </div>
        {/* a fixed height that alone scrolls; p-1 inside, -m-1 outside: room for a chosen
            tile's ring, which the scroller would otherwise cut at its edge (his look, 2026-10-25) */}
        <div
          data-artist-picture-tab={tab}
          className="mt-3 -mx-1 max-h-[calc(100vh-13rem)] overflow-y-auto p-1"
          style={{ height: GRID_H }}
        >
          {tab === "wiki" &&
            (!lookups ? (
              <LinerNotesOff onOpen={() => openConnections()} source="Wikipedia" />
            ) : wiki == null ? (
              <Waiting />
            ) : wikiTiles.length === 0 ? (
              <Note>Couldn’t find “{name}” on Wikipedia.</Note>
            ) : (
              <Tiles
                tiles={wikiTiles}
                selected={selected}
                onSelect={setSelected}
                onOpen={setViewing}
                kind="image"
              />
            ))}
          {tab === "commons" &&
            (!lookups ? (
              <LinerNotesOff onOpen={() => openConnections()} source="Wikimedia Commons" />
            ) : fromCommons == null ? (
              <Waiting />
            ) : commonsTiles.length === 0 ? (
              <Note>
                {wikiTiles.length > 0
                  ? `No other photos of “${name}” on Wikimedia Commons.`
                  : `Couldn’t find “${name}” on Wikimedia Commons.`}
              </Note>
            ) : (
              <Tiles
                tiles={commonsTiles}
                selected={selected}
                onSelect={setSelected}
                onOpen={setViewing}
                kind="image"
              />
            ))}
          {tab === "fanart" &&
            (!lookups ? (
              <LinerNotesOff onOpen={() => openConnections()} source="fanart.tv" />
            ) : fan == null ? (
              <Waiting />
            ) : !fan.keyed ? (
              <div className="space-y-3" data-artist-picture-no-key>
                <Note>
                  <button
                    type="button"
                    data-artist-picture-fanart-link
                    onClick={() => void tt.openExternal("https://fanart.tv/")}
                    className="text-dim underline decoration-gold/50 underline-offset-2 hover:text-ink"
                  >
                    fanart.tv
                  </button>{" "}
                  has artist photos made by the community. Add your fanart.tv key in Settings ›
                  Connections.
                </Note>
                <SmallButton onClick={() => openConnections()}>Open Settings</SmallButton>
              </div>
            ) : fanartTiles.length === 0 ? (
              <Note>No photos of “{name}” on fanart.tv.</Note>
            ) : (
              <Tiles
                tiles={fanartTiles}
                selected={selected}
                onSelect={setSelected}
                onOpen={setViewing}
                kind="image"
              />
            ))}
          {tab === "covers" &&
            (coverTiles.length === 0 ? (
              <Note>No album covers of “{name}” in the library.</Note>
            ) : (
              <Tiles
                tiles={coverTiles}
                selected={selected}
                onSelect={setSelected}
                onOpen={setViewing}
                kind="cover"
              />
            ))}
          {tab === "file" && (
            <div className="space-y-3">
              <Note>
                A picture from this computer. It’s copied into TastyTunes, so the original can be
                moved or deleted.
              </Note>
              {fileTiles.length > 0 && (
                <Tiles
                  tiles={fileTiles}
                  selected={selected}
                  onSelect={setSelected}
                  onOpen={setViewing}
                  kind="file"
                />
              )}
              <SmallButton data-artist-picture-file onClick={chooseFile}>
                {fileTiles.length > 0 ? "Choose another file…" : "Choose a file…"}
              </SmallButton>
            </div>
          )}
        </div>
        <ConfirmActions
          modal
          tone="gold"
          verb="Use this picture"
          busy={!pick || saving}
          onCancel={onClose}
          onConfirm={use}
          start={
            // what is chosen, whichever tab it is on, or why the last step did not happen: one
            // line, so the dialog keeps its size
            notice ? (
              <p
                data-artist-picture-notice
                className="min-w-0 truncate text-[12px] leading-snug text-alert"
              >
                {notice}
              </p>
            ) : selected ? (
              <Chosen
                url={
                  pick?.url ?? (selected === currentUrl ? (current?.drawn ?? selected) : selected)
                }
                current={selected === currentUrl}
                // the picture chosen now, before its source answers, or after its source stopped
                // offering it: still the current one, its source unsaid
                from={pick?.from ?? null}
              />
            ) : (
              <p data-artist-picture-chosen className="min-w-0 truncate text-[12px] text-faint">
                Nothing chosen yet
              </p>
            )
          }
        />
        {viewing && (
          <LargeView
            tile={viewing}
            tiles={shown}
            saving={saving}
            onStep={setViewing}
            onBack={() => setViewing(null)}
            onClose={onClose}
            onUse={(t) => {
              setSelected(t.key);
              commit(t);
            }}
          />
        )}
      </div>
    </ModalShell>
  );
}

/** The chosen line: which picture "Use this picture" means, the one in use now or a new one,
 *  and where it comes from, with a small copy of it (his look, 2026-10-30: the tile's own label,
 *  "Commons photo 2", didn't say it was the current picture). */
function Chosen({
  url,
  current,
  from,
}: {
  url: string;
  current: boolean;
  from: string | null;
}): React.JSX.Element {
  return (
    <div data-artist-picture-chosen className="flex min-w-0 items-center gap-2 text-[12px]">
      <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded bg-veil ring-1 ring-edge">
        <ArtImage
          src={artSrc(url, 24)}
          className="h-full w-full object-cover"
          portraitTop
          fallback={<UserRound size={14} strokeWidth={1} className="text-faint" />}
        />
      </span>
      <span className="min-w-0 truncate text-faint">
        <span className="text-dim">{current ? "Current picture" : "New picture"}</span>
        {from && `${FACT_SEP}${from}`}
      </span>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="max-w-[26rem] pt-1 text-[12px] leading-snug text-faint">{children}</p>;
}

/** A secondary button in the dialog, untransitioned (ModalShell's note). */
function SmallButton({
  children,
  ...rest
}: {
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      className="px-2.5 py-1 rounded-lg text-[12px] ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70"
    >
      {children}
    </button>
  );
}

function LinerNotesOff({ source, onOpen }: { source: string; onOpen(): void }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <Note>Turn on Liner notes in Settings › Connections to choose from {source}.</Note>
      <SmallButton onClick={onOpen}>Open Settings</SmallButton>
    </div>
  );
}

/** Three tiles' shimmer while a source is asked. */
function Waiting(): React.JSX.Element {
  return (
    <Grid>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          data-artist-picture-waiting
          className="relative block overflow-hidden rounded-lg bg-veil ring-1 ring-edge"
          style={{ width: TILE_PX, height: TILE_PX }}
        >
          <span className="art-shimmer" aria-hidden />
        </span>
      ))}
    </Grid>
  );
}

function Grid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="grid"
      style={{ gap: GAP_PX, gridTemplateColumns: `repeat(auto-fill, ${TILE_PX}px)` }}
    >
      {children}
    </div>
  );
}

/** The pictures to choose from, each a toggle: one chosen at a time across the tabs, each with
 *  a corner button (or a double-click) that opens it large. No hover transitions inside the modal (ModalShell's note: they crawl over its
 *  blur). */
function Tiles({
  tiles,
  selected,
  onSelect,
  onOpen,
  kind,
}: {
  tiles: Tile[];
  selected: string | null;
  onSelect(key: string): void;
  onOpen(t: Tile): void;
  kind: ArtistChoice["kind"];
}): React.JSX.Element {
  return (
    <Grid>
      {tiles.map((t) => {
        const on = t.key === selected;
        return (
          <div key={t.key} className="group relative" style={{ width: TILE_PX }}>
            <button
              aria-label={t.label}
              aria-pressed={on}
              data-artist-picture-tile={kind}
              data-selected={on || undefined}
              // a cover's tooltip names its album; the others' would only repeat the tab and a
              // place in it (his look, 2026-10-30), so only VoiceOver hears them
              title={kind === "cover" ? t.label : undefined}
              onClick={() => onSelect(t.key)}
              onDoubleClick={() => onOpen(t)}
              className={cx(
                "relative block overflow-hidden rounded-lg bg-veil focus-kbd:outline-none",
                on
                  ? "ring-2 ring-gold"
                  : "ring-1 ring-edge hover:ring-edge2 focus-kbd:ring-2 focus-kbd:ring-edge2",
              )}
              style={{ width: TILE_PX, height: TILE_PX }}
            >
              <ArtImage
                src={artSrc(t.url, TILE_PX)}
                className="h-full w-full object-cover"
                portraitTop
                fallback={<UserRound size={32} strokeWidth={1} className="text-faint" />}
              />
            </button>
            <button
              type="button"
              aria-label={`View ${t.label} larger`}
              title="View larger"
              data-artist-picture-larger
              onClick={() => onOpen(t)}
              className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-panel/85 text-dim ring-1 ring-edge opacity-0 hover:text-ink group-hover:opacity-100 group-kbd:opacity-100 focus-kbd:opacity-100"
            >
              <Maximize2 size={12} />
            </button>
          </div>
        );
      })}
    </Grid>
  );
}

/** A picture open large over the dialog, before it is used: its size and file page where its
 *  source says, the tab's others a step away, and "Use this picture". */
function LargeView({
  tile,
  tiles,
  saving,
  onStep,
  onBack,
  onClose,
  onUse,
}: {
  tile: Tile;
  tiles: Tile[];
  saving: boolean;
  onStep(t: Tile): void;
  onBack(): void;
  /** The dialog's own close: the X stays where it was, and closes the dialog from here too. */
  onClose(): void;
  onUse(t: Tile): void;
}): React.JSX.Element {
  const at = tiles.findIndex((t) => t.key === tile.key);
  const prev = at > 0 ? tiles[at - 1] : null;
  const next = at >= 0 && at < tiles.length - 1 ? tiles[at + 1] : null;
  const ref = useRef<HTMLDivElement>(null);
  // the view holds focus, so its arrow keys step and Escape reaches the dialog's close
  useEffect(() => ref.current?.focus(), []);
  const size = sizeText(tile);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-artist-picture-large={tile.key}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        const to = e.key === "ArrowLeft" ? prev : next;
        if (to) onStep(to);
      }}
      // -inset-2 with its padding: over the grid's ring room too, which reaches past the dialog's edge
      className="absolute -inset-2 z-10 flex flex-col gap-3 rounded-xl bg-panel p-2 outline-none"
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{tile.label}</div>
        {tiles.length > 1 && (
          <span className="text-[11px] text-faint tabular-nums">
            {at + 1} of {tiles.length}
          </span>
        )}
        <CloseButton onClick={onClose} className="-my-1.5" />
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <ArtImage
          src={artSrc(tile.full, 1200)}
          className="max-h-full max-w-full rounded-lg object-contain"
          fallback={<UserRound size={48} strokeWidth={1} className="text-faint" />}
        />
        {prev && <StepButton label="Previous picture" side="left" onClick={() => onStep(prev)} />}
        {next && <StepButton label="Next picture" side="right" onClick={() => onStep(next)} />}
      </div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 truncate text-[12px] text-faint tabular-nums">
          {size}
          {size && tile.page && " · "}
          {tile.page && (
            <button
              type="button"
              data-artist-picture-page
              onClick={() => void tt.openExternal(tile.page ?? "")}
              className="text-dim underline decoration-gold/50 underline-offset-2 hover:text-ink"
            >
              {/commons\.wikimedia\.org/.test(tile.page)
                ? "Open on Wikimedia Commons"
                : "Open on Wikipedia"}
            </button>
          )}
        </div>
        <SmallButton data-artist-picture-back onClick={onBack}>
          Back
        </SmallButton>
        <button
          type="button"
          data-artist-picture-use
          disabled={saving}
          onClick={() => onUse(tile)}
          className="px-2.5 py-1 rounded-lg text-[12px] bg-gold text-bg font-medium hover:brightness-110 disabled:opacity-50"
        >
          Use this picture
        </button>
      </div>
    </div>
  );
}

function StepButton({
  label,
  side,
  onClick,
}: {
  label: string;
  side: "left" | "right";
  onClick(): void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx(
        "absolute top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-panel/85 text-dim ring-1 ring-edge hover:text-ink",
        side === "left" ? "left-1" : "right-1",
      )}
    >
      {side === "left" ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
    </button>
  );
}

const NO_POOLS: MediaIndexPools[] = [];

/**
 * THE ONE CHOOSER (0.13.0 rc.3, his pick: "Choose a picture" in the artist's menu everywhere):
 * every artist menu opens it through the store (mediaMenus artistPictureItems), so the cards, the
 * rows, Search and the artist page share one dialog, mounted once in App. The covers are the
 * caller's when it has its own (the artist page's albums), else the artist's albums in the
 * indexes, as the Artists view has them.
 */
export function ArtistPictureHost(): React.JSX.Element {
  const chooser = useStore((s) => s.pictureChooser);
  const setPictureChooser = useStore((s) => s.setPictureChooser);
  // closed, the name empties: ModalShell holds its last children through the exit fade
  const name = chooser?.name ?? "";
  const pools = useIndexPools(chooser != null && !chooser.covers);
  const index = useLensIndex(pools ?? NO_POOLS);
  const own = chooser?.covers;
  const covers = useMemo(
    () => own ?? coverOffers(index.artists.find((a) => a.key === lc(name))?.albums ?? []),
    [own, index, name],
  );
  const chosen = useArtistChoice(name) ?? null;
  return (
    <ArtistPictureDialog
      name={name}
      open={chooser != null}
      onClose={() => setPictureChooser(null)}
      covers={covers}
      current={chosen && { kind: chosen.kind, url: chosen.offered, drawn: chosen.url }}
    />
  );
}
