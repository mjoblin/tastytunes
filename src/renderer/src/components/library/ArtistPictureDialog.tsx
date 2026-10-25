import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import type { ArtistChoice } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { ModalShell } from "@/components/chrome/Overlay";
import { ConfirmActions } from "@/components/chrome/Confirm";
import { Segmented } from "@/components/controls/Segmented";
import { ArtImage } from "@/components/media/ArtImage";
import { artSrc } from "@/lib/artSrc";
import { PICKED_ART } from "@shared/artUrl";
import { refreshArtistPicture } from "@/lib/artistPictures";
import { cx } from "@/lib/format";

/**
 * CHOOSING AN ARTIST'S PICTURE (0.13.0 round 7; Malcolm, 2026-10-24: Wikipedia's lead image is
 * often a poor stage photo). The artist page's picture menu opens this: the images in the
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
 */
export interface CoverOffer {
  url: string;
  album: string;
  serverUdn: string | null;
}

type Tile = { key: string; url: string; label: string; choice: ArtistChoice };
type Source = "wiki" | "fanart" | "covers" | "file";

const TILE_PX = 88;
/** Three rows of tiles and their gaps, with the ring's room: the grid's fixed height. */
const GRID_H = 3 * TILE_PX + 2 * 8 + 8;

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
  onChosen,
}: {
  name: string;
  open: boolean;
  onClose(): void;
  /** The covers of the artist's albums on the page, each once. */
  covers: readonly CoverOffer[];
  /** The picture chosen now, so its tile starts selected. */
  current: { kind: ArtistChoice["kind"]; url: string } | null;
  /** Told once a choice is kept, so the page reads it again. */
  onChosen(): void;
}): React.JSX.Element {
  const lookups = useStore((s) => s.settings.artistInfo);
  const jumpToSettingsTab = useStore((s) => s.jumpToSettingsTab);
  /** The tab clicked, if one was: the dialog no longer moves to another on its own. */
  const [clicked, setClicked] = useState<Source | null>(null);
  const [images, setImages] = useState<{ of: string; urls: string[] } | null>(null);
  // fanart.tv's photos (0.13.0 round 11), asked only with a key saved: none saved, its tab says how
  const [fanart, setFanart] = useState<{ of: string; urls: string[]; keyed: boolean } | null>(null);
  const [file, setFile] = useState<{ file: string; url: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Why the last step did not happen, in the notice form. */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    // a file chosen before is offered again, so it can stay chosen
    setFile(
      current?.kind === "file"
        ? { file: current.url.slice(PICKED_ART.length), url: current.url }
        : null,
    );
    setSaving(false);
    setNotice(null);
    setSelected(current?.url ?? null);
    setClicked(null);
    if (!lookups) return;
    let live = true;
    void tt
      .artistImages(name)
      .then((urls) => {
        if (live) setImages({ of: name, urls });
      })
      .catch(() => {
        if (live) setImages({ of: name, urls: [] });
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
  }, [open, name, lookups, current]);
  const fan = fanart?.of === name ? fanart : null;
  const fanartTiles: Tile[] = (fan?.urls ?? []).map((url, i) => ({
    key: url,
    url,
    label: `fanart.tv photo ${i + 1}`,
    choice: { kind: "image", url },
  }));
  const wiki = images?.of === name ? images.urls : null;
  const wikiTiles: Tile[] = (wiki ?? []).map((url, i) => ({
    key: url,
    url,
    label: `Wikipedia image ${i + 1}`,
    choice: { kind: "image", url },
  }));
  const coverTiles: Tile[] = covers.map((c) => ({
    key: c.url,
    url: c.url,
    label: `Cover of ${c.album}`,
    choice: { kind: "cover", url: c.url, album: c.album, serverUdn: c.serverUdn },
  }));
  const fileTiles: Tile[] = file
    ? [
        {
          key: file.url,
          url: file.url,
          label: "Chosen file",
          choice: { kind: "file", file: file.file },
        },
      ]
    : [];
  const all = [...wikiTiles, ...fanartTiles, ...coverTiles, ...fileTiles];
  // until a tab is clicked: a fanart.tv photo chosen now is shown on its tab once fanart.tv
  // answers, and an opening tab that answers empty gives way to the first with pictures
  const opening = tabOf(current, lookups, coverTiles.length);
  const tab: Source =
    clicked ??
    (current?.kind === "image" && fan?.urls.includes(current.url)
      ? "fanart"
      : current || opening !== "wiki" || wiki == null || wiki.length > 0 || (lookups && !fan)
        ? opening
        : fanartTiles.length > 0
          ? "fanart"
          : coverTiles.length > 0
            ? "covers"
            : opening);
  const pick = all.find((t) => t.key === selected) ?? null;
  const use = (): void => {
    if (!pick) return;
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
        onChosen();
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
      onClose={onClose}
      escapeCloses
      label={`Picture for ${name}`}
      className="w-[34rem] max-w-[calc(100vw-3rem)] p-4"
    >
      <div data-artist-picture-dialog>
        <div className="text-[13px] font-medium text-ink">Picture for {name}</div>
        <div data-artist-picture-tabs className="mt-3">
          <Segmented<Source>
            modal
            className="w-fit"
            value={tab}
            onChange={setClicked}
            options={[
              { value: "wiki", label: "Wikipedia", count: lookups ? (wiki?.length ?? null) : null },
              {
                value: "fanart",
                label: "fanart.tv",
                count: lookups && fan?.keyed ? fan.urls.length : null,
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
          className="mt-3 -mx-1 max-h-[45vh] overflow-y-auto p-1"
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
              <Tiles tiles={wikiTiles} selected={selected} onSelect={setSelected} kind="image" />
            ))}
          {tab === "fanart" &&
            (!lookups ? (
              <LinerNotesOff onOpen={() => openConnections()} source="fanart.tv" />
            ) : fan == null ? (
              <Waiting />
            ) : !fan.keyed ? (
              <div className="space-y-3" data-artist-picture-no-key>
                <Note>
                  fanart.tv has large artist photos, made by its community. Add your fanart.tv key
                  in Settings › Connections to choose from them.
                </Note>
                <SmallButton onClick={() => openConnections()}>Open Settings</SmallButton>
              </div>
            ) : fanartTiles.length === 0 ? (
              <Note>No photos of “{name}” on fanart.tv.</Note>
            ) : (
              <Tiles tiles={fanartTiles} selected={selected} onSelect={setSelected} kind="image" />
            ))}
          {tab === "covers" &&
            (coverTiles.length === 0 ? (
              <Note>No album covers of “{name}” in the library.</Note>
            ) : (
              <Tiles tiles={coverTiles} selected={selected} onSelect={setSelected} kind="cover" />
            ))}
          {tab === "file" && (
            <div className="space-y-3">
              <Note>
                A picture from this computer. It’s copied into TastyTunes, so the original can be
                moved or deleted.
              </Note>
              {fileTiles.length > 0 && (
                <Tiles tiles={fileTiles} selected={selected} onSelect={setSelected} kind="file" />
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
            ) : (
              <p data-artist-picture-chosen className="min-w-0 truncate text-[12px] text-faint">
                {pick ? pick.label : "Nothing chosen yet"}
              </p>
            )
          }
        />
      </div>
    </ModalShell>
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
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, ${TILE_PX}px)` }}>
      {children}
    </div>
  );
}

/** The pictures to choose from, each a toggle: one chosen at a time across the tabs. No
 *  hover transitions inside the modal (ModalShell's note: they crawl over its blur). */
function Tiles({
  tiles,
  selected,
  onSelect,
  kind,
}: {
  tiles: Tile[];
  selected: string | null;
  onSelect(key: string): void;
  kind: ArtistChoice["kind"];
}): React.JSX.Element {
  return (
    <Grid>
      {tiles.map((t) => {
        const on = t.key === selected;
        return (
          <button
            key={t.key}
            aria-label={t.label}
            aria-pressed={on}
            data-artist-picture-tile={kind}
            data-selected={on || undefined}
            title={t.label}
            onClick={() => onSelect(t.key)}
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
              fallback={<UserRound size={24} strokeWidth={1} className="text-faint" />}
            />
          </button>
        );
      })}
    </Grid>
  );
}
