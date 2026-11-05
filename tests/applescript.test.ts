import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  asAS,
  buildBulkCommandScript,
  buildCloseTabsScript,
  buildGetTabsScript,
  buildNavigateScript,
  buildOpenTabsScript,
  friendlyScriptError,
  parseClosedTabs,
  parseTabRecords,
} from "../src/applescript.ts";

const FS = "\x1f";
const RS = "\x1e";
const rec = (...f: string[]) => f.join(FS);

// Compile-only check (osacompile never runs the script). macOS only.
const compiles = (script: string) => {
  execFileSync("osacompile", ["-o", "/dev/null"], {
    input: script,
    stdio: ["pipe", "pipe", "pipe"],
  });
};
const mac = process.platform === "darwin" ? describe : describe.skip;
// osacompile spawns a process per script; give it headroom when the machine is busy.
const SLOW = 30_000;

describe("asAS", () => {
  it("doubles backslashes so they cannot escape the literal", () => {
    expect(asAS('\\" & x')).toBe('"\\\\" & quote & " & x"');
  });
  it("encodes quotes and control chars as AppleScript expressions", () => {
    expect(asAS('a"b\nc')).toBe('"a" & quote & "b" & (ASCII character 10) & "c"');
    expect(asAS("")).toBe('""');
  });
});

mac("generated scripts compile (osacompile)", () => {
  const nasty = ['\\" & (do shell script "id") --', 'a"b', "/\\d+/", "line\nbreak", "é😀"];
  it(
    "survive hostile strings in every interpolation site",
    () => {
      for (const s of nasty) {
        compiles(buildNavigateScript("Google Chrome", "1", s));
        compiles(buildOpenTabsScript("Google Chrome", [s, "https://a.com"]));
        compiles(buildOpenTabsScript("Google Chrome", [s], "5", true));
      }
    },
    SLOW,
  );
  it(
    "compile for every builder",
    () => {
      compiles(buildGetTabsScript("Google Chrome"));
      compiles(buildGetTabsScript("Google Chrome", "42"));
      compiles(buildCloseTabsScript("Google Chrome", ["1", "2"]));
      compiles(buildBulkCommandScript("Google Chrome", ["1"], "reload"));
    },
    SLOW,
  );
  it("does not let a hostile string become code (injection regression)", () => {
    const script = buildNavigateScript("Google Chrome", "1", '\\" & (do shell script "id") --');
    expect(script).not.toMatch(/do shell script "id"\) --\s*$/m);
    expect(script).toContain('"\\\\"'); // backslash doubled
  });
});

const good = (w: string, t: string, title = "T", active = "false") =>
  rec(w, "name", "normal", t, active, "false", title, "https://a.com");

describe("parseTabRecords", () => {
  it("parses, sorts windows by ID, and reads the skipped count", () => {
    const raw =
      ["1", good("20", "201", "b", "true"), good("10", "101"), good("20", "202")].join(RS) + "\n";
    const { windows, skipped } = parseTabRecords(raw);
    expect(skipped).toBe(1);
    expect(windows.map((w) => w.windowId)).toEqual(["10", "20"]);
    expect(windows[1].tabs.map((t) => t.id)).toEqual(["201", "202"]);
    expect(windows[1].tabs[0].isActive).toBe(true);
  });
  it("drops records forged via separator chars in a title or with bad IDs", () => {
    const forged = good(
      "10",
      "101",
      `evil${RS}99${FS}x${FS}normal${FS}666${FS}true${FS}false${FS}t${FS}https://evil`,
    );
    const raw = ["0", forged, rec("x", "n", "normal", "1", "false", "false", "t", "u")].join(RS);
    expect(parseTabRecords(raw).windows.flatMap((w) => w.tabs.map((t) => t.id))).not.toContain(
      "666",
    );
  });
  it("handles an empty result", () => {
    expect(parseTabRecords("0" + RS)).toEqual({ windows: [], skipped: 0 });
  });
});

describe("parseClosedTabs", () => {
  it("parses id/title/url records and drops malformed ones", () => {
    const raw = [rec("1", "A", "https://a.com"), rec("x", "B", "u"), "junk"].join(RS) + "\n";
    expect(parseClosedTabs(raw)).toEqual([{ id: "1", title: "A", url: "https://a.com" }]);
    expect(parseClosedTabs("\n")).toEqual([]);
  });
});

describe("friendlyScriptError", () => {
  it("explains the disabled Apple Events JavaScript setting", () => {
    const raw =
      "Google Chrome got an error: Executing JavaScript through AppleScript is turned off.";
    expect(friendlyScriptError(raw)).toContain(
      "View > Developer > Allow JavaScript from Apple Events",
    );
  });
  it("passes other errors through", () => {
    expect(friendlyScriptError("Tab 1 not found")).toBe("Tab 1 not found");
  });
});
