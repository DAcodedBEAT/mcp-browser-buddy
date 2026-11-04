#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createRequire } from "node:module";
import * as chrome from "./applescript.ts";
import { ALLOWED_BROWSERS } from "./applescript.ts";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  TAB_LINE_LEGEND,
  countTabs,
  filterTabs,
  formatDuplicates,
  formatTabs,
  summarizeWindows,
  tabLine,
} from "./format.ts";

// Keep serverInfo in sync with the published package version (dist/ -> ../package.json)
const PKG_VERSION: string = createRequire(import.meta.url)("../package.json").version;

// ─── Shared schema pieces ─────────────────────────────────────────────────────

const browserField = z
  .enum(ALLOWED_BROWSERS)
  .default("Google Chrome")
  .describe(
    `Browser to control. One of: ${ALLOWED_BROWSERS.join(", ")}. Defaults to Google Chrome.`,
  );

const tabIdField = z
  .string()
  .regex(/^\d+$/, "Tab ID must be digits only")
  .describe("Numeric tab ID: the first token of each line in get_tabs / search_tabs output.");

const windowIdField = z
  .string()
  .regex(/^\d+$/)
  .describe("Window ID: the `[ID: …]` in a window header of get_tabs output.");

const paging = {
  windowId: windowIdField.optional().describe("Only include tabs in this window."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Max tabs to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  offset: z.number().int().min(0).default(0).describe("Tabs to skip, for paging."),
};

const tabIdsField = z.array(tabIdField).min(1).describe("List of Tab IDs to operate on.");

// ─── Tool plumbing ────────────────────────────────────────────────────────────

// Explicit values: MCP defaults destructiveHint/openWorldHint to true when omitted.
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE = { ...WRITE, destructiveHint: true };

const text = (s: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: s }],
  ...(isError && { isError }),
});

const server = new McpServer({ name: "mcp-browser-buddy", version: PKG_VERSION });

