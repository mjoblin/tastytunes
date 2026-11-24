import { describe, expect, it } from "vitest";
import { AUDIO_TYPE } from "./exportTools";

describe("what a copied track's answer may be", () => {
  it("is audio, or the plain bytes a server calls every file, never a page", () => {
    for (const t of [
      "audio/flac",
      "audio/x-flac",
      "audio/mpeg",
      "application/ogg",
      "application/x-flac",
      "application/octet-stream",
      "binary/octet-stream",
    ])
      expect(AUDIO_TYPE.test(t)).toBe(true);
    for (const t of ["text/html", "application/json", "image/jpeg", "", "application/zip"])
      expect(AUDIO_TYPE.test(t)).toBe(false);
  });
});
