import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, UserRound } from "lucide-react";
import type { MediaNode } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { ArtistAbout, ArtistLinks, useArtistAbout } from "@/components/media/ArtistAbout";
import { ArtImage } from "@/components/media/ArtImage";
import { ArtistPictureDialog, type CoverOffer } from "@/components/library/ArtistPictureDialog";
import { HeaderArt } from "@/components/library/HeaderArt";
import { RowMenu } from "@/components/media/RowMenu";
import { HEADER_ART_PX, useHeaderArtSize } from "@/hooks/useHeaderArtSize";
import { artSrc } from "@/lib/artSrc";
import { wikiThumbAt } from "@shared/artUrl";
import { refreshArtistPicture, useArtistPictureAnswer } from "@/lib/artistPictures";
import { cx, fmtCount } from "@/lib/format";
import { FACT_SEP } from "@/lib/mediaFacts";

/**
 * THE ARTIST PAGE'S HEADER (0.11.0, a user's email: "Would it be possible for TastyTunes to
 * scrape artist image and display it instead of the grey square with disc image?"), shaped like
 * the album header (user, 2026-10-11: "let's make it more consistent with our existing album
 * page"): the picture, and beside it a column at least the default picture's height: the
 * name with the links out at the right of its line (ArtistLinks, so they never move when the
 * summary opens; his idea, 2026-10-13), the facts line (the Artists lens's counts, from the
 * indexes), and two lines of the artist's Wikipedia summary with read more / read less under
 * them (ArtistAbout, History › Elsewhere's block); read more grows the column as a composer
 * line grows the album's. No label: the crumbs, the picture and the name say
 * whose page it is, as an album's do. No verbs: the Library does not play a whole artist.
 * The picture is main's answer for the artist (a real server picture, else the photo, else a
 * cover from their albums: a server picture that is an album's cover counts as a cover), else
 * this lookup's photo, else the server's picture, else a picture from the page's own folders.
 * Its size is dragged from the corner, one size with the album header's (HeaderArt, 0.11.0);
 * a Wikipedia photo is asked for again at the size drawn (wikiThumbAt).
 * ONE PICTURE, NOT A STAND-IN AND THEN ANOTHER (his ask, 2026-10-12: "i see album art first then
 * it gets replaced"): until main has answered and the photo lookup has (or LOOKUP_WAIT_MS has
 * passed), the well waits with its line; then the best picture there is: a real server
 * picture, the photo, the server's own, a cover. A picture that fails shows the next one,
 * the cover behind it while it is retried. Once a name's picture has settled, a later answer
 * (Refresh details, main asked again) changes it in place without waiting again.
 * A PICTURE CHOSEN FOR THE ARTIST (0.13.0 round 7) comes before all of them, and the page waits
 * only for main to say whether there is one: the picture's menu (its ⋯ on hover or keyboard
 * focus, or a right-click on it) offers Choose a picture (ArtistPictureDialog) and, once one is
 * chosen, the reset back to the usual picture.
 */
/** How long the page waits for a photo lookup before it shows what it has. */
const LOOKUP_WAIT_MS = 6000;

