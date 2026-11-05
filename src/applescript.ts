// AppleScript layer: script builders are pure (testable without a browser); only runAppleScript
// touches osascript.
import { spawn } from "node:child_process";

export const ALLOWED_BROWSERS = [
  "Google Chrome",
  "Brave Browser",
  "Chromium",
  "Google Chrome Canary",
] as const;

export interface ChromeTab {
  id: string;
  windowId: string;
  title: string;
  url: string;
  isActive: boolean;
  loading: boolean;
}

export interface ChromeWindow {
  windowId: string;
  windowName: string;
  mode: string; // "normal" | "incognito"
  tabs: ChromeTab[];
}

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(level: "INFO" | "WARN" | "ERROR", message: string) {
  const timestamp = new Date().toISOString();
  process.stderr.write(`[${timestamp}] [${level}] ${message}\n`);
}

// ASCII control chars — never appear in URLs; parseTabRecords rejects records where a title
// smuggles them in.
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

// ─── Script building ──────────────────────────────────────────────────────────

// Safe AppleScript string expression from arbitrary JS string — no shell quoting needed.
// Backslash is an escape character inside AppleScript string literals, so it must be doubled or
// `\"` would close the literal early and the rest would run as code.
export function asAS(value: string): string {
  const tokens: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) tokens.push(`"${buf}"`);
    buf = "";
  };
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '"') {
      flush();
      tokens.push("quote");
    } else if (code < 32 || code === 127) {
      flush();
      tokens.push(`(ASCII character ${code})`);
    } else {
      buf += ch === "\\" ? "\\\\" : ch;
    }
  }
  flush();
  return tokens.length > 0 ? tokens.join(" & ") : '""';
}

// Wraps `body` in `tell application`. Errors instead of launching a browser that isn't running.
function tell(browser: string, body: string): string {
  const app = asAS(browser);
  return `
if application ${app} is not running then error ${app} & " is not running"
tell application ${app}
${body}
end tell`;
}

// Body: find window by ID, run `action` (has access to `w`), error if not found.
function findWindowScript(windowId: string, action: string): string {
  return `
  set wid to ${asAS(windowId)}
  repeat with i from 1 to (count of windows)
    set w to window i
    if (id of w) as string = wid then
      ${action}
      return
    end if
  end repeat
  error "Window " & wid & " not found"`;
}

// Body: find tab by ID across all windows, run `action`, error if not found.
// `action` has access to: t (tab), w (window), tIdx (1-based position).
function findTabScript(tabId: string, action: string): string {
  return `
  set tid to ${asAS(tabId)}
  repeat with wIdx from 1 to (count of windows)
    set w to window wIdx
    repeat with tIdx from 1 to (count of tabs of w)
      set t to tab tIdx of w
      if (id of t) as string = tid then
        ${action}
        return
      end if
    end repeat
  end repeat
  error "Tab " & tid & " not found"`;
}

const idList = (ids: string[]) => `{${ids.map(asAS).join(", ")}}`;

export function buildGetTabsScript(browser: string, windowId?: string): string {
  // `properties of tabs of w` returns one record per tab in a single Apple event, so id/title/URL
  // can never be misaligned by a tab opening or closing mid-read.
  return tell(
    browser,
    `
  set fs to (ASCII character 31)
  set rs to (ASCII character 30)
  set recs to {}
  set skipped to 0
  repeat with wIdx from 1 to (count of windows)
    try
      set w to window wIdx
      set wID to (id of w) as string
      if ${windowId ? `wID = ${asAS(windowId)}` : "true"} then
        set wName to name of w
        set wMode to mode of w
        set actID to (id of active tab of w) as string
        set ps to properties of tabs of w
        repeat with i from 1 to (count of ps)
          set p to item i of ps
          set tID to (id of p) as string
          copy (wID & fs & wName & fs & wMode & fs & tID & fs & (tID = actID) & fs & (loading of p) & fs & (title of p) & fs & (URL of p)) to end of recs
        end repeat
      end if
    on error
      set skipped to skipped + 1
    end try
  end repeat
  set AppleScript's text item delimiters to rs
  return (skipped as string) & rs & (recs as string)`,
  );
}

function buildActiveTabScript(browser: string): string {
  return tell(
    browser,
    `
  if (count of windows) = 0 then return ""
  set w to window 1
  set t to active tab of w
  set fs to (ASCII character 31)
  return ((id of w) as string) & fs & ((id of t) as string) & fs & (loading of t) & fs & (title of t) & fs & (URL of t)`,
  );
}

const buildActivateScript = (browser: string, tabId: string) =>
  tell(
    browser,
    findTabScript(tabId, "set active tab index of w to tIdx\n set index of w to 1\n activate"),
  );

