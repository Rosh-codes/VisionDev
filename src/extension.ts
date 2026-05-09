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

function getPanelHtml(context: vscode.ExtensionContext): string {
  const htmlPath = path.join(context.extensionPath, "src", "panel.html");
  return fs.readFileSync(htmlPath, "utf8");
}

function setIdleStatus(): void {
  if (!statusBarItem) {
    return;
  }
  statusBarItem.text = "$(eye) VisionDev: Ready when idle";
}

function setRunningStatus(): void {
  if (!statusBarItem) {
    return;
  }
  statusBarItem.text = "$(sync~spin) VisionDev: Checking…";
}

function setResultStatus(state: "PASS" | "FAIL"): void {
  if (!statusBarItem) {
    return;
  }
  const icon = state === "PASS" ? "$(pass-filled)" : "$(error)";
  statusBarItem.text = `${icon} VisionDev: ${state}`;
}

function isPanelEvent(value: unknown): value is PanelEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybe = value as { type?: unknown };
  return maybe.type === "status" || maybe.type === "frame" || maybe.type === "log";
}

function startBridge(panel: vscode.WebviewPanel): void {
  if (wsServer) {
    return;
  }

  wsServer = new WebSocketServer({ port: WS_PORT });
  wsServer.on("connection", (socket) => {
    cliSocket = socket;

    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as unknown;
        if (!isPanelEvent(parsed)) {
          return;
        }

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
        // Ignore malformed messages.
      }
    });

    socket.on("close", () => {
      if (cliSocket === socket) {
        cliSocket = undefined;
      }
      setIdleStatus();
    });
  });

  wsServer.on("error", () => {
    void vscode.window.showWarningMessage(
      `VisionDev could not bind to port ${WS_PORT}. Close conflicting process and restart VisionDev.`
    );
  });
}

export function activate(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.show();
  setIdleStatus();
  context.subscriptions.push(statusBarItem);

  const disposable = vscode.commands.registerCommand("visiondev.start", () => {
    const panel = vscode.window.createWebviewPanel(
      "visiondev.panel",
      "VisionDev",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = getPanelHtml(context);
    startBridge(panel);
    setIdleStatus();
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  if (cliSocket && cliSocket.readyState === WebSocket.OPEN) {
    cliSocket.close();
  }
  if (wsServer) {
    wsServer.close();
    wsServer = undefined;
  }
}
