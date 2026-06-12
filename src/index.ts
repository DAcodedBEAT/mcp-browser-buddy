#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// Keep serverInfo in sync with the published package version (dist/ -> ../package.json)
const PKG_VERSION: string = createRequire(import.meta.url)("../package.json").version;

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_BROWSERS = [
  "Google Chrome",
  "Brave Browser",
  "Chromium",
  "Google Chrome Canary",
] as const;

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(level: "INFO" | "WARN" | "ERROR", message: string) {
  const timestamp = new Date().toISOString();
  process.stderr.write(`[${timestamp}] [${level}] ${message}\n`);
}

// ASCII control chars — never appear in URLs or page titles
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

// ─── AppleScript helpers ──────────────────────────────────────────────────────

// Safe AppleScript string literal from arbitrary JS string — no shell quoting needed
function asAS(value: string): string {
  if (value === "") return '""';
  const tokens: string[] = [];
  let buf = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '"') {
      if (buf) {
        tokens.push(`"${buf}"`);
        buf = "";
      }
      tokens.push("quote");
    } else if (code < 32 || code === 127) {
      if (buf) {
        tokens.push(`"${buf}"`);
        buf = "";
      }
      tokens.push(`(ASCII character ${code})`);
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(`"${buf}"`);
  return tokens.length > 0 ? tokens.join(" & ") : '""';
}

