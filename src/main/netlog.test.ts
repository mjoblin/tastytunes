import { describe, expect, it } from "vitest";
import { redactUrl } from "./netlog";

describe("what the request log keeps of a URL", () => {
  it("blanks a key or a token in its query, whatever its name's case", () => {
    expect(redactUrl("https://webservice.fanart.tv/v3/music/abc?api_key=s3cr3t")).toBe(
      "https://webservice.fanart.tv/v3/music/abc?api_key=REDACTED",
    );
    expect(redactUrl("https://x.test/a?q=cure&Token=t1&client_key=c2")).toBe(
      "https://x.test/a?q=cure&Token=REDACTED&client_key=REDACTED",
    );
  });

  it("leaves every other URL as it was", () => {
    const plain = "https://musicbrainz.org/ws/2/artist?query=artist:%22Keane%22&fmt=json&limit=3";
    expect(redactUrl(plain)).toBe(plain);
    expect(redactUrl("not a url")).toBe("not a url");
  });
});