// Adding a tool = one registerTool call: schema, annotations and handler live together.
function tool<S extends z.ZodRawShape>(
  name: string,
  title: string,
  description: string,
  annotations: typeof READ,
  inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: inputSchema as z.ZodRawShape,
      annotations: { title, ...annotations },
    },
    async (args: Record<string, unknown>) => {
      try {
        return text(await handler(args as z.infer<z.ZodObject<S>>));
      } catch (error) {
        return text(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );
}

// ─── Tools ────────────────────────────────────────────────────────────────────

tool(
  "get_tabs",
  "Get Tabs",
  "List open tabs grouped by window, one line each (Tab ID first). Paged. With many tabs, call with summary=true first, then drill into a window with windowId.",
  READ,
  {
    summary: z
      .boolean()
      .default(false)
      .describe(
        "If true, return one block per window (id, tab count, active tab, top domains) instead of every tab.",
      ),
    ...paging,
    browser: browserField,
  },
  async ({ browser, windowId, summary, limit, offset }) => {
    const { windows, skipped } = await chrome.getTabs(browser, windowId);
    const head = `${countTabs(windows)} tab(s) in ${windows.length} window(s) of ${browser}.`;
    const warn = skipped ? ` (${skipped} window(s) could not be read and were skipped)` : "";
    const body = summary ? summarizeWindows(windows) : formatTabs(windows, limit, offset);
    return `${head}${warn}\n${TAB_LINE_LEGEND}\n\n${body}`;
  },
);

tool(
  "search_tabs",
  "Search Tabs",
  "Find tabs whose title or URL contains every word of the query (case-insensitive). Paged; same line format as get_tabs.",
  READ,
  {
    query: z.string().describe("Words to search for in tab titles and URLs; all must match."),
    ...paging,
    browser: browserField,
  },
  async ({ browser, query, windowId, limit, offset }) => {
    const { windows } = await chrome.getTabs(browser, windowId);
    const matched = filterTabs(windows, query);
    return `Found ${countTabs(matched)} tab(s) matching "${query}".\n${TAB_LINE_LEGEND}\n\n${formatTabs(matched, limit, offset, "matching tab")}`;
  },
);

tool(
  "find_duplicates",
  "Find Duplicate Tabs",
  "Group tabs that have the same URL (ignoring #fragment and trailing slash). Cheaper than listing every tab; follow with close_tabs on the redundant IDs.",
  READ,
  {
    windowId: windowIdField.optional().describe("Only look in this window."),
    browser: browserField,
  },
  async ({ browser, windowId }) =>
    formatDuplicates((await chrome.getTabs(browser, windowId)).windows),
);

tool(
  "get_active_tab",
  "Get Active Tab",
  "Get details about the currently focused tab in the frontmost window.",
  READ,
  { browser: browserField },
  async ({ browser }) => {
    const tab = await chrome.getActiveTab(browser);
    return tab
      ? `Active tab in frontmost window:\n${tabLine(tab)}\n[Window ID: ${tab.windowId}]`
      : "No active window found.";
  },
);

tool(
  "open_tabs",
  "Open Tabs",
  "Open one or more URLs in new tabs.",
  { ...WRITE, openWorldHint: true },
  {
    urls: z.array(z.string().url()).min(1).describe("List of fully-qualified URLs to open."),
    windowId: windowIdField
      .optional()
      .describe("Window to open the tabs in. Omit to use the frontmost window."),
    activate: z
      .boolean()
      .default(false)
      .describe("If true, focus the last opened tab and bring its window to the front."),
    browser: browserField,
  },
  async ({ browser, urls, windowId, activate }) => {
    const ids = await chrome.openTabs(browser, urls, windowId, activate);
    return `Opened ${ids.length} tab(s). New Tab IDs: ${ids.join(", ")}`;
  },
);

tool(
  "close_tabs",
  "Close Tabs",
  "Permanently close one or more tabs by Tab ID. Reports any IDs that were not found (e.g. stale after a listing).",
  DESTRUCTIVE,
  { tabIds: tabIdsField, browser: browserField },
  async ({ browser, tabIds }) => {
    const closed = await chrome.closeTabs(browser, tabIds);
    const missing = tabIds.filter((id) => !closed.includes(id));
    return `Closed ${closed.length} tab(s).${missing.length ? ` Not found: ${missing.join(", ")}` : ""}`;
  },
);

tool(
  "close_window",
  "Close Window",
  "Close an entire window and all its tabs.",
  DESTRUCTIVE,
  { windowId: windowIdField, browser: browserField },
  async ({ browser, windowId }) => {
    await chrome.closeWindow(browser, windowId);
    return `Closed window [ID: ${windowId}]`;
  },
);

tool(
  "create_window",
  "Create Window",
  "Open a new browser window, optionally in incognito mode.",
  WRITE,
  {
    mode: z
      .enum(["normal", "incognito"])
      .default("normal")
      .describe('Window mode: "normal" or "incognito".'),
    browser: browserField,
  },
  async ({ browser, mode }) =>
    `Created ${mode} window [ID: ${await chrome.createWindow(browser, mode)}]`,
);

tool(
  "activate_tab",
  "Activate Tab",
  "Bring a tab into focus.",
  { ...WRITE, idempotentHint: true },
  { tabId: tabIdField, browser: browserField },
  async ({ browser, tabId }) => {
    await chrome.activateTab(browser, tabId);
    return `Activated tab [Tab ID: ${tabId}]`;
  },
);

// Reload can resubmit a POST or drop unsaved form input, so it is not a harmless read.
tool(
  "reload_tabs",
  "Reload Tabs",
  "Reload one or more tabs by Tab ID.",
  { ...DESTRUCTIVE, idempotentHint: true },
  { tabIds: tabIdsField, browser: browserField },
  async ({ browser, tabIds }) => {
    await chrome.reloadTabs(browser, tabIds);
    return `Reloaded ${tabIds.length} tab(s).`;
  },
);

tool(
  "stop_tabs",
  "Stop Tabs",
  "Stop loading one or more tabs by Tab ID.",
  { ...WRITE, idempotentHint: true },
  { tabIds: tabIdsField, browser: browserField },
  async ({ browser, tabIds }) => {
    await chrome.stopTabs(browser, tabIds);
    return `Stopped ${tabIds.length} tab(s).`;
  },
);

tool(
  "go_back",
  "Go Back",
  "Navigate back in the tab's history.",
  WRITE,
  { tabId: tabIdField, browser: browserField },
  async ({ browser, tabId }) => {
    await chrome.goBack(browser, tabId);
    return `Navigated back in tab [Tab ID: ${tabId}]`;
  },
);

tool(
  "go_forward",
  "Go Forward",
  "Navigate forward in the tab's history.",
  WRITE,
  { tabId: tabIdField, browser: browserField },
  async ({ browser, tabId }) => {
    await chrome.goForward(browser, tabId);
    return `Navigated forward in tab [Tab ID: ${tabId}]`;
  },
);

tool(
  "navigate_tab",
  "Navigate Tab",
  "Change the URL of an existing tab.",
  { ...DESTRUCTIVE, openWorldHint: true },
  {
    tabId: tabIdField,
    url: z
      .string()
      .url()
      .describe("Fully-qualified URL to navigate the tab to, e.g. https://example.com"),
    browser: browserField,
  },
  async ({ browser, tabId, url }) => {
    await chrome.navigateTab(browser, tabId, url);
    return `Navigated tab [Tab ID: ${tabId}] to ${url}`;
  },
);

tool(
  "execute_script",
  "Execute Script",
  "Run JavaScript in a tab's page context.",
  { ...DESTRUCTIVE, openWorldHint: true },
  {
    tabId: tabIdField,
    javascript: z
      .string()
      .describe(
        'JavaScript expression or statement(s) to run in the tab\'s page context. The return value is coerced to string via AppleScript. Returns "null" if the result is undefined or null. For complex return types (arrays, objects), wrap in JSON.stringify(...) to get valid JSON back.',
      ),
    browser: browserField,
  },
  async ({ browser, tabId, javascript }) => chrome.executeScript(browser, tabId, javascript),
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error("mcp-browser-buddy running on stdio");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
