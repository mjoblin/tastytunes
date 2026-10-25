import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import type { ArtistChoice } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { ModalShell } from "@/components/chrome/Overlay";
import { ConfirmActions } from "@/components/chrome/Confirm";
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
 */
export interface CoverOffer {
  url: string;
  album: string;
  serverUdn: string | null;
}

type Tile = { key: string; url: string; label: string; choice: ArtistChoice };

const TILE_PX = 88;

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
  const [images, setImages] = useState<{ of: string; urls: string[] } | null>(null);
  // fanart.tv's photos (0.13.0 round 11), asked only with a key saved: none saved, no section
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
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      escapeCloses
      label={`Picture for ${name}`}
      className="w-[34rem] max-w-[calc(100vw-3rem)] max-h-[80vh] p-4 flex flex-col"
    >
      <div data-artist-picture-dialog className="flex min-h-0 flex-col">
        <div className="text-[13px] font-medium text-ink">Picture for {name}</div>
        {/* p-1 inside, -m-1 outside: room for a chosen tile's ring, which the scroller would
            otherwise cut at its edge (his look, 2026-10-25) */}
        <div className="mt-2 -mx-1 -mb-1 min-h-0 flex-1 space-y-4 overflow-y-auto p-1">
          <Section title="From Wikipedia">
            {!lookups ? (
              <Note>Turn on Liner notes in Settings › Connections to choose from Wikipedia.</Note>
            ) : wiki == null ? (
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
            ) : wikiTiles.length === 0 ? (
              <Note>Couldn’t find “{name}” on Wikipedia.</Note>
            ) : (
              <Tiles tiles={wikiTiles} selected={selected} onSelect={setSelected} kind="image" />
            )}
          </Section>
          {lookups && fan?.keyed && (
            <Section title="From fanart.tv">
              {fanartTiles.length > 0 ? (
                <Tiles
                  tiles={fanartTiles}
                  selected={selected}
                  onSelect={setSelected}
                  kind="image"
                />
              ) : (
                <Note>No photos of “{name}” on fanart.tv.</Note>
              )}
            </Section>
          )}
          {coverTiles.length > 0 && (
            <Section title="Album covers">
              <Tiles tiles={coverTiles} selected={selected} onSelect={setSelected} kind="cover" />
            </Section>
          )}
          {fileTiles.length > 0 && (
            <Section title="From a file">
              <Tiles tiles={fileTiles} selected={selected} onSelect={setSelected} kind="file" />
            </Section>
          )}
        </div>
        {notice && (
          <p data-artist-picture-notice className="mt-3 text-[12px] leading-snug text-alert">
            {notice}
          </p>
        )}
        <ConfirmActions
          modal
          tone="gold"
          verb="Use this picture"
          busy={!pick || saving}
          onCancel={onClose}
          onConfirm={use}
          start={
            <button
              data-artist-picture-file
              onClick={chooseFile}
              className="px-2.5 py-1 rounded-lg text-[12px] ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70"
            >
              Choose a file…
            </button>
          }
        />
      </div>
    </ModalShell>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11.5px] font-medium text-dim">{title}</h3>
      {children}
    </section>
  );
}

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[12px] leading-snug text-faint">{children}</p>;
}

function Grid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, ${TILE_PX}px)` }}>
      {children}
    </div>
  );
}

/** The pictures to choose from, each a toggle: one chosen at a time across the sections. No
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
