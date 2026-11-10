// THE KEYS TWO STRINGS ARE COMPARED BY (0.15.0, the hygiene pass; the 0.11 re-score found 81
// name keys hand-rolled in 42 files, none normalizing Unicode). The lint rule name-key refuses a
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

/** A Content-Type's media type, lowercased: "image/jpeg" from "Image/JPEG; charset=binary". */
export const mediaType = (header: string | null | undefined): string =>
  (header ?? "").split(";")[0].trim().toLowerCase();
