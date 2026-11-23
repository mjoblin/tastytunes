import { describe, expect, it } from "vitest";
import { MAX_WIRE_NOTES, modelReport, modelReportUrl, type ModelFacts } from "./modelReport";

const facts: ModelFacts = {
  model: "Evo 75",
  api: "1.9",
  versions: [
    { component: "host", version: "1.2.3" },
    { component: "mcu", version: "4.5" },
  ],
  appVersion: "0.17.0",
  platform: "macOS",
  wire: ["/zone/play_state: metadata.duration was string, set aside"],
};

describe("a model check-in", () => {
  it("names the model, its firmware and API version, the app and its platform, and the wire notes", () => {
    const { title, body } = modelReport(facts);
    expect(title).toBe("Model check-in: Evo 75");
    expect(body).toContain("- Firmware: host 1.2.3, mcu 4.5");
    expect(body).toContain("- API version: 1.9");
    expect(body).toContain("- TastyTunes: 0.17.0 on macOS");
    expect(body).toContain("- /zone/play_state: metadata.duration was string, set aside");
  });

  it("says None when nothing was set aside, and caps a long list", () => {
    expect(modelReport({ ...facts, wire: [] }).body).toContain("- None.");
    const many = Array.from(
      { length: MAX_WIRE_NOTES + 5 },
      (_, i) => `/p: f${i} was string, set aside`,
    );
    const body = modelReport({ ...facts, wire: many }).body;
    expect(body).toContain(`f${MAX_WIRE_NOTES - 1} was`);
    expect(body).not.toContain(`f${MAX_WIRE_NOTES} was`);
    expect(body).toContain("…and 5 more.");
  });

  it("opens the repository's issue form, with the report as its fields", () => {
    const url = new URL(modelReportUrl(facts));
    expect(url.origin + url.pathname).toBe("https://github.com/mjoblin/tastytunes/issues/new");
    expect(url.searchParams.get("title")).toBe("Model check-in: Evo 75");
    expect(url.searchParams.get("body")).toBe(modelReport(facts).body);
  });

  it("carries only what it is given: the type has no room for an id, a name or an address", () => {
    const keys = Object.keys(facts).sort();
    expect(keys).toEqual(["api", "appVersion", "model", "platform", "versions", "wire"]);
  });
});
