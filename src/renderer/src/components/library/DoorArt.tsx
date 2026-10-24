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
 * THE DOORS' PICTURES (0.12.0-rc.3): what sits above each door's title, drawn from the reader's
 * own library (doorPicks chooses it). Every door has one composition and two contents, the real one
 * and a fallback for a library without it, so a door never looks broken and never pretends:
 *
 *   Albums   a row of overlapping covers, the front one largest | plain colored sleeves, the
 *            front one titled
 *   Artists  an overlapping cluster of pictures, the front circle as wide as the front cover |
 *            monograms
 *   Tracks   four stepped waveforms from stored analyses | strips with each track's title and
 *            length (never a made-up waveform)
 *
 * FLAT (his call, 2026-10-23, the cards read as dated): no blurred backdrop and no fade, the
 * pictures straight and at full brightness, each with the app's hairline and a ring of the door's
 * own surface where they overlap, in place of tilts, dimming and shadows.
 *
 * The geometry is in styles.css (the doors section): every size is a fraction of --front, which
 * follows the door's own width, so the composition scales with the window, drops its outer pair
 * on a narrow door and turns into a band beside the title on a narrow row. Decorative: hidden
 * from assistive tech, which reads the door's title and caption.
 */

/** Where each ranked item stands, left to right, by how many there are: `x` its offset and `k`
 *  its size against the front item, `step` its place from the front (which item lies on top),
 *  `outer` the pair the narrowest doors and the stacked bands drop, and `peek` where a side
 *  face's initial sits, in the part of it the faces in front leave showing (a fraction of its
 *  width). Five put the most played in front and the next two beside it, so a door that keeps
 *  three keeps the top three; one or two stay centered rather than leaning on one side. */
interface Slot {
  rank: number;
  x: number;
  k: number;
  step: number;
  outer: boolean;
  peek: number;
}
const FRONT: Slot = { rank: 0, x: 0, k: 1, step: 0, outer: false, peek: 0 };
const SLOTS: Record<"one" | "two" | "many", Slot[]> = {
  one: [FRONT],
  two: [
    { rank: 1, x: -0.3, k: 0.8, step: -1, outer: false, peek: -0.24 },
    { ...FRONT, x: 0.22 },
  ],
  many: [
    { rank: 3, x: -0.92, k: 0.6, step: -2, outer: true, peek: -0.2 },
    { rank: 1, x: -0.52, k: 0.8, step: -1, outer: false, peek: -0.24 },
    FRONT,
    { rank: 2, x: 0.52, k: 0.8, step: 1, outer: false, peek: 0.24 },
    { rank: 4, x: 0.92, k: 0.6, step: 2, outer: true, peek: 0.2 },
  ],
};

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

/** Each ranked item at its position, left to right, the front one on top. */
function placed<T>(items: T[]): Array<{ item: T; style: Styled; outer: boolean; key: number }> {
  const slots = items.length === 1 ? SLOTS.one : items.length === 2 ? SLOTS.two : SLOTS.many;
  const out: Array<{ item: T; style: Styled; outer: boolean; key: number }> = [];
  for (const p of slots) {
    const item = items[p.rank];
    if (item === undefined) continue;
    out.push({
      item,
      key: p.rank,
      outer: p.outer,
      style: {
        "--x": p.x,
        "--k": p.k,
        "--peek": p.peek,
        zIndex: 10 - Math.abs(p.step),
      },
    });
  }
  return out;
}

export function AlbumsArt({ picks }: { picks: DoorPicks }): React.JSX.Element {
  const real = picks.covers.length >= DOOR_MIN_PICTURES;
  const items = real ? picks.covers : picks.sleeves;
  return (
    <div className="lib-door-art">
      {placed(items).map(({ item, style, outer, key }) => (
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
  // all pictures or all monograms: with three pictures the cluster is the artists who have
  // one, never photos beside letters
  const asked = picks.artists.map((name, i) => ({ name, pic: answers[i] ?? null }));
  const pictured = asked.filter((f) => f.pic != null);
  const real = pictured.length >= DOOR_MIN_PICTURES;
  const faces = real
    ? faceOrder(pictured, picks.coverArt)
    : asked.map((f) => ({ name: f.name, pic: null }));
  return (
    <div className="lib-door-art">
      {placed(faces).map(({ item, style, outer, key }) => (
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
              fallback={<Monogram name={item.name} front={key === 0} />}
            />
          ) : (
            <Monogram name={item.name} front={key === 0} />
          )}
        </div>
      ))}
    </div>
  );
}

/** The front face's monogram in full; a side face shows its first initial alone, in the part
 *  of it the faces in front leave showing (the whole pair there was cut to fragments). */
function Monogram({ name, front }: { name: string; front: boolean }): React.JSX.Element {
  const letters = monogram(name);
  return (
    <div className="lib-door-monogram" style={{ background: colorOf(name) }}>
      <span>{front ? letters : ([...letters][0] ?? "")}</span>
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
}): React.JSX.Element | null {
  // nothing until the stored waveforms are read, so the strips never stand in for a moment
  if (waves == null) return null;
  const real = waves.length >= 2;
  const strips = picks.tracks.slice(0, DOOR_WAVES);
  return (
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
