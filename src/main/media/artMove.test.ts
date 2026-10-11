import { describe, expect, it } from "vitest";
import { learnArtMove, moveArt, type ArtMove } from "./artMove";

const evo = (hex: string, n: number, k: number): string =>
  `http://192.168.50.45:80/album-art-${hex}?id=${n}:${k}`;

describe("learnArtMove", () => {
  it("learns the Evo's re-minted front from one check and explains the rest", () => {
    // the user's stick, 2026-10-11: the same cover before and after a wake
    const move = learnArtMove([
      [evo("e548", 70, 3), evo("2e42", 12, 3)],
      [evo("e548", 70, 4), evo("2e42", 12, 4)],
      [evo("e548", 70, 13), evo("2e42", 12, 13)],
    ]) as ArtMove;
    expect(typeof move).toBe("object");
    expect(moveArt(evo("e548", 70, 27), move)).toBe(evo("2e42", 12, 27));
  });

  it("moves every picture right when the fronts happen to share their last digits", () => {
    // 72 → 12: the shared end reaches into the number, and the move is still right for all
    const move = learnArtMove([[evo("e548", 72, 3), evo("2e42", 12, 3)]]) as ArtMove;
    expect(moveArt(evo("e548", 72, 5), move)).toBe(evo("2e42", 12, 5));
    expect(moveArt(evo("e548", 72, 31), move)).toBe(evo("2e42", 12, 31));
  });

  it("is no move when nothing moved", () => {
    const url = evo("2e42", 12, 3);
    const move = learnArtMove([[url, url]]) as ArtMove;
    expect(move.from).toBe(move.to);
    expect(moveArt(evo("2e42", 12, 9), move)).toBe(evo("2e42", 12, 9));
  });

  it("is no move when no check has a picture", () => {
    expect(learnArtMove([[null, null]])).toEqual({ from: "", to: "" });
    expect(learnArtMove([])).toEqual({ from: "", to: "" });
  });

  it("refuses a check whose picture appeared or went", () => {
    expect(typeof learnArtMove([[null, evo("2e42", 12, 3)]])).toBe("string");
    expect(typeof learnArtMove([[evo("e548", 70, 3), null]])).toBe("string");
  });

  it("refuses checks one move cannot explain (pictures renumbered)", () => {
    const why = learnArtMove([
      [evo("e548", 70, 3), evo("2e42", 12, 3)],
      [evo("e548", 70, 4), evo("2e42", 12, 9)],
    ]);
    expect(typeof why).toBe("string");
  });

  it("leaves a picture that does not start where the move starts unmoved and says so", () => {
    const move = learnArtMove([[evo("e548", 70, 3), evo("2e42", 12, 3)]]) as ArtMove;
    expect(moveArt("http://elsewhere/cover.jpg", move)).toBeUndefined();
  });
});
