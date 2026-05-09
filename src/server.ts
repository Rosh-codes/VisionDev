import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { runVisionCheck, type VisionCheckInput } from "./bridge";
import {
  disposeActiveSession,
  getActiveSession,
  type EventEmitter,
  type VisionEvent
} from "./session";

const WS_PORT = Number(process.env.VISIONDEV_WS_PORT ?? "51051");

function sendWsEvent(event: VisionEvent): void {
  const socket = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  socket.on("open", () => {
    socket.send(JSON.stringify(event));
    socket.close();
  });
  socket.on("error", () => {
    /* extension may be closed; ignore */
  });
}

const emit: EventEmitter = (event) => sendWsEvent(event);

function compactSnapshot(snap: { elements: { id: number; role: string; name: string; value?: string; type?: string; placeholder?: string; checked?: boolean }[]; url: string; title: string; viewport: string; evidence: { toasts: string[]; alerts: string[]; errors: string[] } }): {
  url: string;
  title: string;
  viewport: string;
  elements: string[];
  evidence: { toasts: string[]; alerts: string[]; errors: string[] };
} {
  return {
    url: snap.url,
    title: snap.title,
    viewport: snap.viewport,
    elements: snap.elements.map((el) => {
      const parts: string[] = [`[${el.id}]`, el.role];
      if (el.name) parts.push(`"${el.name}"`);
      if (el.value) parts.push(`value="${el.value}"`);
      else if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.type) parts.push(`type=${el.type}`);
      if (el.checked === true) parts.push("checked");
      return parts.join(" ");
    }),
    evidence: snap.evidence
  };
}

