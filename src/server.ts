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
        "Launch (or reuse) a headed Chromium browser, navigate to the URL, and return a compact accessibility snapshot of interactive elements with stable IDs you reference in vision_act. Always returns the post-navigation observation.",
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
        "Re-scan the current page and return numbered interactive elements + observed toasts/alerts/errors. Call after any page change. Element IDs are reassigned on every call.",
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
        "Perform an action on an element by its ID from the latest snapshot. Actions: click, fill (requires value), press (requires key), hover, select (requires value), clear. Returns the post-action snapshot.",
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
      description: "Navigate the existing browser to a new URL and return the new snapshot.",
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
        "Wait for a condition (urlContains | textVisible | selectorVisible | ms) then return a fresh snapshot. Use after async UI transitions.",
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
        "Verify a condition: textVisible, urlContains, errorVisible, toastVisible, elementValue (id+equals), elementVisible (id). Returns { pass, message, evidence }.",
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
        "Capture the current viewport as base64 PNG and forward to the panel. Use sparingly; prefer vision_observe for state.",
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
      description: "Close the browser and end the session.",
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
