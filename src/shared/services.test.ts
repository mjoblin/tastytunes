import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVICES } from "./services";

// The README's "What leaves your machine" names every internet service the app talks to (0.15.0:
// the list called itself complete while three lookups were missing from it)
const readme = readFileSync(join(__dirname, "..", "..", "README.md"), "utf8");
const section = readme.slice(
  readme.indexOf("## What leaves your machine"),
  readme.indexOf("\n## ", readme.indexOf("## What leaves your machine") + 1),
);

describe("the services the app talks to", () => {
  it("are all in the README's list of what leaves your machine", () => {
    expect(section.length).toBeGreaterThan(0);
    for (const [id, s] of Object.entries(SERVICES))
      for (const host of "hosts" in s ? s.hosts : [])
        expect(section, `${id}: ${host}`).toContain(host);
  });
});
