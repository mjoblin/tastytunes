/**
 * The folder path a refused browse re-walks: the deepest walked path in the trail, never the
 * app's own crumbs. The names are placeholders chosen to show a shape.
 */
import { describe, expect, it } from "vitest";
import { browseWalk } from "./browseWalk";

const app = (id: string): boolean => id.startsWith("__");
const drive = ["Flash Drive", "Music", "Artist - Album"];

describe("browseWalk", () => {
  it("takes an album's own walked path when it was opened from a lens", () => {
    const path = [
      { id: "__lens__", title: "Albums" },
      { id: "2:0_0_3", title: "Album", node: { titlePath: drive } },
    ];
    expect(browseWalk(path, app)).toEqual(drive);
  });
  it("adds the folders entered below the album, and leaves out the app's crumbs", () => {
    const path = [
      { id: "__lens__", title: "Albums" },
      { id: "__lens-artist__", title: "Artist" },
      { id: "2:0_0_3", title: "Album", node: { titlePath: drive } },
      { id: "2:0_0_3_0", title: "Disc 1" },
    ];
    expect(browseWalk(path, app)).toEqual([...drive, "Disc 1"]);
  });
  it("is the trail's titles when nothing on it was walked (a server's folders browsed)", () => {
    const path = [
      { id: "0$1", title: "Music" },
      { id: "0$1$2", title: "Artist - Album", node: {} },
    ];
    expect(browseWalk(path, app)).toEqual(["Music", "Artist - Album"]);
  });
});