function asTextResult(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

async function main(): Promise<void> {
  const server = new McpServer({
    name: "visiondev",
    version: "0.2.0"
  });

  server.registerTool(
    "vision_open",
    {
      title: "VisionDev Open",
      description:
        "Open a real, visible Chromium browser at the given URL and return a numbered list of every interactive element on the page (each with a stable ID, role, and accessible name). USE THIS WHENEVER the user asks you to verify, test, debug, reproduce, or check behavior of a web app — for example: 'log in and check ...', 'this button doesn't work', 'try clicking ...', 'fill the form with ...', 'go to /profile and ...'. Always call vision_open FIRST, then loop vision_observe → vision_act → vision_observe → vision_assert. Do NOT ask the user for CSS selectors; you choose elements by ID from the snapshot. The browser stays open across calls so subsequent actions are instant.",
      inputSchema: {
        url: z.string().url(),
        device: z.enum(["mobile", "desktop"]).default("desktop")
      }
    },
    async ({ url, device }) => {
      const session = getActiveSession(emit);
      const snapshot = await session.open(url, device);
      return asTextResult(compactSnapshot(snapshot));
    }
  );

  server.registerTool(
    "vision_observe",
    {
      title: "VisionDev Observe",
      description:
        "Re-scan the currently open page and return its numbered interactive elements PLUS any visible toasts, alerts, and error messages. Call this whenever the page may have changed (after a click, navigation, form submit, async load). Element IDs are reassigned each call — always observe before acting if you're unsure. The 'evidence' field tells you if a toast or error appeared (use this to diagnose failures).",
      inputSchema: {}
    },
    async () => {
      const session = getActiveSession(emit);
      const snapshot = await session.observe();
      return asTextResult(compactSnapshot(snapshot));
    }
  );

  server.registerTool(
    "vision_act",
    {
      title: "VisionDev Act",
      description:
        "Perform a single user action on an element BY ITS NUMERIC ID from the latest vision_open or vision_observe snapshot. Actions: 'click' (no value), 'fill' (value=text to type), 'press' (key=key name like Enter/Tab), 'hover', 'select' (value=option), 'clear'. Returns a fresh snapshot of the resulting page state. If the element vanishes or a route change happens, IDs invalidate — call vision_observe again. NEVER guess CSS selectors; only use IDs from observe output.",
      inputSchema: {
        id: z.number().int().positive(),
        action: z.enum(["click", "fill", "press", "hover", "select", "clear"]),
        value: z.string().optional(),
        key: z.string().optional(),
        timeoutMs: z.number().int().positive().max(30000).optional()
      }
    },
    async ({ id, action, value, key, timeoutMs }) => {
      const session = getActiveSession(emit);
      try {
        const snapshot = await session.act({ id, action, value, key, timeoutMs });
        return asTextResult(compactSnapshot(snapshot));
      } catch (err) {
        const errObj = err as Error & { snapshot?: ReturnType<typeof compactSnapshot> };
        return asTextResult({
          error: errObj.message,
          snapshot: errObj.snapshot ? compactSnapshot(errObj.snapshot as unknown as Parameters<typeof compactSnapshot>[0]) : undefined,
          hint: "Re-call vision_observe to get fresh element IDs and adapt."
        });
      }
    }
  );

  server.registerTool(
    "vision_navigate",
    {
      title: "VisionDev Navigate",
      description:
        "Navigate the EXISTING browser session to a new URL (no relaunch) and return a fresh snapshot. Use for SPA route changes or jumping to a different page in the same flow.",
      inputSchema: { url: z.string().url() }
    },
    async ({ url }) => {
      const session = getActiveSession(emit);
      const snapshot = await session.navigate(url);
      return asTextResult(compactSnapshot(snapshot));
    }
  );

  server.registerTool(
    "vision_wait",
    {
      title: "VisionDev Wait",
      description:
        "Wait until a condition becomes true, then return a fresh snapshot. Use AFTER actions that trigger async work (login redirect, route change, modal open). Kinds: 'urlContains' (value=substring of URL), 'textVisible' (value=text shown on page), 'selectorVisible' (value=CSS), 'ms' (value=milliseconds). Prefer urlContains/textVisible over fixed ms waits.",
      inputSchema: {
        kind: z.enum(["urlContains", "textVisible", "selectorVisible", "ms"]),
        value: z.union([z.string(), z.number()]),
        timeoutMs: z.number().int().positive().max(30000).optional()
      }
    },
    async ({ kind, value, timeoutMs }) => {
      const session = getActiveSession(emit);
      let snapshot;
      if (kind === "ms") {
        snapshot = await session.wait({ kind: "ms", value: Number(value) });
      } else {
        snapshot = await session.wait({ kind, value: String(value), timeoutMs });
      }
      return asTextResult(compactSnapshot(snapshot));
    }
  );

  server.registerTool(
    "vision_assert",
    {
      title: "VisionDev Assert",
      description:
        "Verify the FINAL state of the flow and return { pass, message, evidence }. ALWAYS end a debugging session with at least one assert so you have a structured PASS/FAIL to report to the user. Kinds: 'textVisible' (specific text on page), 'urlContains' (URL substring), 'errorVisible' (any visible error/toast/alert; optionally match text), 'toastVisible' (snackbar/alert with text), 'elementValue' (input id keeps a specific value), 'elementVisible' (element id is on screen).",
      inputSchema: {
        kind: z.enum([
          "textVisible",
          "urlContains",
          "errorVisible",
          "toastVisible",
          "elementValue",
          "elementVisible"
        ]),
        value: z.string().optional(),
        id: z.number().int().positive().optional(),
        equals: z.string().optional(),
        exact: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(30000).optional()
      }
    },
    async ({ kind, value, id, equals, exact, timeoutMs }) => {
      const session = getActiveSession(emit);
      let result;
      if (kind === "elementValue") {
        if (id === undefined || equals === undefined) {
          return asTextResult({ pass: false, message: "elementValue requires id and equals" });
        }
        result = await session.assert({ kind: "elementValue", id, equals });
      } else if (kind === "elementVisible") {
        if (id === undefined) {
          return asTextResult({ pass: false, message: "elementVisible requires id" });
        }
        result = await session.assert({ kind: "elementVisible", id });
      } else if (kind === "textVisible") {
        result = await session.assert({ kind: "textVisible", value: value ?? "", exact, timeoutMs });
      } else if (kind === "urlContains") {
        result = await session.assert({ kind: "urlContains", value: value ?? "", timeoutMs });
      } else if (kind === "errorVisible") {
        result = await session.assert({ kind: "errorVisible", value, exact, timeoutMs });
      } else {
        result = await session.assert({ kind: "toastVisible", value, exact, timeoutMs });
      }
      return asTextResult(result);
    }
  );

  server.registerTool(
    "vision_screenshot",
    {
      title: "VisionDev Screenshot",
      description:
        "Push the current viewport as a high-quality PNG to the VisionDev panel. The image bytes are NOT returned to you (to save tokens) — call this only when the user explicitly asks for a snapshot or you want to mark a moment in the panel. Prefer vision_observe for understanding page state.",
      inputSchema: {}
    },
    async () => {
      const session = getActiveSession(emit);
      const data = await session.screenshot();
      await session.streamFrame("after");
      return asTextResult({
        viewport: session.getDevice(),
        bytes: data.length,
        note: "Frame streamed to panel; base64 omitted from text response to save tokens."
      });
    }
  );

  server.registerTool(
    "vision_close",
    {
      title: "VisionDev Close",
      description:
        "Close the browser session. Only call this when the user is fully done debugging — keeping the session open between turns is faster and what users expect (the browser stays put while they iterate).",
      inputSchema: {}
    },
    async () => {
      await disposeActiveSession();
      return asTextResult({ closed: true });
    }
  );

  server.registerTool(
    "vision_check",
    {
      title: "VisionDev Check (legacy)",
      description:
        "Compatibility wrapper: runs an explicit script (steps + assertions) against a URL using the persistent session. PREFER the granular tools (vision_open / vision_observe / vision_act / vision_assert) for reliable agent control.",
      inputSchema: {
        url: z.string().url(),
        device: z.enum(["mobile", "desktop", "both"]),
        description: z.string().optional(),
        task: z
          .object({
            problem: z.string().min(3),
            context: z.record(z.string(), z.string()).optional()
          })
          .optional(),
        script: z
          .object({
            mode: z.enum(["behavior", "visual", "both"]).optional(),
            steps: z
              .array(
                z.object({
                  action: z.enum(["fill", "click", "press", "navigate", "waitFor", "waitForUrl"]),
                  selector: z.string().optional(),
                  value: z.string().optional(),
                  key: z.string().optional(),
                  url: z.string().url().optional(),
                  ms: z.number().int().positive().optional(),
                  urlContains: z.string().optional(),
                  timeoutMs: z.number().int().positive().optional(),
                  fallbackSelectors: z.array(z.string()).optional()
                })
              )
              .optional(),
            assertions: z
              .array(
                z.object({
                  type: z.enum(["textVisible", "selectorVisible", "toastVisible", "errorVisible", "urlContains"]),
                  text: z.string().optional(),
                  value: z.string().optional(),
                  selector: z.string().optional(),
                  timeoutMs: z.number().int().positive().optional(),
                  exact: z.boolean().optional()
                })
              )
              .optional(),
            holdOpenMs: z.number().int().min(0).max(60000).optional(),
            showActionMarkers: z.boolean().optional()
          })
          .optional()
      }
    },
    async (args: VisionCheckInput) => {
      const result = await runVisionCheck(args, emit);
      return asTextResult(result);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
