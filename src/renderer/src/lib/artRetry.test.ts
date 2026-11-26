import { describe, expect, it } from "vitest";
import { artRetriable, artRetryUrl } from "./artRetry";

describe("a picture that fails is asked for again", () => {
  it("retries a server's picture and the display page's own", () => {
    expect(artRetriable("http://192.0.2.10:8080/art/12.jpg")).toBe(true);
    expect(artRetriable("HTTPS://example.com/cover.png")).toBe(true);
    expect(artRetriable("/art/0123456789abcdef01234567")).toBe(true);
  });

  it("never retries a picture held in the page or the thumbnail cache", () => {
    expect(artRetriable("data:image/png;base64,AAAA")).toBe(false);
    expect(artRetriable("blob:http://localhost/1234")).toBe(false);
    expect(artRetriable("tt-art://thumb/card/abc?u=x")).toBe(false);
    expect(artRetriable("/api/snapshot")).toBe(false);
  });

  it("asks with a query the browser hasn't seen, the first ask as it is", () => {
    expect(artRetryUrl("/art/0123456789abcdef01234567", 0)).toBe("/art/0123456789abcdef01234567");
    expect(artRetryUrl("/art/0123456789abcdef01234567", 1)).toBe(
      "/art/0123456789abcdef01234567?tt_retry=1",
    );
    expect(artRetryUrl("http://h/a.jpg?size=200", 2)).toBe("http://h/a.jpg?size=200&tt_retry=2");
    expect(artRetryUrl("data:image/png;base64,AAAA", 1)).toBe("data:image/png;base64,AAAA");
  });
});
