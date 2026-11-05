import { describe, expect, it } from "vitest";
import { hasAudioAssertion } from "../src/audio.ts";

const line = (name: string, what: string) =>
  `   pid 716(${name}): [0x000000e300018522] 00:00:15 NoIdleSleepAssertion named: "${what}"`;

describe("hasAudioAssertion", () => {
  it("detects the browser's Playing audio assertion", () => {
    expect(hasAudioAssertion(line("Google Chrome", "Playing audio"), "Google Chrome")).toBe(true);
  });
  it("ignores other assertions, other apps and helper processes", () => {
    expect(hasAudioAssertion(line("Google Chrome", "Playing video"), "Google Chrome")).toBe(false);
    expect(hasAudioAssertion(line("Spotify", "Playing audio"), "Google Chrome")).toBe(false);
    expect(hasAudioAssertion(line("Google Chrome Helper", "Playing audio"), "Google Chrome")).toBe(
      false,
    );
  });
  it("is false for empty output", () => {
    expect(hasAudioAssertion("", "Google Chrome")).toBe(false);
  });
});
