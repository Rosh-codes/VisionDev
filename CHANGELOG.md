# Changelog

## 0.2.0

- Refactored to a persistent browser session with granular MCP tools (`vision_open`, `vision_observe`, `vision_act`, `vision_navigate`, `vision_wait`, `vision_assert`, `vision_screenshot`, `vision_close`).
- Element targeting now uses numeric IDs from a real DOM scan instead of CSS selectors.
- CDP screencast streams the browser viewport to the panel at ~15fps without consuming LLM tokens.
- Added `VisionDev: Connect CLI to this workspace` command (auto-writes `.cursor/mcp.json`).
- Added `VisionDev: Install Agent Guidance (AGENTS.md)` command so plain-English prompts work without naming tools.
- Tool descriptions rewritten to make the agent reach for VisionDev automatically on UI/browser tasks.
- Kept `vision_check` as a legacy compatibility wrapper.

## 0.0.1

- Initial single-tool `vision_check` with one-shot Playwright runs.
