import { describe, expect, it } from "vitest";
import type { ChromeTab } from "../src/applescript.ts";
import { formatPlaying } from "../src/format.ts";
import { findPlaying } from "../src/playing.ts";

const tab = (id: string, url: string): ChromeTab => ({
  id,
  windowId: "1",
  title: `t${id}`,
  url,
  isActive: false,
  loading: false,
});
const tabs = [
  tab("1", "https://www.youtube.com/watch?v=a"),
  tab("2", "https://open.spotify.com/x"),
  tab("3", "https://example.com/"),
];
const JS_OFF = "Executing JavaScript through AppleScript is turned off.";

describe("findPlaying", () => {
  it("probes only candidate urls by default and sorts results", async () => {
    const seen: string[] = [];
    const r = await findPlaying(tabs, async (id) => (seen.push(id), id === "1" ? "true" : "false"));
    expect(seen).toEqual(["1", "2"]);
    expect(r.playing.map((t) => t.id)).toEqual(["1"]);
    expect(r.silent.map((t) => t.id)).toEqual(["2"]);
  });
  it("all=true probes every tab", async () => {
    const seen: string[] = [];
    await findPlaying(tabs, async (id) => (seen.push(id), "false"), true);
    expect(seen).toEqual(["1", "2", "3"]);
  });
  it("degrades to unverified candidates, probing once, when JavaScript is disabled", async () => {
    let calls = 0;
    const r = await findPlaying(tabs, async () => {
      calls++;
      throw new Error(JS_OFF);
    });
    expect(calls).toBe(1);
    expect(r.jsDisabled).toBe(true);
    expect(r.unverified.map((t) => t.id)).toEqual(["1", "2"]);
    const out = formatPlaying(true, r);
    expect(out).toContain("Likely, unverified (2)");
    expect(out).toContain("Allow JavaScript from Apple Events");
  });
  it("keeps going when one tab fails for another reason", async () => {
    const r = await findPlaying(tabs, async (id) => {
      if (id === "1") throw new Error("Tab 1 not found");
      return "true";
    });
    expect(r.unknown.map((t) => t.id)).toEqual(["1"]);
    expect(r.playing.map((t) => t.id)).toEqual(["2"]);
    expect(r.jsDisabled).toBe(false);
  });
  it("caps probes and reports how many were skipped", async () => {
    const many = Array.from({ length: 130 }, (_, i) => tab(String(i), "https://youtube.com/" + i));
    const r = await findPlaying(many, async () => "false");
    expect(r.silent).toHaveLength(100);
    expect(r.truncated).toBe(30);
  });
});

describe("formatPlaying", () => {
  it("shortens the unverified list", async () => {
    const many = Array.from({ length: 40 }, (_, i) => tab(String(i), "https://youtube.com/" + i));
    const out = formatPlaying(
      true,
      await findPlaying(many, async () => Promise.reject(new Error(JS_OFF))),
    );
    expect(out).toContain("Likely, unverified (40)");
    expect(out).toContain("… 25 more");
  });
  it("short-circuits when nothing is playing", () => {
    expect(formatPlaying(false, null)).toBe("Audio: none. Nothing to find.");
  });
});
