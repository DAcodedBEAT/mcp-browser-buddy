# MCP Browser Buddy

Model Context Protocol server for retrieving and managing Chrome browser tabs information. This allows Claude Desktop (or any MCP client) to fetch information about and control currently open Chrome tabs.

<a href="https://glama.ai/mcp/servers/wze1kc6emp"><img width="380" height="200" src="https://glama.ai/mcp/servers/wze1kc6emp/badge" alt="Browser Tabs Server MCP server" /></a>

## Quick Start (For Users)

To use this tool with Claude Desktop, simply add the following to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "tools": {
    "browser-buddy": {
      "command": "npx",
      "args": ["-y", "@dacodedbeat/mcp-browser-buddy"]
    }
  }
}
```

This will automatically download and run the latest version of the tool when needed.

### Required Setup

1. Enable Accessibility for Chrome:
   - Open System Settings
   - Go to Privacy & Security > Accessibility
   - Click the "+" button
   - Add Google Chrome from your Applications folder
   - Turn ON the toggle for Chrome

This accessibility setting is required for AppleScript to interact with Chrome tabs.

## For Developers

The following sections are for those who want to develop or modify the tool.

### Prerequisites

- Node.js 18+
- macOS (for AppleScript operations)
- Google Chrome
- Claude Desktop (install from https://claude.ai/desktop)
- tsx (install via `npm install -g tsx`)

### Installation

```bash
git clone https://github.com/dacodedbeat/mcp-browser-buddy.git
cd mcp-browser-buddy
npm install
npm run build
```

## Security Considerations

**This server provides powerful capabilities that give an LLM control over your web browser.**

By using this server, you are granting the connected LLM agent the ability to:

- Read the content of all open browser tabs.
- Navigate to arbitrary URLs.
- Execute arbitrary JavaScript in the context of any page you have open.
- Close tabs and windows.

These capabilities are necessary for the server's function but present security risks if connected to an untrusted or compromised LLM agent.

**Recommendation:** Only use this server with trusted LLM clients and be aware of what pages you have open. Do not use this server in environments where sensitive, non-public data is frequently accessed in your browser tabs.

## Available Tools

- `get_tabs`: List every open tab across all windows.
- `search_tabs`: Search for tabs by keyword in title or URL.
- `get_active_tab`: Get details about the currently focused tab in the frontmost window.
- `open_tabs`: Open one or more URLs in new tabs.
- `close_tabs`: Permanently close one or more tabs by Tab ID.
- `close_window`: Close an entire window and all its tabs.
- `create_window`: Open a new browser window, optionally in incognito mode.
- `activate_tab`: Bring a tab into focus.
- `reload_tabs`: Reload one or more tabs by Tab ID.
- `stop_tabs`: Stop loading one or more tabs by Tab ID.
- `go_back`: Navigate back in the tab's history.
- `go_forward`: Navigate forward in the tab's history.
- `navigate_tab`: Change the URL of an existing tab.
- `execute_script`: Run JavaScript in a tab's page context.

## Schema Stability

This project adheres to strict schema evolution rules to ensure reliability for all connected MCP clients:

1. **Breaking Changes**: Any change to tool definitions that breaks existing consumers (e.g., changing parameter names, removing parameters, changing types, or altering a tool's primary purpose) is treated as a major change.
2. **Versioning**: We follow [Semantic Versioning (SemVer)](https://semver.org/):
   - **MAJOR**: Breaking changes to the schema.
   - **MINOR**: Adding new tools or extending parameters in a non-breaking way (e.g., adding an optional parameter).
   - **PATCH**: Internal refactoring, performance improvements, or bug fixes that do not affect the tool schema.
3. **Compatibility**: We prioritize maintaining backward compatibility. Changes to tool definitions are designed to ensure existing automation flows remain functional.

## Notes

- This tool is designed for **macOS only** due to its dependency on AppleScript.
- Requires **Google Chrome** (or a compatible browser like Brave or Chromium) to be installed and running.
- **Accessibility permissions** must be granted for the browser in System Settings for the tool to function.

## License

MIT License - see the [LICENSE](LICENSE) file for details