const buildTabCommandScript = (browser: string, tabId: string, command: string) =>
  tell(browser, findTabScript(tabId, `${command} t`));

export const buildNavigateScript = (browser: string, tabId: string, url: string) =>
  tell(browser, findTabScript(tabId, `set URL of t to ${asAS(url)}`));

const buildExecuteScript = (browser: string, tabId: string, javascript: string) =>
  tell(
    browser,
    findTabScript(
      tabId,
      [
        `set jsResult to execute t javascript ${asAS(javascript)}`,
        'if jsResult is missing value then return "null"',
        "return jsResult as string",
      ].join("\n        "),
    ),
  );

const buildCloseWindowScript = (browser: string, windowId: string) =>
  tell(browser, findWindowScript(windowId, "close w"));

const buildCreateWindowScript = (browser: string, mode: "normal" | "incognito") =>
  tell(
    browser,
    `
  set newWin to make new window with properties {mode: ${asAS(mode)}}
  return (id of newWin) as string`,
  );

// Closes every matching tab and returns "id FS title FS url" records (RS-separated) of what it
// actually closed, captured before closing so callers can offer an undo.
export function buildCloseTabsScript(browser: string, tabIds: string[]): string {
  return tell(
    browser,
    `
  set tids to ${idList(tabIds)}
  set fs to (ASCII character 31)
  set rs to (ASCII character 30)
  set closedRecs to {}
  repeat with wIdx from 1 to (count of windows)
    -- Guard: closing the last tab in a window auto-closes it, shrinking the list
    if wIdx > (count of windows) then exit repeat
    set w to window wIdx
    -- Backwards: closing tab N shifts indices N+1… down, never N-1…1
    repeat with tIdx from (count of tabs of w) to 1 by -1
      try
        set t to tab tIdx of w
        set tID to (id of t) as string
        if tID is in tids then
          set rec to tID & fs & (title of t) & fs & (URL of t)
          close t
          copy rec to end of closedRecs
        end if
      end try
    end repeat
  end repeat
  set AppleScript's text item delimiters to rs
  return closedRecs as string`,
  );
}

// Runs one command verb (reload, stop) on every matching tab.
export function buildBulkCommandScript(browser: string, tabIds: string[], command: string) {
  return tell(
    browser,
    `
  set tids to ${idList(tabIds)}
  repeat with wIdx from 1 to (count of windows)
    set w to window wIdx
    repeat with tIdx from 1 to (count of tabs of w)
      set t to tab tIdx of w
      if (id of t) as string is in tids then
        ${command} t
      end if
    end repeat
  end repeat`,
  );
}

export function buildOpenTabsScript(
  browser: string,
  urls: string[],
  windowId?: string,
  activate = false,
): string {
  const open = `
  set newIds to {}
  repeat with uRef in ${idList(urls)}
    set newTab to make new tab at end of tabs of w with properties {URL:(contents of uRef)}
    copy (id of newTab) as string to end of newIds
  end repeat
  ${activate ? "set active tab index of w to (count of tabs of w)\n  set index of w to 1\n  activate" : ""}
  set AppleScript's text item delimiters to ","
  return newIds as string`;
  return tell(
    browser,
    windowId
      ? findWindowScript(windowId, open)
      : `if (count of windows) = 0 then make new window\n  set w to window 1${open}`,
  );
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

const DIGITS = /^\d+$/;

// Output of buildGetTabsScript: "<skippedWindows>RS<rec>RS<rec>…". Records that don't have exactly
// 8 fields or numeric IDs (e.g. a title containing a separator char) are dropped, not trusted.
// Windows are ordered by ID (creation order), not z-order, so paging is stable when focus changes.
export function parseTabRecords(raw: string): { windows: ChromeWindow[]; skipped: number } {
  const [skippedRaw, ...records] = raw.replace(/\n$/, "").split(RECORD_SEP);
  const windows = new Map<string, ChromeWindow>();
  for (const record of records) {
    const f = record.split(FIELD_SEP);
    if (f.length !== 8 || !DIGITS.test(f[0]) || !DIGITS.test(f[3])) continue;
    const [windowId, windowName, mode, id, isActive, loading, title, url] = f;
    let w = windows.get(windowId);
    if (!w) windows.set(windowId, (w = { windowId, windowName, mode, tabs: [] }));
    w.tabs.push({
      id,
      windowId,
      title,
      url,
      isActive: isActive === "true",
      loading: loading === "true",
    });
  }
  return {
    windows: [...windows.values()].toSorted((a, b) => Number(a.windowId) - Number(b.windowId)),
    skipped: parseInt(skippedRaw, 10) || 0,
  };
}

function parseActiveTab(raw: string): ChromeTab | null {
  const f = raw.trim().split(FIELD_SEP);
  if (f.length !== 5) return null;
  const [windowId, id, loading, title, url] = f;
  return { id, windowId, title, url, isActive: true, loading: loading === "true" };
}

// ─── Execution ────────────────────────────────────────────────────────────────

const OSASCRIPT_TIMEOUT_MS = 30_000;

function runAppleScript(script: string, timeoutMs = OSASCRIPT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    log("INFO", `Executing AppleScript: ${script.trim().substring(0, 50)}...`);
    const proc = spawn("osascript", ["-"]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      log("ERROR", `AppleScript timed out after ${timeoutMs}ms`);
      reject(
        new Error(`osascript timed out after ${timeoutMs}ms (browser may be showing a dialog)`),
      );
    }, timeoutMs);
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        const err = stderr.trim() || `osascript exited with code ${code}`;
        log("ERROR", `AppleScript failed: ${err}`);
        reject(new Error(err));
      }
    });
    proc.stdin.write(script, "utf8");
    proc.stdin.end();
  });
}

