// THE KEYS TWO STRINGS ARE COMPARED BY (0.15.0, the hygiene pass: 81 name keys were hand-rolled
// in 42 files, none normalizing Unicode). The lint rule name-key refuses a
// hand-rolled trim().toLowerCase() anywhere else.

/**
 * How two names are found to be the same: an artist's, an album's, a station's, a title, a
 * filter's words. Trimmed, lowercased, then NFC, so a name written with a combining accent (é as
 * e and U+0301, as some taggers and file systems store it) meets its precomposed twin. NFC comes
 * last because lowercasing can itself decompose (İ becomes i and U+0307), and so a key kept before
 * 0.15.0, which was trimmed and lowercased, gives nameKey's answer when passed through it again.
 */
export const nameKey = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase().normalize("NFC");

/** The letters an NFD decomposition leaves whole, as a search reads them. */
const UNMARKED: Record<string, string> = {
  ø: "o",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};

/**
 * How a search's words meet a name (0.16.0): nameKey, then the accents off (NFD, its marks
 * dropped), the letters that carry none folded (ø, æ, ß), and punctuation and symbols gone. So
 * "motorhead" finds Motörhead, "rufus" RÜFÜS, "acdc" and "ac/dc" AC/DC, "hip hop" Hip-Hop and
 * "dont" Don't. For matching only: a key that is stored, or that says two names are one, stays
 * nameKey's.
 */
export const searchFold = (s: string | null | undefined): string =>
  nameKey(s)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[øæœßłđðþı]/g, (c) => UNMARKED[c])
    .replace(/[\p{P}\p{S}]/gu, "");

/** A query's words, each folded, and as typed for a word that is all punctuation ("!!!" names a
 *  band, and folds to nothing). */
export interface QueryWord {
  folded: string;
  typed: string;
}
export const queryWords = (query: string): QueryWord[] =>
  nameKey(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((typed) => ({ typed, folded: searchFold(typed) }));

/**
 * THE ONE TEXT MATCH (0.16.0): every word of a query somewhere in the joined fields, each side
 * folded, so "maiden beast" matches across artist and title. The in-app filters (the renderer's
 * matchesFilter), the Library's search and the agents' search (main's searchIndex) all ask it;
 * before, each had its own and neither folded accents.
 */
export function matchesWords(
  words: readonly QueryWord[],
  fields: ReadonlyArray<string | null | undefined>,
): boolean {
  const joined = fields.filter(Boolean).join(" ");
  const folded = searchFold(joined);
  let typed: string | null = null;
  return words.every((w) =>
    w.folded !== "" ? folded.includes(w.folded) : (typed ??= nameKey(joined)).includes(w.typed),
  );
}

export const matchesQuery = (
  query: string,
  fields: ReadonlyArray<string | null | undefined>,
): boolean => matchesWords(queryWords(query), fields);

/** A Content-Type's media type, lowercased: "image/jpeg" from "Image/JPEG; charset=binary". */
export const mediaType = (header: string | null | undefined): string =>
  (header ?? "").split(";")[0].trim().toLowerCase();
