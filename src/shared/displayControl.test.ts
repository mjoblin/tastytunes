import { describe, expect, it } from "vitest";
import { isDisplayVerb, screenName } from "./displayControl";

describe("a screen's name and verbs", () => {
  it("names a screen by its device and browser, an iPad's Safari by its touch", () => {
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
    expect(screenName(mac)).toBe("Mac · Safari");
    expect(screenName(mac, true)).toBe("iPad · Safari");
    expect(
      screenName(
        "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15",
      ),
    ).toBe("iPad · DuckDuckGo");
    expect(
      screenName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      ),
    ).toBe("Windows PC · Edge");
    expect(
      screenName(
        "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ),
    ).toBe("Android tablet · Chrome");
    expect(
      screenName(
        "Mozilla/5.0 (SMART-TV; LINUX; Tizen 8.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/7.0 Chrome/120.0.6099.5 TV Safari/537.36",
      ),
    ).toBe("TV · Samsung Internet");
    expect(screenName("")).toBe("Screen");
  });

  it("knows the fixed list of verbs only", () => {
    expect(isDisplayVerb("toggle")).toBe(true);
    expect(isDisplayVerb("volumeUp")).toBe(true);
    expect(isDisplayVerb("seek")).toBe(false);
    expect(isDisplayVerb({})).toBe(false);
  });
});
