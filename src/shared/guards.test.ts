/**
 * The narrowing guards at the app's untyped seams. Small, but everything
 * that arrives as unknown (JSON, the XML parser, the wire, a caught error)
 * passes through one of these before typed code touches it.
 */
import { describe, expect, it } from "vitest";
import { errorMessage, isRecord, isStringArray } from "./guards";

describe("isRecord", () => {
  it("is true for a plain object, empty or not", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it("is false for null, arrays and every primitive", () => {
    // typeof null and typeof [] are both "object": the two traps it exists for
    for (const v of [null, [], [1], undefined, 0, "", "x", true, Symbol("s"), () => 1])
      expect(isRecord(v)).toBe(false);
  });
});

describe("isStringArray", () => {
  it("is true for an array holding only strings, the empty array included", () => {
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(["a", ""])).toBe(true);
  });

  it("is false when any element is not a string, or for a non-array", () => {
    expect(isStringArray(["a", 1])).toBe(false);
    expect(isStringArray(["a", null])).toBe(false);
    expect(isStringArray("abc")).toBe(false);
    expect(isStringArray({ 0: "a", length: 1 })).toBe(false);
    expect(isStringArray(null)).toBe(false);
  });
});

describe("errorMessage", () => {
  it("is an Error's message, subclasses included", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
  });

  it("is anything else as text", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ message: "not an Error" })).toBe("[object Object]");
  });
});
