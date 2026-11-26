import { describe, expect, it } from "vitest";
import { whyDark } from "./dark";

describe("a dark page says why at a touch", () => {
  it("says the app can't be reached, whatever it last heard of the streamer", () => {
    for (const connected of [true, false])
      for (const wake of ["ready", "unreachable", null] as const)
        expect(whyDark({ heard: false, connected, wake })).toEqual({
          cause: "app",
          line: "Can't reach TastyTunes. Check that it's running and the computer is awake.",
        });
  });

  it("says the app can't reach the streamer", () => {
    expect(whyDark({ heard: true, connected: false, wake: null })).toEqual({
      cause: "streamer",
      line: "TastyTunes can't reach the streamer.",
    });
  });

  it("says to wake it with its remote where this screen has Wake and a wake can't work", () => {
    expect(whyDark({ heard: true, connected: false, wake: "unreachable" })).toEqual({
      cause: "streamer",
      line: "TastyTunes can't reach the streamer. Wake it with its remote.",
    });
  });

  it("says the streamer is asleep, beside Wake or without it", () => {
    const asleep = { cause: "asleep", line: "The streamer is asleep." };
    expect(whyDark({ heard: true, connected: true, wake: null })).toEqual(asleep);
    expect(whyDark({ heard: true, connected: true, wake: "ready" })).toEqual(asleep);
    // the line agrees with the Wake drawn beside it
    expect(whyDark({ heard: true, connected: false, wake: "ready" })).toEqual(asleep);
  });
});