export function ArtistHeader({
  name,
  serverArt,
  folders,
}: {
  name: string;
  /** The server's own picture for the artist, as its folder or the index has it. */
  serverArt?: string | null;
  /** Nodes whose pictures stand in last (the page's folders, or the artist's albums). */
  folders: readonly MediaNode[];
}): React.JSX.Element {
  const lookups = useStore((s) => s.settings.artistInfo);
  const art = useHeaderArtSize("Resize Artist Picture");
  const answer = useArtistPictureAnswer(name);
  // main's last answer for this name, held while it is asked again (a photo found here sends
  // every row back to main), so the picture never steps back to a cover in between
  const held = useRef<{ name: string; value: string | null } | null>(null);
  if (answer !== undefined) held.current = { name, value: answer };
  const known =
    answer !== undefined ? answer : held.current?.name === name ? held.current.value : undefined;
  // the picture chosen for the artist, held per name while it is asked again after a change
  const [chosenOf, setChosenOf] = useState<{
    name: string;
    value: Awaited<ReturnType<typeof tt.artistChoice>>;
  } | null>(null);
  const [askChosen, setAskChosen] = useState(0);
  useEffect(() => {
    let live = true;
    void tt
      .artistChoice(name)
      .then((value) => {
        if (live) setChosenOf({ name, value });
      })
      .catch(() => {
        if (live) setChosenOf({ name, value: null });
      });
    return () => {
      live = false;
    };
  }, [name, askChosen, lookups]);
  const chosen = chosenOf?.name === name ? chosenOf.value : undefined;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const { status, info } = useArtistAbout(name, true);
  const photo = lookups ? (info?.image ?? null) : null;
  // a slow lookup (MusicBrainz takes one request a second) stops being waited for
  const [waitedOut, setWaitedOut] = useState<string | null>(null);
  const looking = lookups && status === "loading";
  useEffect(() => {
    if (!looking) return;
    const t = setTimeout(() => setWaitedOut(name), LOOKUP_WAIT_MS);
    return () => clearTimeout(t);
  }, [looking, name]);
  const settled = useRef<string | null>(null);
  const pending =
    settled.current !== name &&
    (chosen === undefined ||
      (chosen == null && ((known === undefined && !photo) || (looking && waitedOut !== name))));
  if (!pending) settled.current = name;
  const [failed, setFailed] = useState<{ name: string; urls: string[] }>({ name, urls: [] });
  const gaveUp = failed.name === name ? failed.urls : [];
  // the lookup that brought the photo also taught main: the rows (and this page) ask again
  useEffect(() => {
    if (photo) refreshArtistPicture(name);
  }, [photo, name]);
  const [facts, setFacts] = useState<{ of: string; albums: number; tracks: number } | null>(null);
  useEffect(() => {
    let live = true;
    void tt
      .artistFacts(name)
      .then((f) => {
        if (live) setFacts(f ? { of: name, ...f } : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [name]);
  const factsLine =
    facts && facts.of === name
      ? [
          facts.albums > 0 && `${fmtCount(facts.albums)} album${facts.albums === 1 ? "" : "s"}`,
          facts.tracks > 0 && `${fmtCount(facts.tracks)} track${facts.tracks === 1 ? "" : "s"}`,
        ]
          .filter(Boolean)
          .join(FACT_SEP)
      : "";
  const cover = folders.find((f) => f.artUrl)?.artUrl ?? null;
  // main's answer is a cover when it is one of the page's own albums' pictures
  const knownCover = known != null && folders.some((f) => f.artUrl === known);
  const choices = [chosen?.url, knownCover ? null : known, photo, serverArt, known, cover].filter(
    (u, i, all): u is string => !!u && all.indexOf(u) === i && !gaveUp.includes(u),
  );
  const picture = choices[0] ?? null;
  const next = choices[1] ?? null;
  const icon = (px: number): React.ReactNode => (
    <UserRound size={px} strokeWidth={1} className="text-faint" />
  );
  // the covers the chooser offers: the page's albums', each picture once
  const covers: CoverOffer[] = folders
    .filter((f, i) => f.artUrl && folders.findIndex((g) => g.artUrl === f.artUrl) === i)
    .map((f) => ({ url: f.artUrl as string, album: f.title, serverUdn: f.serverUdn ?? null }));
  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    // a ⋯ pressed from the keyboard has no pointer: the menu opens under the button
    if (e.type === "click" && e.detail === 0) {
      const r = e.currentTarget.getBoundingClientRect();
      setMenuAt({ x: r.left, y: r.bottom + 4 });
    } else setMenuAt({ x: e.clientX, y: e.clientY });
  };
  const reset = (): void => {
    void tt
      .setArtistChoice(name, null)
      .then(() => {
        refreshArtistPicture(name);
        setAskChosen((n) => n + 1);
      })
      .catch(() => {});
  };
  return (
    <div className="flex items-start gap-6 pb-6 pt-2" data-artist-header ref={art.attachRow}>
      <HeaderArt
        art={art}
        label="Resize the artist's picture"
        src={artSrc(picture, HEADER_ART_PX)}
        sharp={
          art.settled > HEADER_ART_PX
            ? artSrc(wikiThumbAt(picture, art.settled) ?? picture, art.settled)
            : null
        }
        fallback={(px) =>
          next ? (
            <ArtImage
              src={artSrc(next, HEADER_ART_PX)}
              className="h-full w-full object-cover"
              portraitTop
              fallback={icon(px)}
            />
          ) : (
            icon(px)
          )
        }
        portraitTop
        pending={pending}
        onGiveUp={() => {
          if (picture) setFailed({ name, urls: [...gaveUp, picture] });
        }}
        onContextMenu={openMenu}
        overlay={
          <button
            // named, but no tip: the well clips to its rounded corners, and a card's ⋯ has none
            // either (his look, 2026-10-25: the tip was cut off at the well's edge)
            aria-label="Change the picture"
            data-artist-picture-menu
            onPointerDown={(e) => e.stopPropagation()}
            onClick={openMenu}
            className={cx(
              "absolute top-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg transition-all",
              "bg-panel/80 ring-1 ring-edge text-dim hover:text-ink",
              menuAt ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-kbd:opacity-100",
            )}
          >
            <MoreHorizontal size={14} />
          </button>
        }
      />
      {menuAt && (
        <RowMenu
          title={name}
          at={menuAt}
          onClose={() => setMenuAt(null)}
          items={[
            { label: "Choose a picture…", run: () => setChoosing(true) },
            ...(chosen
              ? [
                  {
                    label: photo ? "Reset to the Wikipedia photo" : "Reset the picture",
                    run: reset,
                  },
                ]
              : []),
          ]}
        />
      )}
      <ArtistPictureDialog
        name={name}
        open={choosing}
        onClose={() => setChoosing(false)}
        covers={covers}
        current={chosen ?? null}
        onChosen={() => setAskChosen((n) => n + 1)}
      />
      {/* a set width, the summary's measure (max-w-xl), so the links on the name's line keep one
          edge from artist to artist and end where the words do; a long name wraps before it
          reaches them */}
      <div className="min-w-0 w-full max-w-xl pt-1 flex flex-col gap-1.5">
        <div className="space-y-0.5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 font-display font-bold text-[24px] tracking-tight leading-tight">
              {name}
            </div>
            <div className="flex h-[30px] shrink-0 items-center">
              <ArtistLinks name={name} />
            </div>
          </div>
          {factsLine && (
            <div className="text-[12.5px] text-faint" data-artist-facts>
              {factsLine}
            </div>
          )}
        </div>
        <ArtistAbout name={name} quiet header />
      </div>
    </div>
  );
}
