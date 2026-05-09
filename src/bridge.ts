import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export type DeviceOption = "mobile" | "desktop" | "both";
export type ViewportName = "mobile" | "desktop";

export interface VisionCheckInput {
  url: string;
  device: DeviceOption;
  description?: string;
}

export interface VisionCheckItem {
  viewport: ViewportName;
  diffPixels: number;
  diffPercent: number;
}

export interface VisionCheckResult {
  status: "PASS" | "FAIL";
  checks: VisionCheckItem[];
  url: string;
  timestamp: string;
}

export interface VisionFrameEvent {
  type: "frame";
  label: "before" | "after" | "diff";
  viewport: ViewportName;
  data: string;
}

export interface VisionStatusEvent {
  type: "status";
  state: "running" | "done";
  device?: DeviceOption;
  url?: string;
  result?: VisionCheckResult;
}

type EventCallback = (event: VisionFrameEvent | VisionStatusEvent) => void;

const VIEWPORTS: Record<ViewportName, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 }
};

const PASS_DIFF_PERCENT_THRESHOLD = 0.1;

function getViewportList(device: DeviceOption): ViewportName[] {
  if (device === "both") {
    return ["desktop", "mobile"];
  }
  return [device];
}

function asBase64(buf: Buffer): string {
  return buf.toString("base64");
}

function parsePng(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

export async function runVisionCheck(
  input: VisionCheckInput,
  emit?: EventCallback
): Promise<VisionCheckResult> {
  const viewportList = getViewportList(input.device);
  const checks: VisionCheckItem[] = [];

  emit?.({
    type: "status",
    state: "running",
    device: input.device,
    url: input.url
  });

  for (const viewport of viewportList) {
    const browser = await chromium.launch({ headless: false });
    try {
      const context = await browser.newContext({ viewport: VIEWPORTS[viewport] });
      const page = await context.newPage();

      try {
        await page.goto(input.url, { waitUntil: "networkidle", timeout: 5000 });
      } catch {
        await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 5000 });
      }

      const beforeBuf = await page.screenshot({ fullPage: true });
      emit?.({
        type: "frame",
        label: "before",
        viewport,
        data: asBase64(beforeBuf)
      });

      await page.waitForTimeout(1200);

      const afterBuf = await page.screenshot({ fullPage: true });
      emit?.({
        type: "frame",
        label: "after",
        viewport,
        data: asBase64(afterBuf)
      });

      const beforePng = parsePng(beforeBuf);
      const afterPng = parsePng(afterBuf);
      const width = Math.min(beforePng.width, afterPng.width);
      const height = Math.min(beforePng.height, afterPng.height);
      const diffPng = new PNG({ width, height });

      const diffPixels = pixelmatch(
        beforePng.data,
        afterPng.data,
        diffPng.data,
        width,
        height,
        { threshold: 0.1 }
      );

      const totalPixels = width * height || 1;
      const diffPercent = Number(((diffPixels / totalPixels) * 100).toFixed(4));
      const diffBuf = PNG.sync.write(diffPng);

      emit?.({
        type: "frame",
        label: "diff",
        viewport,
        data: asBase64(diffBuf)
      });

      checks.push({
        viewport,
        diffPixels,
        diffPercent
      });

      await context.close();
    } finally {
      await browser.close();
    }
  }

  const allPassed = checks.every((item) => item.diffPercent <= PASS_DIFF_PERCENT_THRESHOLD);
  const result: VisionCheckResult = {
    status: allPassed ? "PASS" : "FAIL",
    checks,
    url: input.url,
    timestamp: new Date().toISOString()
  };

  emit?.({
    type: "status",
    state: "done",
    result
  });

  return result;
}
