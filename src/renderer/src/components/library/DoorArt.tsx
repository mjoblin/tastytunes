import type { MediaNode } from "@shared/model";
import { fmtTime } from "@/lib/format";
import { artKeyOf, artSrc } from "@/lib/artSrc";
import { useArtistPictureAnswer } from "@/lib/artistPictures";
import { ArtImage } from "@/components/media/ArtImage";
import {
  type DoorPicks,
  DOOR_ITEMS,
  DOOR_MIN_PICTURES,
  faceOrder,
  monogram,
} from "@/components/library/doorPicks";
import { hashStr } from "@/components/display/scenes/lib";
import { DOOR_WAVES, type DoorWave } from "@/components/library/useDoorArt";

/**
 * THE DOORS' PICTURES (0.12.0-rc.3): what sits behind each door's title, drawn from the reader's
 * own library (doorPicks chooses it). Every door has one composition and two contents, the real one
 * and a fallback for a library without it, so a door never looks broken and never pretends:
 *
 *   Albums   a fanned crate of covers, the front one largest | plain colored sleeves, the front
 *            one titled
 *   Artists  an overlapping cluster of pictures, the front circle as wide as the front cover |
 *            monograms
 *   Tracks   four stepped waveforms from stored analyses | strips with each track's title and
 *            length (never a made-up waveform)
 *
 * The geometry is in styles.css (the doors section): every size is a fraction of --front, which
 * follows the door's own width, so the composition scales with the window, drops its outer pair
 * on a narrow door and turns into a band beside the title on a narrow row. Decorative: hidden
 * from assistive tech, which reads the door's title and caption.
 */

/** Left to right: the size against the front item, the brightness, and the outer pair the
 *  narrowest doors drop. */
const POSITIONS = [
  { x: -0.92, k: 0.6, dim: 0.72, outer: true },
  { x: -0.52, k: 0.8, dim: 0.86, outer: false },
  { x: 0, k: 1, dim: 1, outer: false },
  { x: 0.52, k: 0.8, dim: 0.86, outer: false },
  { x: 0.92, k: 0.6, dim: 0.72, outer: true },
];
/** Which ranked item stands at each position: the most played in front, the next two beside
 *  it, so a door that keeps three keeps the top three. */
const RANK_AT = [3, 1, 0, 2, 4];

/** The sleeves' and monograms' colors: muted, warm, readable under white type. */
const PALETTE = [
  "#6b4423",
  "#3f4b3a",
  "#7a2f2a",
  "#2e3f52",
  "#8a6a2e",
  "#4b3a55",
  "#5c5a2e",
  "#734a37",
  "#2f4d4a",
  "#5a3046",
  "#7b5b26",
];
const colorOf = (s: string): string => PALETTE[hashStr(s.toLowerCase()) % PALETTE.length];

type Styled = React.CSSProperties & Record<`--${string}`, string | number>;

/** Each ranked item at its position, left to right; `fanned` tilts and drops them like a crate. */
function placed<T>(
  items: T[],
  fanned: boolean,
): Array<{ item: T; style: Styled; outer: boolean; key: number }> {
  const out: Array<{ item: T; style: Styled; outer: boolean; key: number }> = [];
  POSITIONS.forEach((p, i) => {
    const item = items[RANK_AT[i]];
    if (item === undefined) return;
    const step = i - 2;
    out.push({
      item,
      key: RANK_AT[i],
      outer: p.outer,
      style: {
        "--x": p.x,
        "--k": p.k,
        "--dim": p.dim,
        "--y": fanned ? Math.abs(step) * 0.05 : 0,
        "--r": fanned ? `${step * 7}deg` : "0deg",
        zIndex: 10 - Math.abs(step),
      },
    });
  });
  return out;
}

function Wash({ src, color }: { src?: string | null; color?: string }): React.JSX.Element {
  return src ? (
    <div className="lib-door-wash" style={{ backgroundImage: `url("${src}")` }} />
  ) : (
    <div
      className="lib-door-wash lib-door-wash-plain"
      style={{ background: `radial-gradient(90% 80% at 50% 30%, ${color}, transparent 75%)` }}
    />
  );
}

