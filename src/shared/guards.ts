/**
 * Narrowing at the app's untyped seams — JSON from our own files, the XML
 * parser's output, frames off the wire, caught errors. Everything that
 * arrives as `unknown` (or `any`) passes through one of these before typed
 * code touches it, so the ESLint no-unsafe-* rules can stay at error.
 */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function isStringArray(x: unknown): x is readonly string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}

/** "a string", "a list", "null": what a value was, for a log line (the wire's check, the saved
 *  files' checks). */
export const kindOf = (v: unknown): string =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "a list"
      : typeof v === "object"
        ? "an object"
        : typeof v === "boolean"
          ? "a yes/no"
          : `a ${typeof v}`;

/** The message of whatever was thrown — an Error's, or the value as text. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
