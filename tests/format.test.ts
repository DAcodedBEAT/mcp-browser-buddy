import { describe, expect, it } from "vitest";
import type { ChromeTab, ChromeWindow } from "../src/applescript.ts";
import {
  filterTabs,
  formatDuplicates,
  formatTabs,
  summarizeWindows,
  tabLine,
} from "../src/format.ts";

const tab = (id: number, over: Partial<ChromeTab> = {}): ChromeTab => ({
  id: String(id),
  windowId: "9",
  title: `t${id}`,
  url: `https://www.example.com/${id}`,
  isActive: false,
  loading: false,
  ...over,
});
const win = (n: number, windowId = "9", over: Partial<ChromeWindow> = {}): ChromeWindow => ({
  windowId,
  windowName: "w",
  mode: "normal",
  tabs: Array.from({ length: n }, (_, i) => tab(i + 1, { windowId })),
  ...over,
});

describe("tabLine", () => {
  it("collapses newlines, control and bidi chars in page-controlled titles", () => {
    expect(tabLine(tab(1, { title: "a\nb\x1fc‮D" })).split("\n")).toHaveLength(1);
    expect(tabLine(tab(1, { title: "a‮b" }))).not.toContain("‮");
  });
  it("clips long titles without splitting surrogate pairs", () => {
    const line = tabLine(tab(1, { title: "a".repeat(79) + "😀😀😀" }));
    expect(line).toContain("…");
    expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
  it("never clips a normal URL", () => {
    const url = "https://example.com/" + "x".repeat(500);
    expect(tabLine(tab(1, { url }))).toContain(url);
  });
  it("marks active and loading", () => {
    expect(tabLine(tab(7, { isActive: true, loading: true }))).toMatch(/^7★… /);
  });
});

describe("formatTabs", () => {
  it("pages and tells the caller the next offset", () => {
    expect(formatTabs([win(5)], 2, 0)).toMatch(/1-2 of 5.*offset=2/);
    expect(formatTabs([win(5)], 2, 4)).not.toContain("offset=");
  });
  it("re-heads only when the window changes, and flags incognito", () => {
    const out = formatTabs([win(2, "1"), win(1, "2", { mode: "incognito" })], 10, 0);
    expect(out.match(/# Window/g)).toHaveLength(2);
    expect(out).toContain("[incognito]");
  });
  it("reports empty and out-of-range results", () => {
    expect(formatTabs([win(3)], 10, 50)).toContain("past the end");
    expect(formatTabs([], 10, 0)).toBe("(no tabs)");
  });
  it("stops at the char budget and points at the next offset", () => {
    const big = win(0);
    big.tabs = Array.from({ length: 100 }, (_, i) =>
      tab(i + 1, { url: "https://e.com/" + "x".repeat(1900) }),
    );
    const out = formatTabs([big], 100, 0);
    expect(out.length).toBeLessThan(45_000);
    expect(out).toMatch(/offset=\d+/);
  });
});

describe("filterTabs", () => {
  it("requires every term, case-insensitively, over title and url", () => {
    const w = win(0);
    w.tabs = [tab(1, { title: "Foo Bar" }), tab(2, { url: "https://x.com/foo" })];
    expect(filterTabs([w], "foo bar")[0].tabs.map((t) => t.id)).toEqual(["1"]);
    expect(filterTabs([w], "FOO")[0].tabs).toHaveLength(2);
    expect(filterTabs([w], "nope")).toEqual([]);
  });
});

describe("summarizeWindows", () => {
  it("lists top domains without www, plus a global line", () => {
    const out = summarizeWindows([win(3)]);
    expect(out).toContain("example.com (3)");
    expect(out).toContain("Top domains overall");
  });
  it("collapses opaque URLs to their scheme", () => {
    const w = win(0);
    w.tabs = [tab(1, { url: "data:text/html," + "A".repeat(5000) })];
    expect(summarizeWindows([w]).length).toBeLessThan(400);
  });
});

describe("formatDuplicates", () => {
  it("groups by URL ignoring fragment and trailing slash", () => {
    const w = win(0);
    w.tabs = [
      tab(1, { url: "https://a.com/x" }),
      tab(2, { url: "https://a.com/x/#top" }),
      tab(3, { url: "https://b.com" }),
    ];
    const out = formatDuplicates([w]);
    expect(out).toContain("2× https://a.com/x — ids: 1, 2");
    expect(out).not.toContain("b.com");
  });
  it("says so when there are none", () => {
    expect(formatDuplicates([win(2)])).toBe("No duplicate tabs.");
  });
});