// ─── Operations ───────────────────────────────────────────────────────────────

export async function getTabs(browser: string, windowId?: string) {
  const result = parseTabRecords(await runAppleScript(buildGetTabsScript(browser, windowId)));
  if (windowId && result.windows.length === 0) {
    // Header IDs and the old "Window N" indices look alike; list the valid IDs for the caller.
    const all = parseTabRecords(await runAppleScript(buildGetTabsScript(browser)));
    const valid = all.windows.map((w) => w.windowId).join(", ");
    throw new Error(`Window ${windowId} not found. Use an [ID: …] from get_tabs; valid: ${valid}`);
  }
  return result;
}

export async function getActiveTab(browser: string): Promise<ChromeTab | null> {
  return parseActiveTab(await runAppleScript(buildActiveTabScript(browser)));
}

export const activateTab = (b: string, id: string) => runAppleScript(buildActivateScript(b, id));
export const goBack = (b: string, id: string) =>
  runAppleScript(buildTabCommandScript(b, id, "go back"));
export const goForward = (b: string, id: string) =>
  runAppleScript(buildTabCommandScript(b, id, "go forward"));
export const navigateTab = (b: string, id: string, url: string) =>
  runAppleScript(buildNavigateScript(b, id, url));
export const closeWindow = (b: string, id: string) => runAppleScript(buildCloseWindowScript(b, id));
export const reloadTabs = (b: string, ids: string[]) =>
  runAppleScript(buildBulkCommandScript(b, ids, "reload"));
export const stopTabs = (b: string, ids: string[]) =>
  runAppleScript(buildBulkCommandScript(b, ids, "stop"));

// Chrome refuses execute javascript unless this View-menu setting is on; say how to fix it.
export const isJsDisabledError = (message: string) =>
  /turned off/i.test(message) && /JavaScript/i.test(message);

export function friendlyScriptError(message: string): string {
  return isJsDisabledError(message)
    ? "Chrome has JavaScript from Apple Events disabled. Enable it in Chrome: View > Developer > Allow JavaScript from Apple Events (per profile), then retry."
    : message;
}

// Raw: throws osascript's own error. Callers that want to react to the disabled-JS setting use this.
export async function executeScriptRaw(b: string, tabId: string, javascript: string) {
  return (await runAppleScript(buildExecuteScript(b, tabId, javascript))).trim();
}

export async function executeScript(b: string, tabId: string, javascript: string) {
  try {
    return await executeScriptRaw(b, tabId, javascript);
  } catch (error) {
    throw new Error(friendlyScriptError(error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
}

export type ClosedTab = Pick<ChromeTab, "id" | "title" | "url">;

export function parseClosedTabs(raw: string): ClosedTab[] {
  return raw
    .replace(/\n$/, "")
    .split(RECORD_SEP)
    .map((r) => r.split(FIELD_SEP))
    .filter((f) => f.length === 3 && DIGITS.test(f[0]))
    .map(([id, title, url]) => ({ id, title, url }));
}

export async function closeTabs(b: string, tabIds: string[]): Promise<ClosedTab[]> {
  return parseClosedTabs(await runAppleScript(buildCloseTabsScript(b, tabIds)));
}

export async function createWindow(b: string, mode: "normal" | "incognito"): Promise<string> {
  return (await runAppleScript(buildCreateWindowScript(b, mode))).trim();
}

export async function openTabs(b: string, urls: string[], windowId?: string, activate = false) {
  const out = await runAppleScript(buildOpenTabsScript(b, urls, windowId, activate));
  return out
    .trim()
    .split(",")
    .filter((id) => id.length > 0);
}
