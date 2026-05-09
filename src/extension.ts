import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import WebSocket, { WebSocketServer } from "ws";
import { type VisionFrameEvent, type VisionLogEvent, type VisionStatusEvent } from "./bridge";

const WS_PORT = 51051;

type PanelEvent = VisionFrameEvent | VisionStatusEvent | VisionLogEvent;

let statusBarItem: vscode.StatusBarItem | undefined;
let wsServer: WebSocketServer | undefined;
let cliSocket: WebSocket | undefined;
let activePanel: vscode.WebviewPanel | undefined;

function getPanelHtml(context: vscode.ExtensionContext): string {
  const htmlPath = path.join(context.extensionPath, "src", "panel.html");
  if (fs.existsSync(htmlPath)) {
    return fs.readFileSync(htmlPath, "utf8");
  }
  // When packaged via vsce, src/ may be excluded; fallback to bundled copy in out/
  const fallback = path.join(context.extensionPath, "out", "panel.html");
  return fs.readFileSync(fallback, "utf8");
}

function setIdleStatus(): void {
  if (!statusBarItem) return;
  statusBarItem.text = "$(eye) VisionDev: Ready";
  statusBarItem.tooltip = "Click to open the VisionDev panel";
  statusBarItem.command = "visiondev.start";
}

function setRunningStatus(): void {
  if (!statusBarItem) return;
  statusBarItem.text = "$(sync~spin) VisionDev: Running";
}

function setResultStatus(state: "PASS" | "FAIL"): void {
  if (!statusBarItem) return;
  const icon = state === "PASS" ? "$(pass-filled)" : "$(error)";
  statusBarItem.text = `${icon} VisionDev: ${state}`;
}

function isPanelEvent(value: unknown): value is PanelEvent {
  if (typeof value !== "object" || value === null) return false;
  const maybe = value as { type?: unknown };
  return maybe.type === "status" || maybe.type === "frame" || maybe.type === "log";
}

function startBridge(panel: vscode.WebviewPanel): void {
  if (wsServer) return;

  wsServer = new WebSocketServer({ port: WS_PORT });
  wsServer.on("connection", (socket) => {
    cliSocket = socket;

    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as unknown;
        if (!isPanelEvent(parsed)) return;

        if (parsed.type === "status") {
          if (parsed.state === "running") {
            setRunningStatus();
          } else if (parsed.state === "done" && parsed.result) {
            const r = parsed.result as { status?: "PASS" | "FAIL" };
            setResultStatus(r.status === "PASS" ? "PASS" : "FAIL");
          } else {
            setIdleStatus();
          }
        }

        void panel.webview.postMessage(parsed);
      } catch {
        /* ignore malformed messages */
      }
    });

    socket.on("close", () => {
      if (cliSocket === socket) cliSocket = undefined;
      setIdleStatus();
    });
  });

  wsServer.on("error", () => {
    void vscode.window.showWarningMessage(
      `VisionDev could not bind to port ${WS_PORT}. Close any conflicting process and reload the window.`
    );
  });
}

function getServerJsAbsolutePath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "out", "server.js");
}

function getNodeBinary(): string {
  const fromEnv = process.env.VISIONDEV_NODE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "node";
}

function getMcpConfigPath(): { workspacePath: string; configPath: string } | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const workspacePath = folder.uri.fsPath;
  return {
    workspacePath,
    configPath: path.join(workspacePath, ".cursor", "mcp.json")
  };
}

function getVsCodeMcpConfigPath(workspacePath: string): string {
  return path.join(workspacePath, ".vscode", "mcp.json");
}

interface StdioMcpServerEntry {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<
    string,
    {
      type?: string;
      command: string;
      args?: string[];
      /** @deprecated Cursor expects `type: "stdio"` instead */
      transport?: string;
      env?: Record<string, string>;
    }
  >;
}

/** GitHub Copilot / VS Code uses `.vscode/mcp.json` with top-level `servers`. */
interface VsCodeMcpConfig {
  servers?: Record<string, StdioMcpServerEntry | Record<string, unknown>>;
  inputs?: unknown[];
}

