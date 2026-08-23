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

/** The message of whatever was thrown — an Error's, or the value as text. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