export function AlbumsArt({ picks }: { picks: DoorPicks }): React.JSX.Element {
  const real = picks.covers.length >= DOOR_MIN_PICTURES;
  const items = real ? picks.covers : picks.sleeves;
  const front = items[0];
  return (
    <>
      {real && front ? (
        <Wash src={artSrc(front.artUrl, 120, artKeyOf(front))} />
      ) : (
        <Wash color={colorOf(front?.title ?? "albums")} />
      )}
      <div className="lib-door-art">
        {placed(items, true).map(({ item, style, outer, key }) => (
          <div
            key={key}
            className={
              outer ? "lib-door-item lib-door-cover lib-door-outer" : "lib-door-item lib-door-cover"
            }
            style={style}
          >
            {real ? (
              <ArtImage
                src={artSrc(item.artUrl, 240, artKeyOf(item))}
                className="h-full w-full object-cover"
                fallback={<Sleeve album={item} titled={false} />}
              />
            ) : (
              <Sleeve album={item} titled={key === 0} />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** A plain sleeve in a color of its title; the front one carries the title and artist. */
function Sleeve({ album, titled }: { album: MediaNode; titled: boolean }): React.JSX.Element {
  return (
    <div className="lib-door-sleeve" style={{ background: colorOf(album.title) }}>
      {titled ? (
        <>
          <div className="lib-door-sleeve-title">{album.title}</div>
          <div className="lib-door-sleeve-artist">{album.albumArtist ?? album.artist ?? ""}</div>
        </>
      ) : (
        <div className="lib-door-sleeve-rule" />
      )}
    </div>
  );
}

export function ArtistsArt({ picks }: { picks: DoorPicks }): React.JSX.Element | null {
  // five asks, always (a hook per position): the cluster waits for every answer rather than
  // drawing monograms a picture replaces a moment later
  const names = Array.from({ length: DOOR_ITEMS }, (_, i) => picks.artists[i] ?? null);
  const answers = [
    useArtistPictureAnswer(names[0]),
    useArtistPictureAnswer(names[1]),
    useArtistPictureAnswer(names[2]),
    useArtistPictureAnswer(names[3]),
    useArtistPictureAnswer(names[4]),
  ];
  const named = picks.artists.length;
  if (answers.slice(0, named).some((a) => a === undefined)) return null;
  const real = answers.filter((a) => a != null).length >= DOOR_MIN_PICTURES;
  const faces = faceOrder(
    picks.artists.map((name, i) => ({ name, pic: real ? (answers[i] ?? null) : null })),
    picks.coverArt,
  );
  const front = faces[0];
  return (
    <>
      {real && front?.pic ? (
        <Wash src={artSrc(front.pic, 120)} />
      ) : (
        <Wash color={colorOf(front?.name ?? "artists")} />
      )}
      <div className="lib-door-art">
        {placed(faces, false).map(({ item, style, outer, key }) => (
          <div
            key={key}
            className={
              outer ? "lib-door-item lib-door-face lib-door-outer" : "lib-door-item lib-door-face"
            }
            style={style}
          >
            {item.pic ? (
              <ArtImage
                src={artSrc(item.pic, 240)}
                portraitTop
                className="h-full w-full object-cover"
                fallback={<Monogram name={item.name} />}
              />
            ) : (
              <Monogram name={item.name} />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function Monogram({ name }: { name: string }): React.JSX.Element {
  return (
    <div className="lib-door-monogram" style={{ background: colorOf(name) }}>
      <span>{monogram(name)}</span>
    </div>
  );
}

/** The four rows step back: each a little narrower and fainter than the one above it. */
const ROWS = [
  { w: 1, o: 1 },
  { w: 0.9, o: 0.78 },
  { w: 0.8, o: 0.6 },
  { w: 0.7, o: 0.45 },
];

export function TracksArt({
  picks,
  waves,
}: {
  picks: DoorPicks;
  waves: DoorWave[] | null;
}): React.JSX.Element {
  const gold = <div className="lib-door-wash lib-door-wash-plain lib-door-wash-gold" />;
  if (waves == null) return gold;
  const real = waves.length >= 2;
  const strips = picks.tracks.slice(0, DOOR_WAVES);
  return (
    <>
      {gold}
      <div className="lib-door-art lib-door-rows">
        {ROWS.map((r, i) => {
          const wave = real ? waves[i] : undefined;
          const track = real ? undefined : strips[i];
          if (!wave && !track) return null;
          return (
            <div
              key={i}
              className={wave ? "lib-door-row lib-door-wave" : "lib-door-row lib-door-strip"}
              style={{ "--w": r.w, opacity: r.o } as Styled}
            >
              {wave ? (
                <WaveBars bars={wave.bars} />
              ) : (
                track && (
                  <>
                    <span className="lib-door-strip-title">{track.title}</span>
                    {track.durationSecs != null && (
                      <span className="lib-door-strip-length">{fmtTime(track.durationSecs)}</span>
                    )}
                  </>
                )
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function WaveBars({ bars }: { bars: number[] }): React.JSX.Element {
  return (
    <svg
      viewBox={`0 0 ${bars.length * 3} 20`}
      preserveAspectRatio="none"
      className="h-full w-full block"
    >
      {bars.map((v, i) => {
        const h = Math.max(1.2, v * 19);
        return <rect key={i} x={i * 3} y={(20 - h) / 2} width={1.9} height={h} rx={0.6} />;
      })}
    </svg>
  );
}

/** The Library with no libraries: the Albums door's crate, empty, in line (EmptyState's art). */
export function EmptyCrate(): React.JSX.Element {
  return (
    <svg width={240} height={138} viewBox="0 0 260 150" aria-hidden className="block">
      <g fill="none" strokeWidth={1.6} strokeLinejoin="round" className="stroke-gold">
        <rect
          x={62}
          y={34}
          width={70}
          height={70}
          rx={3}
          transform="rotate(-12 97 69)"
          opacity={0.45}
        />
        <rect x={96} y={28} width={70} height={70} rx={3} opacity={0.7} />
        <circle cx={131} cy={63} r={22} opacity={0.7} />
        <circle cx={131} cy={63} r={4} opacity={0.7} />
        <rect
          x={130}
          y={34}
          width={70}
          height={70}
          rx={3}
          transform="rotate(12 165 69)"
          opacity={0.45}
        />
        <path d="M40 92 L220 92 L208 140 L52 140 Z" className="fill-raised" strokeOpacity={0.9} />
        <path d="M70 116 H190" opacity={0.5} />
      </g>
    </svg>
  );
}