function runAppleScript(script: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    log("INFO", `Executing AppleScript: ${script.substring(0, 50)}...`);
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

// AppleScript body: find tab by ID across all windows, run `action`, error if not found.
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChromeTab {
  id: string;
  windowId: string;
  title: string;
  url: string;
  isActive: boolean;
  loading: boolean;
  windowIndex: number;
  tabIndex: number;
}

interface ChromeWindow {
  windowId: string;
  windowIndex: number;
  windowName: string;
  mode: string; // "normal" | "incognito"
  tabs: ChromeTab[];
}

// ─── AppleScript operations ───────────────────────────────────────────────────

async function getTabs(browser: string): Promise<ChromeWindow[]> {
  const script = `
tell application "${browser}"
  set fs to (ASCII character 31)
  set rs to (ASCII character 30)
  set output to ""
  set winCount to count of windows
  repeat with wIdx from 1 to winCount
    set w to window wIdx
    set wID to id of w
    set wName to name of w
    set wMode to mode of w
    set activeIdx to active tab index of w
    set tabCount to count of tabs of w
    repeat with tIdx from 1 to tabCount
      set t to tab tIdx of w
      set tID to (id of t) as string
      set isActive to (tIdx = activeIdx)
      set isLoading to loading of t
      set output to output & wID & fs & wIdx & fs & wName & fs & wMode & fs & tID & fs & tIdx & fs & isActive & fs & isLoading & fs & (title of t) & fs & (URL of t) & rs
    end repeat
  end repeat
  return output
end tell
`;
  const raw = await runAppleScript(script);
  const records = raw.split(RECORD_SEP).filter((r) => r.length > 0);
  const windowMap = new Map<string, ChromeWindow>();
  for (const record of records) {
    const [wId, wIdx, wName, wMode, tId, tIdx, isActive, isLoading, title, url] =
      record.split(FIELD_SEP);
    if (!windowMap.has(wId)) {
      windowMap.set(wId, {
        windowId: wId,
        windowIndex: parseInt(wIdx, 10),
        windowName: wName ?? "",
        mode: wMode ?? "normal",
        tabs: [],
      });
    }
    windowMap.get(wId)!.tabs.push({
      id: tId,
      windowId: wId,
      title: title ?? "",
      url: url ?? "",
      isActive: isActive === "true",
      loading: isLoading === "true",
      windowIndex: parseInt(wIdx, 10),
      tabIndex: parseInt(tIdx, 10),
    });
  }
  return Array.from(windowMap.values());
}

async function getActiveTab(browser: string): Promise<ChromeTab | null> {
  const script = `
tell application "${browser}"
  if (count of windows) = 0 then return ""
  set w to window 1
  set wID to id of w
  set wIdx to index of w
  set t to active tab of w
  set tID to (id of t) as string
  set tIdx to active tab index of w
  set fs to (ASCII character 31)
  return wID & fs & wIdx & fs & tID & fs & tIdx & fs & (loading of t) & fs & (title of t) & fs & (URL of t)
end tell
`;
  const raw = await runAppleScript(script);
  if (!raw.trim()) return null;
  const [wId, wIdx, tId, tIdx, isLoading, title, url] = raw.trim().split(FIELD_SEP);
  return {
    id: tId,
    windowId: wId,
    title: title ?? "",
    url: url ?? "",
    isActive: true,
    loading: isLoading === "true",
    windowIndex: parseInt(wIdx, 10),
    tabIndex: parseInt(tIdx, 10),
  };
}

async function activateTab(browser: string, tabId: string): Promise<void> {
  const action = ["set active tab index of w to tIdx", "set index of w to 1", "activate"].join(
    "\n        ",
  );
  await runAppleScript(`tell application "${browser}"\n${findTabScript(tabId, action)}\nend tell`);
}

async function goBack(browser: string, tabId: string): Promise<void> {
  await runAppleScript(
    `tell application "${browser}"\n${findTabScript(tabId, "go back t")}\nend tell`,
  );
}

async function goForward(browser: string, tabId: string): Promise<void> {
  await runAppleScript(
    `tell application "${browser}"\n${findTabScript(tabId, "go forward t")}\nend tell`,
  );
}

async function navigateTab(browser: string, tabId: string, url: string): Promise<void> {
  await runAppleScript(
    `tell application "${browser}"\n${findTabScript(tabId, `set URL of t to ${asAS(url)}`)}\nend tell`,
  );
}

async function executeScript(browser: string, tabId: string, javascript: string): Promise<string> {
  const action = [
    `set jsCode to ${asAS(javascript)}`,
    "set jsResult to execute t javascript jsCode",
    "if jsResult is missing value then",
    '  return "null"',
    "end if",
    "return jsResult as string",
  ].join("\n        ");
  const result = await runAppleScript(
    `tell application "${browser}"\n${findTabScript(tabId, action)}\nend tell`,
  );
  return result.trim();
}

async function closeTabs(browser: string, tabIds: string[]): Promise<{ count: number }> {
  const script = `
tell application "${browser}"
  set tids to {${tabIds.map(asAS).join(", ")}}
  set closedCount to 0
  set winCount to count of windows
  repeat with wIdx from 1 to winCount
    -- Guard: closing the last tab in a window auto-closes it, shrinking the list
    if wIdx > (count of windows) then exit repeat
    set w to window wIdx
    set tabCount to count of tabs of w
    -- Backwards: closing tab N shifts indices N+1… down, never N-1…1
    repeat with tIdx from tabCount to 1 by -1
      try
        set t to tab tIdx of w
        if (id of t) as string is in tids then
          close t
          set closedCount to closedCount + 1
        end if
      end try
    end repeat
  end repeat
  return closedCount
end tell
`;
  const result = await runAppleScript(script);
  return { count: parseInt(result.trim(), 10) || 0 };
}

async function closeWindow(browser: string, windowId: string): Promise<void> {
  await runAppleScript(`
tell application "${browser}"
  set wid to ${asAS(windowId)}
  repeat with i from 1 to (count of windows)
    set w to window i
    if (id of w) as string = wid then
      close w
      return
    end if
  end repeat
  error "Window " & wid & " not found"
end tell`);
}

// Runs a single AppleScript command verb on all tabs matching the given IDs
async function bulkTabCommand(browser: string, tabIds: string[], command: string): Promise<void> {
  await runAppleScript(`
tell application "${browser}"
  set tids to {${tabIds.map(asAS).join(", ")}}
  repeat with wIdx from 1 to (count of windows)
    set w to window wIdx
    repeat with tIdx from 1 to (count of tabs of w)
      set t to tab tIdx of w
      if (id of t) as string is in tids then
        ${command} t
      end if
    end repeat
  end repeat
end tell`);
}

const reloadTabs = (b: string, ids: string[]) => bulkTabCommand(b, ids, "reload");
const stopTabs = (b: string, ids: string[]) => bulkTabCommand(b, ids, "stop");

async function createWindow(browser: string, mode: "normal" | "incognito"): Promise<string> {
  const result = await runAppleScript(`
tell application "${browser}"
  set newWin to make new window with properties {mode: ${asAS(mode)}}
  return (id of newWin) as string
end tell`);
  return result.trim();
}

async function openTabs(
  browser: string,
  urls: string[],
  windowId?: string,
  activate = false,
): Promise<string[]> {
  const windowSetup = windowId
    ? `set wid to ${asAS(windowId)}
  repeat with i from 1 to (count of windows)
    set w to window i
    if (id of w) as string = wid then
      set targetWin to w
      exit repeat
    end if
  end repeat
  if targetWin is missing value then error "Window " & wid & " not found"`
    : `if (count of windows) = 0 then make new window
  set targetWin to window 1`;

  const activateBlock = activate
    ? `set active tab index of targetWin to (count of tabs of targetWin)
  set index of targetWin to 1
  activate`
    : "";

  const result = await runAppleScript(`
tell application "${browser}"
  set targetWin to missing value
  ${windowSetup}
  set newIds to {}
  repeat with uRef in {${urls.map(asAS).join(", ")}}
    set u to contents of uRef
    set newTab to make new tab at end of tabs of targetWin with properties {URL:u}
    copy (id of newTab) as string to end of newIds
  end repeat
  ${activateBlock}
  set AppleScript's text item delimiters to ","
  return newIds as string
end tell`);

  return result
    .trim()
    .split(",")
    .filter((id) => id.length > 0);
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const BrowserParam = z
  .enum(ALLOWED_BROWSERS)
  .default("Google Chrome")
  .describe(
    'Browser to control. One of: "Google Chrome", "Brave Browser", "Chromium", "Google Chrome Canary". Defaults to "Google Chrome".',
  );

const TabIdParam = z
  .string()
  .regex(/^\d+$/, "Tab ID must be digits only")
  .describe(
    "Unique numeric string identifying a tab. Extract from [Tab ID: XXXXX] in get_tabs output, or from the tabs_json block.",
  );

const TabIdSchema = z.object({ tabId: TabIdParam, browser: BrowserParam });

const BulkTabSchema = z.object({
  tabIds: z.array(TabIdParam).min(1).describe("List of Tab IDs to operate on."),
  browser: BrowserParam,
});

const WindowIdParam = z
  .string()
  .regex(/^\d+$/)
  .describe("Window ID. Get from tabs_json in get_tabs output.");

const CloseWindowSchema = z.object({ windowId: WindowIdParam, browser: BrowserParam });

const OpenTabsSchema = z.object({
  urls: z.array(z.string().url()).min(1).describe("List of fully-qualified URLs to open."),
  windowId: WindowIdParam.optional().describe(
    "Window ID to open the tabs in. Omit to use the frontmost window.",
  ),
  activate: z
    .boolean()
    .default(false)
    .describe("If true, focus the last opened tab and bring its window to the front."),
  browser: BrowserParam,
});

const CreateWindowSchema = z.object({
  mode: z
    .enum(["normal", "incognito"])
    .default("normal")
    .describe('Window mode: "normal" or "incognito".'),
  browser: BrowserParam,
});

const NavigateTabSchema = z.object({
  tabId: TabIdParam,
  url: z
    .string()
    .url()
    .describe("Fully-qualified URL to navigate the tab to, e.g. https://example.com"),
  browser: BrowserParam,
});

const ExecuteScriptSchema = z.object({
  tabId: TabIdParam,
  javascript: z
    .string()
    .describe(
      'JavaScript expression or statement(s) to run in the tab\'s page context. The return value is coerced to string via AppleScript. Returns "null" if the result is undefined or null. For complex return types (arrays, objects), wrap in JSON.stringify(...) to get valid JSON back.',
    ),
  browser: BrowserParam,
});

const SearchTabsSchema = z.object({
  query: z.string().describe("Keyword to search for in tab titles and URLs."),
  browser: BrowserParam,
});

const GetTabsSchema = z.object({ browser: BrowserParam });

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "mcp-browser-buddy", version: PKG_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_tabs",
      description: "List every open tab across all windows.",
      inputSchema: z.toJSONSchema(GetTabsSchema),
      annotations: {
        title: "Get Tabs",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "search_tabs",
      description: "Search for tabs by keyword in title or URL.",
      inputSchema: z.toJSONSchema(SearchTabsSchema),
      annotations: {
        title: "Search Tabs",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "get_active_tab",
      description: "Get details about the currently focused tab in the frontmost window.",
      inputSchema: z.toJSONSchema(GetTabsSchema),
      annotations: {
        title: "Get Active Tab",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "open_tabs",
      description: "Open one or more URLs in new tabs.",
      inputSchema: z.toJSONSchema(OpenTabsSchema),
      annotations: {
        title: "Open Tabs",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: "close_tabs",
      description: "Permanently close one or more tabs by Tab ID.",
      inputSchema: z.toJSONSchema(BulkTabSchema),
      annotations: {
        title: "Close Tabs",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "close_window",
      description: "Close an entire window and all its tabs.",
      inputSchema: z.toJSONSchema(CloseWindowSchema),
      annotations: {
        title: "Close Window",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "create_window",
      description: "Open a new browser window, optionally in incognito mode.",
      inputSchema: z.toJSONSchema(CreateWindowSchema),
      annotations: {
        title: "Create Window",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "activate_tab",
      description: "Bring a tab into focus.",
      inputSchema: z.toJSONSchema(TabIdSchema),
      annotations: {
        title: "Activate Tab",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "reload_tabs",
      description: "Reload one or more tabs by Tab ID.",
      inputSchema: z.toJSONSchema(BulkTabSchema),
      annotations: {
        title: "Reload Tabs",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "stop_tabs",
      description: "Stop loading one or more tabs by Tab ID.",
      inputSchema: z.toJSONSchema(BulkTabSchema),
      annotations: {
        title: "Stop Tabs",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "go_back",
      description: "Navigate back in the tab's history.",
      inputSchema: z.toJSONSchema(TabIdSchema),
      annotations: {
        title: "Go Back",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "go_forward",
      description: "Navigate forward in the tab's history.",
      inputSchema: z.toJSONSchema(TabIdSchema),
      annotations: {
        title: "Go Forward",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "navigate_tab",
      description: "Change the URL of an existing tab.",
      inputSchema: z.toJSONSchema(NavigateTabSchema),
      annotations: {
        title: "Navigate Tab",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: "execute_script",
      description: "Run JavaScript in a tab's page context.",
      inputSchema: z.toJSONSchema(ExecuteScriptSchema),
      annotations: {
        title: "Execute Script",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args = {} } = request.params;

    if (name === "get_tabs") {
      const { browser } = GetTabsSchema.parse(args);
      const windows = await getTabs(browser);
      const totalTabs = windows.reduce((n, w) => n + w.tabs.length, 0);
      const humanReadable = windows
        .map((w) => {
          const incognito = w.mode === "incognito" ? " [incognito]" : "";
          const nameStr = w.windowName ? ` (${w.windowName})` : "";
          const header = `Window ${w.windowIndex}${nameStr}${incognito} [ID: ${w.windowId}]:`;
          const tabLines = w.tabs
            .map((t) => {
              const active = t.isActive ? " ★" : "";
              const loading = t.loading ? " [loading]" : "";
              return [
                `  ${w.windowIndex}-${t.tabIndex}.${active} ${t.title}${loading}`,
                `     ${t.url}`,
                `     [Tab ID: ${t.id}]`,
              ].join("\n");
            })
            .join("\n");
          return `${header}\n${tabLines}`;
        })
        .join("\n\n");
      const tabsJson = windows.flatMap((w) =>
        w.tabs.map((t) => ({
          tabId: t.id,
          windowId: w.windowId,
          windowIndex: w.windowIndex,
          windowName: w.windowName,
          tabIndex: t.tabIndex,
          windowMode: w.mode,
          title: t.title,
          url: t.url,
          active: t.isActive,
          loading: t.loading,
        })),
      );
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${totalTabs} tab(s) open in ${browser}:`,
              "",
              humanReadable,
              "",
              "---",
              "Use tabId from tabs_json for all tab operations.",
              "<tabs_json>",
              JSON.stringify(tabsJson, null, 2),
              "</tabs_json>",
            ].join("\n"),
          },
        ],
      };
    }

    if (name === "search_tabs") {
      const { query, browser } = SearchTabsSchema.parse(args);
      const windows = await getTabs(browser);
      const q = query.toLowerCase();
      const results = windows
        .flatMap((w) => w.tabs.map((t) => ({ ...t, windowName: w.windowName, windowMode: w.mode })))
        .filter((t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Found ${results.length} tab(s) matching "${query}":`,
              "",
              results
                .map((t) => `  - ${t.title}\n     ${t.url}\n     [Tab ID: ${t.id}]`)
                .join("\n\n"),
              "",
              "<tabs_json>",
              JSON.stringify(results, null, 2),
              "</tabs_json>",
            ].join("\n"),
          },
        ],
      };
    }

    if (name === "get_active_tab") {
      const { browser } = GetTabsSchema.parse(args);
      const tab = await getActiveTab(browser);
      if (!tab) return { content: [{ type: "text" as const, text: "No active window found." }] };
      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Active tab in frontmost window:",
              `  ${tab.title}`,
              `  ${tab.url}`,
              `  [Tab ID: ${tab.id}] [Window ID: ${tab.windowId}]`,
              "",
              "<tabs_json>",
              JSON.stringify([tab], null, 2),
              "</tabs_json>",
            ].join("\n"),
          },
        ],
      };
    }

    if (name === "open_tabs") {
      const { urls, windowId, activate, browser } = OpenTabsSchema.parse(args);
      const newTabIds = await openTabs(browser, urls, windowId, activate);
      return {
        content: [
          {
            type: "text" as const,
            text: `Opened ${newTabIds.length} tab(s). New Tab IDs: ${newTabIds.join(", ")}`,
          },
        ],
      };
    }

    if (name === "close_tabs") {
      const { tabIds, browser } = BulkTabSchema.parse(args);
      const { count } = await closeTabs(browser, tabIds);
      return { content: [{ type: "text" as const, text: `Closed ${count} tab(s).` }] };
    }

    if (name === "close_window") {
      const { windowId, browser } = CloseWindowSchema.parse(args);
      await closeWindow(browser, windowId);
      return { content: [{ type: "text" as const, text: `Closed window [ID: ${windowId}]` }] };
    }

    if (name === "create_window") {
      const { mode, browser } = CreateWindowSchema.parse(args);
      const windowId = await createWindow(browser, mode);
      return {
        content: [{ type: "text" as const, text: `Created ${mode} window [ID: ${windowId}]` }],
      };
    }

    if (name === "activate_tab") {
      const { tabId, browser } = TabIdSchema.parse(args);
      await activateTab(browser, tabId);
      return { content: [{ type: "text" as const, text: `Activated tab [Tab ID: ${tabId}]` }] };
    }

    if (name === "reload_tabs") {
      const { tabIds, browser } = BulkTabSchema.parse(args);
      await reloadTabs(browser, tabIds);
      return { content: [{ type: "text" as const, text: `Reloaded ${tabIds.length} tab(s).` }] };
    }

    if (name === "stop_tabs") {
      const { tabIds, browser } = BulkTabSchema.parse(args);
      await stopTabs(browser, tabIds);
      return { content: [{ type: "text" as const, text: `Stopped ${tabIds.length} tab(s).` }] };
    }

    if (name === "go_back") {
      const { tabId, browser } = TabIdSchema.parse(args);
      await goBack(browser, tabId);
      return {
        content: [{ type: "text" as const, text: `Navigated back in tab [Tab ID: ${tabId}]` }],
      };
    }

    if (name === "go_forward") {
      const { tabId, browser } = TabIdSchema.parse(args);
      await goForward(browser, tabId);
      return {
        content: [{ type: "text" as const, text: `Navigated forward in tab [Tab ID: ${tabId}]` }],
      };
    }

    if (name === "navigate_tab") {
      const { tabId, url, browser } = NavigateTabSchema.parse(args);
      await navigateTab(browser, tabId, url);
      return {
        content: [{ type: "text" as const, text: `Navigated tab [Tab ID: ${tabId}] to ${url}` }],
      };
    }

    if (name === "execute_script") {
      const { tabId, javascript, browser } = ExecuteScriptSchema.parse(args);
      const result = await executeScript(browser, tabId, javascript);
      return { content: [{ type: "text" as const, text: result }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-browser-buddy running on stdio");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
