# VisionDev — Cursor Marketplace plugin

This folder is the **Cursor plugin** half of VisionDev. The **MCP server** (`out/server.js`) ships inside the **[VisionDev VS Code extension](https://marketplace.visualstudio.com/items?itemName=SanidhyaThakur.visiondev)**.

## For users

1. Install **VisionDev** from the VS Code Marketplace (same ID as above).
2. In Cursor, open a folder and run **VisionDev: Connect MCP (Cursor + VS Code Copilot)**.
3. Reload Cursor. Install Chromium for Playwright once: `npx playwright install chromium`.

## For publishers (submit to Cursor Marketplace)

1. Push this repository to GitHub (default branch should include `cursor-plugin/` and `.cursor-plugin/marketplace.json`).
2. Open **[cursor.com/marketplace/publish](https://cursor.com/marketplace/publish)**.
3. Submit **`https://github.com/Rosh-codes/VisionDev`** (or your fork’s public URL).
4. Wait for Cursor’s review ([security & review](https://cursor.com/help/security-and-privacy/marketplace-security)).

Open source is required for community listings per [Cursor plugins docs](https://cursor.com/docs/plugins).
