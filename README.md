# VisionDev

Live visual + behavior debugging for AI coding assistants.

VisionDev gives Cursor, Claude Code, GitHub Copilot, and Codex a real Chromium browser they can drive while you watch. The agent reads the page, clicks, types, asserts — you see every step happen live, with action markers (click dots, fill highlights, motion trails) and a smooth in-editor video stream of the browser viewport.

Use plain English. The agent picks the right tools.

> "log into localhost:3000 with admin@nextcare.com / 123456, change my phone to 20202020, make sure it saves"

## Install

1. Install the extension from the VS Code / Cursor marketplace (or the bundled `.vsix`).
2. Run **VisionDev: Connect CLI to this workspace** from the command palette. This writes `.cursor/mcp.json` for you.
3. (Recommended) Run **VisionDev: Install Agent Guidance (AGENTS.md)** so Cursor uses VisionDev from plain-English prompts without you naming any tool.
4. Reload the Cursor window.

That's it. The first time you ask Cursor to verify a UI flow, Chromium will open, install if needed, and start driving itself.

## How it works

VisionDev exposes 8 MCP tools (stdio, no HTTP):

| Tool | Purpose |
| --- | --- |
| `vision_open(url, device)` | Launch Chromium, navigate, return numbered interactive elements |
| `vision_observe()` | Re-snapshot current page; returns IDs + visible toasts/alerts/errors |
| `vision_act(id, action, value?)` | Click / fill / press / hover / select / clear by element ID |
| `vision_navigate(url)` | Same browser, new URL |
| `vision_wait({kind, value})` | urlContains / textVisible / selectorVisible / ms |
| `vision_assert({kind, ...})` | textVisible / urlContains / errorVisible / toastVisible / elementValue / elementVisible |
| `vision_screenshot()` | Push a frame to the panel (no bytes returned to LLM) |
| `vision_close()` | Close the session |
| `vision_check` (legacy) | Compatibility wrapper for the old single-call API |

The browser stays open across tool calls, so subsequent actions are ~50-100ms each. Element IDs come from a real DOM scan (each interactive element is tagged `data-vd-id`) — the agent never guesses CSS selectors.

The panel mirrors the browser viewport at ~15fps via Chromium DevTools Protocol screencast. Frames go directly to the panel via local WebSocket — they never touch the LLM, so they don't cost any tokens.

## Why it's reliable

- **No CSS selectors**: agent picks elements by ID from a fresh observation
- **No empty-plan PASS**: every failure returns `failureType`, `nextAction`, and `evidence`
- **Persistent session**: one Chromium launch per debugging conversation
- **Element IDs invalidate explicitly** so the agent always re-observes after route changes
- **Action markers** in the live browser (green dot for clicks, blue for fills, motion trails) so you can follow what the agent is doing

## Commands

| Command | What it does |
| --- | --- |
| `VisionDev: Open Panel` | Show the activity panel and live browser mirror |
| `VisionDev: Connect CLI to this workspace` | Write `.cursor/mcp.json` pointing at the bundled MCP server |
| `VisionDev: Install Agent Guidance (AGENTS.md)` | Drop a primer into your repo so Cursor uses VisionDev from plain English |

## Manual MCP config (advanced)

If you'd rather wire it up by hand:

```json
{
  "mcpServers": {
    "visiondev": {
      "command": "node",
      "args": ["<absolute path to>/out/server.js"],
      "transport": "stdio",
      "env": { "VISIONDEV_WS_PORT": "51051" }
    }
  }
}
```

Same shape works in `.vscode/mcp.json` (Copilot), `~/.codex/config.toml` (Codex), and Claude Code.

## Costs

VisionDev itself is free and runs locally. Only LLM tokens consumed are the compact text snapshots returned by `vision_observe` (~50-100 tokens per element, ~2-5K per page). Frame streaming and action markers cost zero tokens.

## License

MIT