async function connectCliToWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const target = getMcpConfigPath();
  if (!target) {
    void vscode.window.showErrorMessage(
      "Open a folder/workspace first, then run VisionDev: Connect again."
    );
    return;
  }

  const serverJs = getServerJsAbsolutePath(context);
  if (!fs.existsSync(serverJs)) {
    void vscode.window.showErrorMessage(
      `VisionDev: out/server.js not found at ${serverJs}. Run 'npm run compile' first.`
    );
    return;
  }

  const serverEntry: StdioMcpServerEntry = {
    type: "stdio",
    command: getNodeBinary(),
    args: [serverJs],
    env: { VISIONDEV_WS_PORT: String(WS_PORT) }
  };

  const vscodeMcpPath = getVsCodeMcpConfigPath(target.workspacePath);

  let config: McpConfig = {};
  if (fs.existsSync(target.configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(target.configPath, "utf8")) as McpConfig;
    } catch {
      const overwrite = await vscode.window.showWarningMessage(
        "Existing .cursor/mcp.json is not valid JSON. Overwrite it?",
        { modal: true },
        "Overwrite",
        "Cancel"
      );
      if (overwrite !== "Overwrite") return;
      config = {};
    }
  }

  let vscodeConfig: VsCodeMcpConfig = {};
  if (fs.existsSync(vscodeMcpPath)) {
    try {
      vscodeConfig = JSON.parse(fs.readFileSync(vscodeMcpPath, "utf8")) as VsCodeMcpConfig;
    } catch {
      const overwrite = await vscode.window.showWarningMessage(
        "Existing .vscode/mcp.json is not valid JSON. Replace file (VisionDev only; fix JSON by hand first to keep other servers)?",
        { modal: true },
        "Replace",
        "Cancel"
      );
      if (overwrite !== "Replace") return;
      vscodeConfig = {};
    }
  }

  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers.visiondev = serverEntry;

  vscodeConfig.servers = vscodeConfig.servers ?? {};
  vscodeConfig.servers.visiondev = serverEntry;

  fs.mkdirSync(path.dirname(target.configPath), { recursive: true });
  fs.mkdirSync(path.dirname(vscodeMcpPath), { recursive: true });

  fs.writeFileSync(target.configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.writeFileSync(vscodeMcpPath, JSON.stringify(vscodeConfig, null, 2) + "\n", "utf8");

  const action = await vscode.window.showInformationMessage(
    "VisionDev MCP: wrote .cursor/mcp.json (Cursor) and .vscode/mcp.json (VS Code Copilot). Reload the window.",
    "Reload Window",
    "Later"
  );
  if (action === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

const AGENTS_MD_PRIMER = `# Agent guidance

## VisionDev (browser-driven debugging)

When the user describes anything that involves clicking, typing, logging in, navigating, submitting a form, checking a toast/error, or verifying behavior of a web app — use the VisionDev MCP tools instead of asking for selectors.

Standard loop:

1. Call \`vision_open(url, device)\` to launch a real Chromium and get a numbered list of interactive elements.
2. Loop \`vision_observe\` → \`vision_act({ id, action, value? })\` until the goal is reached. Always re-observe after navigation or DOM changes — element IDs are reassigned each call.
3. Use \`vision_wait\` for async UI transitions (urlContains/textVisible). Avoid fixed millisecond waits unless necessary.
4. End with \`vision_assert\` (textVisible / urlContains / errorVisible / toastVisible / elementValue) so the user gets a structured PASS/FAIL.

Rules:

- Never invent CSS selectors — pick element IDs from the latest snapshot.
- If \`vision_act\` returns an error, call \`vision_observe\` and adapt; the IDs may have changed.
- Check the \`evidence\` field after each action — if a toast or error appears, surface it to the user.
- Keep the browser open between turns; only call \`vision_close\` when the user is fully done.
- For pixel-level visual diffs, fall back to \`vision_check\` (legacy).
`;

async function installAgentsMd(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("Open a folder/workspace first.");
    return;
  }
  const target = path.join(folder.uri.fsPath, "AGENTS.md");

  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, "utf8");
    if (existing.includes("VisionDev (browser-driven debugging)")) {
      void vscode.window.showInformationMessage("AGENTS.md already contains VisionDev guidance.");
      return;
    }
    const action = await vscode.window.showWarningMessage(
      "AGENTS.md exists. Append VisionDev guidance to it?",
      { modal: true },
      "Append",
      "Cancel"
    );
    if (action !== "Append") return;
    fs.writeFileSync(target, existing.trimEnd() + "\n\n" + AGENTS_MD_PRIMER, "utf8");
  } else {
    fs.writeFileSync(target, AGENTS_MD_PRIMER, "utf8");
  }

  void vscode.window.showInformationMessage(
    "AGENTS.md updated. Cursor will read this file for agent guidance — try a plain-English bug description."
  );
}

function openOrFocusPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Two);
    return activePanel;
  }
  const panel = vscode.window.createWebviewPanel(
    "visiondev.panel",
    "VisionDev",
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = getPanelHtml(context);
  panel.onDidDispose(() => {
    activePanel = undefined;
  });
  activePanel = panel;
  startBridge(panel);
  return panel;
}

function workspaceHasVisionDevMcp(workspacePath: string): boolean {
  const cursorP = path.join(workspacePath, ".cursor", "mcp.json");
  const vscodeP = getVsCodeMcpConfigPath(workspacePath);
  const has = (p: string): boolean =>
    fs.existsSync(p) && fs.readFileSync(p, "utf8").includes("\"visiondev\"");
  return has(cursorP) || has(vscodeP);
}

async function maybeOfferFirstTimeSetup(context: vscode.ExtensionContext): Promise<void> {
  const target = getMcpConfigPath();
  if (!target) return;
  const alreadyRegistered = workspaceHasVisionDevMcp(target.workspacePath);
  const dismissedKey = "visiondev.firstRunDismissed";
  if (alreadyRegistered || context.globalState.get<boolean>(dismissedKey)) return;

  const action = await vscode.window.showInformationMessage(
    "VisionDev: connect MCP for this workspace? Writes .cursor/mcp.json and .vscode/mcp.json (Copilot).",
    "Connect",
    "Not now",
    "Don't show again"
  );
  if (action === "Connect") {
    await connectCliToWorkspace(context);
  } else if (action === "Don't show again") {
    await context.globalState.update(dismissedKey, true);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.show();
  setIdleStatus();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("visiondev.start", () => {
      openOrFocusPanel(context);
      setIdleStatus();
    }),
    vscode.commands.registerCommand("visiondev.connect", () => connectCliToWorkspace(context)),
    vscode.commands.registerCommand("visiondev.installAgentsMd", () => installAgentsMd())
  );

  void maybeOfferFirstTimeSetup(context);
}

export function deactivate(): void {
  if (cliSocket && cliSocket.readyState === WebSocket.OPEN) cliSocket.close();
  if (wsServer) {
    wsServer.close();
    wsServer = undefined;
  }
}
