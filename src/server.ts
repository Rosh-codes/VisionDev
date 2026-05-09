import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { runVisionCheck, type VisionFrameEvent, type VisionStatusEvent, type VisionCheckInput } from "./bridge";

const WS_PORT = Number(process.env.VISIONDEV_WS_PORT ?? "51051");

function sendWsEvent(event: VisionFrameEvent | VisionStatusEvent): void {
  const socket = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  socket.on("open", () => {
    socket.send(JSON.stringify(event));
    socket.close();
  });
  socket.on("error", () => {
    // Extension may be closed; ignore transport errors.
  });
}

async function main(): Promise<void> {
  const server = new McpServer({
    name: "visiondev",
    version: "0.0.1"
  });

  server.registerTool(
    "vision_check",
    {
      title: "VisionDev Check",
      description: "Run a live visual check using headed Playwright and return compact JSON.",
      inputSchema: {
        url: z.string().url(),
        device: z.enum(["mobile", "desktop", "both"]),
        description: z.string().optional()
      }
    },
    async (args: VisionCheckInput) => {
      const result = await runVisionCheck(args, sendWsEvent);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
