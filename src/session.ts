import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";

export type ViewportName = "mobile" | "desktop";

export interface VisionElement {
  id: number;
  role: string;
  name: string;
  value?: string;
  href?: string;
  type?: string;
  placeholder?: string;
  checked?: boolean;
  bbox: { x: number; y: number; w: number; h: number };
}

export interface VisionEvidence {
  toasts: string[];
  alerts: string[];
  errors: string[];
}

export interface VisionSnapshot {
  url: string;
  title: string;
  viewport: ViewportName;
  device: ViewportName;
  elements: VisionElement[];
  evidence: VisionEvidence;
}

export type VisionActionKind = "click" | "fill" | "press" | "hover" | "select" | "clear";

export interface VisionActionInput {
  id: number;
  action: VisionActionKind;
  value?: string;
  key?: string;
  timeoutMs?: number;
}

export type VisionWaitInput =
  | { kind: "urlContains"; value: string; timeoutMs?: number }
  | { kind: "textVisible"; value: string; timeoutMs?: number }
  | { kind: "selectorVisible"; value: string; timeoutMs?: number }
  | { kind: "ms"; value: number };

export type VisionAssertInput =
  | { kind: "textVisible"; value: string; timeoutMs?: number; exact?: boolean }
  | { kind: "urlContains"; value: string; timeoutMs?: number }
  | { kind: "errorVisible"; value?: string; timeoutMs?: number; exact?: boolean }
  | { kind: "toastVisible"; value?: string; timeoutMs?: number; exact?: boolean }
  | { kind: "elementValue"; id: number; equals: string }
  | { kind: "elementVisible"; id: number };

export interface VisionAssertResult {
  pass: boolean;
  kind: VisionAssertInput["kind"];
  message?: string;
  evidence: VisionEvidence;
}

export interface VisionFrameEvent {
  type: "frame";
  label: "before" | "after" | "diff" | "live";
  viewport: ViewportName;
  data: string;
}

export interface VisionLogEvent {
  type: "log";
  level: "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}

export interface VisionStatusEvent {
  type: "status";
  state: "running" | "done";
  device?: "mobile" | "desktop" | "both";
  url?: string;
  result?: unknown;
}

export type VisionEvent = VisionFrameEvent | VisionLogEvent | VisionStatusEvent;
export type EventEmitter = (event: VisionEvent) => void;

const VIEWPORTS: Record<ViewportName, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 }
};

const TOAST_SELECTORS = [
  "[role='alert']",
  "[role='status']",
  "[aria-live='assertive']",
  "[aria-live='polite']",
  ".toast",
  "[class*='toast']",
  "[data-testid*='toast']",
  ".sonner-toast",
  ".MuiAlert-message",
  ".chakra-alert",
  ".ant-message-notice-content"
];

const ALERT_SELECTORS = ["[role='alertdialog']", ".alert", "[class*='alert']", "[data-testid*='alert']"];

const ERROR_SELECTORS = [
  ".error",
  ".errors",
  "[class*='error']",
  "[data-testid*='error']",
  "[aria-invalid='true']",
  "[aria-errormessage]",
  ".MuiFormHelperText-root.Mui-error",
  ".ant-form-item-explain-error",
  ".chakra-form__error-message"
];

const ELEMENT_CAP = 250;

interface CapturedElement {
  id: number;
  role: string;
  name: string;
  value?: string;
  href?: string;
  type?: string;
  placeholder?: string;
  checked?: boolean;
  bbox: { x: number; y: number; w: number; h: number };
}

function captureElements(cap: number): CapturedElement[] {
  const g = globalThis as unknown as {
    document: any;
    HTMLElement: any;
    HTMLInputElement: any;
    HTMLTextAreaElement: any;
    HTMLSelectElement: any;
    getComputedStyle: (el: any) => any;
  };
  const doc = g.document;
  const all = doc.querySelectorAll(
    [
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "[role='button']",
      "[role='link']",
      "[role='textbox']",
      "[role='combobox']",
      "[role='menuitem']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='tab']",
      "[role='switch']",
      "[contenteditable='']",
      "[contenteditable='true']",
      "[onclick]",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",")
  );
  doc.querySelectorAll("[data-vd-id]").forEach((node: any) => node.removeAttribute("data-vd-id"));

  const out: CapturedElement[] = [];
  let counter = 0;
  for (let i = 0; i < all.length && out.length < cap; i += 1) {
    const el = all[i] as any;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width < 2 || rect.height < 2) continue;
    const style = g.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      continue;
    }
    const tag = (el.tagName || "").toLowerCase();
    const aria = (el.getAttribute && el.getAttribute("role")) || "";
    let role = aria || "";
    if (!role) {
      if (tag === "a" && el.getAttribute && el.getAttribute("href")) role = "link";
      else if (tag === "button") role = "button";
      else if (tag === "select") role = "combobox";
      else if (tag === "textarea") role = "textbox";
      else if (tag === "input") {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "checkbox") role = "checkbox";
        else if (t === "radio") role = "radio";
        else if (t === "submit" || t === "button") role = "button";
        else role = "textbox";
      } else {
        role = tag || "element";
      }
    }
    const ariaLabel = (el.getAttribute && el.getAttribute("aria-label")) || "";
    const ariaLabelledBy = (el.getAttribute && el.getAttribute("aria-labelledby")) || "";
    let labelText = "";
    if (ariaLabelledBy) {
      const ids = ariaLabelledBy.split(/\s+/);
      const parts: string[] = [];
      for (const id of ids) {
        const node = doc.getElementById(id);
        if (node && node.textContent) parts.push(String(node.textContent).trim());
      }
      labelText = parts.join(" ");
    }
    if (!labelText && el.id) {
      const labelEl = doc.querySelector(`label[for='${el.id}']`);
      if (labelEl && labelEl.textContent) labelText = String(labelEl.textContent).trim();
    }
    const placeholder = (el.getAttribute && el.getAttribute("placeholder")) || "";
    const title = (el.getAttribute && el.getAttribute("title")) || "";
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    const name =
      (ariaLabel && ariaLabel.trim()) ||
      labelText ||
      (text && text.length <= 80 ? text : "") ||
      placeholder ||
      title ||
      "";

    let value: string | undefined;
    if (tag === "input" || tag === "textarea") {
      value = (el.value as string) || "";
    } else if (tag === "select") {
      value = (el.value as string) || "";
    }
    const inputType =
      tag === "input" ? ((el.getAttribute && el.getAttribute("type")) || "text").toLowerCase() : undefined;

    counter += 1;
    el.setAttribute("data-vd-id", String(counter));

    out.push({
      id: counter,
      role,
      name: name.slice(0, 120),
      value: typeof value === "string" ? value : undefined,
      href: tag === "a" ? (el.getAttribute && el.getAttribute("href")) || undefined : undefined,
      type: inputType,
      placeholder: placeholder || undefined,
      checked: tag === "input" && (inputType === "checkbox" || inputType === "radio") ? Boolean(el.checked) : undefined,
      bbox: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
    });
  }
  return out;
}

function injectMarker(payload: { id: number; color: string; label: string }): void {
  const g = globalThis as unknown as {
    document: any;
    setTimeout: (fn: () => void, ms: number) => number;
    __vdLast?: { x: number; y: number };
  };
  const el = g.document.querySelector(`[data-vd-id='${payload.id}']`) as any;
  if (!el) return;
  const prevOutline = el.style.outline;
  el.style.outline = `2px solid ${payload.color}`;
  const rect = el.getBoundingClientRect();
  const cx = Math.round(rect.left + rect.width / 2);
  const cy = Math.round(rect.top + rect.height / 2);

  if (g.__vdLast) {
    const dx = cx - g.__vdLast.x;
    const dy = cy - g.__vdLast.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 8) {
      const trail = g.document.createElement("div");
      trail.style.position = "fixed";
      trail.style.left = `${g.__vdLast.x}px`;
      trail.style.top = `${g.__vdLast.y}px`;
      trail.style.width = `${Math.round(dist)}px`;
      trail.style.height = "2px";
      trail.style.background = payload.color;
      trail.style.opacity = "0.6";
      trail.style.transformOrigin = "0 50%";
      trail.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      trail.style.pointerEvents = "none";
      trail.style.zIndex = "2147483646";
      g.document.body.appendChild(trail);
      g.setTimeout(() => trail.remove(), 350);
    }
  }
  g.__vdLast = { x: cx, y: cy };

  const dot = g.document.createElement("div");
  dot.style.position = "fixed";
  dot.style.left = `${cx - 7}px`;
  dot.style.top = `${cy - 7}px`;
  dot.style.width = "14px";
  dot.style.height = "14px";
  dot.style.borderRadius = "999px";
  dot.style.background = payload.color;
  dot.style.boxShadow = `0 0 0 8px ${payload.color}1f, 0 0 12px rgba(0,0,0,0.25)`;
  dot.style.pointerEvents = "none";
  dot.style.zIndex = "2147483647";
  g.document.body.appendChild(dot);

  const chip = g.document.createElement("div");
  chip.textContent = payload.label;
  chip.style.position = "fixed";
  chip.style.left = `${cx + 12}px`;
  chip.style.top = `${cy - 10}px`;
  chip.style.padding = "2px 8px";
  chip.style.borderRadius = "999px";
  chip.style.fontSize = "10px";
  chip.style.fontWeight = "700";
  chip.style.fontFamily = "ui-sans-serif,-apple-system,sans-serif";
  chip.style.letterSpacing = "0.06em";
  chip.style.color = "#fff";
  chip.style.background = payload.color;
  chip.style.boxShadow = "0 2px 10px rgba(0,0,0,0.25)";
  chip.style.pointerEvents = "none";
  chip.style.zIndex = "2147483647";
  g.document.body.appendChild(chip);

  g.setTimeout(() => {
    dot.remove();
    chip.remove();
    el.style.outline = prevOutline;
  }, 380);
}

export class VisionSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private currentDevice: ViewportName = "desktop";
  private emit: EventEmitter | undefined;
  private cdp?: CDPSession;
  private screencastActive = false;

  constructor(emit?: EventEmitter) {
    this.emit = emit;
  }

  isOpen(): boolean {
    return !!this.page && !this.page.isClosed();
  }

  setEmitter(emit: EventEmitter | undefined): void {
    this.emit = emit;
  }

  private async startScreencast(): Promise<void> {
    if (this.screencastActive || !this.page || !this.context) return;
    try {
      this.cdp = await this.context.newCDPSession(this.page);
      this.cdp.on("Page.screencastFrame", async (event: { data: string; sessionId: number }) => {
        try {
          this.emit?.({
            type: "frame",
            label: "live",
            viewport: this.currentDevice,
            data: event.data
          });
        } finally {
          try {
            await this.cdp?.send("Page.screencastFrameAck", { sessionId: event.sessionId });
          } catch {
            /* ignore */
          }
        }
      });
      await this.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 2
      });
      this.screencastActive = true;
    } catch {
      /* CDP screencast is best-effort; ignore failures */
    }
  }

  private async stopScreencast(): Promise<void> {
    if (!this.cdp) return;
    try {
      await this.cdp.send("Page.stopScreencast");
    } catch {
      /* ignore */
    }
    try {
      await this.cdp.detach();
    } catch {
      /* ignore */
    }
    this.cdp = undefined;
    this.screencastActive = false;
  }

  private log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
    this.emit?.({ type: "log", level, message, meta });
  }

  async open(url: string, device: ViewportName = "desktop"): Promise<VisionSnapshot> {
    if (this.browser && !this.browser.isConnected()) {
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
    }
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: false });
      this.browser.on("disconnected", () => {
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
      });
    }
    if (this.context && this.currentDevice !== device) {
      await this.stopScreencast();
      await this.context.close().catch(() => undefined);
      this.context = undefined;
      this.page = undefined;
    }
    if (!this.context) {
      this.context = await this.browser.newContext({ viewport: VIEWPORTS[device] });
      this.currentDevice = device;
      this.page = await this.context.newPage();
    }
    if (!this.screencastActive) {
      await this.startScreencast();
    }
    const page = this.page!;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Navigation failed";
      this.log("error", `open failed: ${msg}`, { url });
      throw new Error(`Navigation to ${url} failed: ${msg}`);
    }
    await this.settle();
    return this.observe();
  }

  async navigate(url: string): Promise<VisionSnapshot> {
    const page = this.requirePage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    await this.settle();
    return this.observe();
  }

  async observe(): Promise<VisionSnapshot> {
    const page = this.requirePage();
    const elements = (await page.evaluate(captureElements, ELEMENT_CAP)) as VisionElement[];
    const evidence = await this.collectEvidence();
    const snapshot: VisionSnapshot = {
      url: page.url(),
      title: await page.title().catch(() => ""),
      viewport: this.currentDevice,
      device: this.currentDevice,
      elements,
      evidence
    };
    await this.streamFrame("live");
    return snapshot;
  }

  async act(input: VisionActionInput): Promise<VisionSnapshot> {
    const page = this.requirePage();
    const selector = `[data-vd-id='${input.id}']`;
    const exists = (await page.locator(selector).count()) > 0;
    if (!exists) {
      throw new Error(
        `Element id ${input.id} not found. Call vision_observe again — IDs are invalidated after navigation/DOM changes.`
      );
    }
    const timeout = input.timeoutMs ?? 4000;
    const color =
      input.action === "click"
        ? "#22c55e"
        : input.action === "fill"
          ? "#38bdf8"
          : input.action === "press"
            ? "#f59e0b"
            : input.action === "hover"
              ? "#a78bfa"
              : "#eab308";
    await page
      .evaluate(injectMarker, { id: input.id, color, label: input.action.toUpperCase() })
      .catch(() => undefined);

    const locator = page.locator(selector).first();

    try {
      if (input.action === "click") {
        await locator.click({ timeout });
      } else if (input.action === "fill") {
        if (input.value === undefined) throw new Error("fill requires a value");
        await locator.fill(input.value, { timeout });
      } else if (input.action === "press") {
        if (!input.key) throw new Error("press requires a key");
        await locator.press(input.key, { timeout });
      } else if (input.action === "hover") {
        await locator.hover({ timeout });
      } else if (input.action === "select") {
        if (input.value === undefined) throw new Error("select requires a value");
        await locator.selectOption(input.value, { timeout });
      } else if (input.action === "clear") {
        await locator.fill("", { timeout });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      this.log("error", `act failed: ${msg}`, { id: input.id, action: input.action });
      const snapshot = await this.observe().catch(() => undefined);
      const enriched = new Error(msg) as Error & { snapshot?: VisionSnapshot };
      enriched.snapshot = snapshot;
      throw enriched;
    }

    await this.settle();
    return this.observe();
  }

  async wait(input: VisionWaitInput): Promise<VisionSnapshot> {
    const page = this.requirePage();
    const timeout = "timeoutMs" in input && input.timeoutMs ? input.timeoutMs : 5000;
    if (input.kind === "urlContains") {
      await page.waitForURL((u) => u.toString().includes(input.value), { timeout });
    } else if (input.kind === "textVisible") {
      await page.getByText(input.value).first().waitFor({ state: "visible", timeout });
    } else if (input.kind === "selectorVisible") {
      await page.locator(input.value).first().waitFor({ state: "visible", timeout });
    } else if (input.kind === "ms") {
      await page.waitForTimeout(input.value);
    }
    return this.observe();
  }

  async assert(input: VisionAssertInput): Promise<VisionAssertResult> {
    const page = this.requirePage();
    const evidence = await this.collectEvidence();
    try {
      if (input.kind === "textVisible") {
        const t = page.getByText(input.value, { exact: input.exact ?? false }).first();
        await t.waitFor({ state: "visible", timeout: input.timeoutMs ?? 5000 });
      } else if (input.kind === "urlContains") {
        await page.waitForURL((u) => u.toString().includes(input.value), {
          timeout: input.timeoutMs ?? 5000
        });
      } else if (input.kind === "errorVisible") {
        await this.waitForEvidence(
          (ev) => [...ev.errors, ...ev.toasts, ...ev.alerts],
          input.value,
          input.exact,
          input.timeoutMs ?? 5000
        );
      } else if (input.kind === "toastVisible") {
        await this.waitForEvidence(
          (ev) => [...ev.toasts, ...ev.alerts],
          input.value,
          input.exact,
          input.timeoutMs ?? 5000
        );
      } else if (input.kind === "elementValue") {
        const selector = `[data-vd-id='${input.id}']`;
        const value = await page.locator(selector).first().inputValue().catch(() => "");
        if (value !== input.equals) {
          return {
            pass: false,
            kind: input.kind,
            message: `Expected value '${input.equals}', got '${value}'`,
            evidence
          };
        }
      } else if (input.kind === "elementVisible") {
        const selector = `[data-vd-id='${input.id}']`;
        await page.locator(selector).first().waitFor({ state: "visible", timeout: 3000 });
      }
      return { pass: true, kind: input.kind, evidence };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Assertion failed";
      const fresh = await this.collectEvidence();
      return { pass: false, kind: input.kind, message, evidence: fresh };
    }
  }

  async screenshot(): Promise<string> {
    const page = this.requirePage();
    const buf = (await page.screenshot({ fullPage: false })) as Buffer;
    return buf.toString("base64");
  }

  async streamFrame(label: VisionFrameEvent["label"]): Promise<void> {
    if (!this.emit) return;
    if (!this.isOpen()) return;
    try {
      const data = await this.screenshot();
      this.emit({ type: "frame", label, viewport: this.currentDevice, data });
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    await this.stopScreencast();
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
  }

  getDevice(): ViewportName {
    return this.currentDevice;
  }

  getPage(): Page | undefined {
    return this.page;
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error("VisionDev session is not open. Call vision_open first.");
    }
    return this.page;
  }

  private async settle(): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: 1500 });
    } catch {
      /* ignore */
    }
  }

  private async collectEvidence(): Promise<VisionEvidence> {
    if (!this.page) return { toasts: [], alerts: [], errors: [] };
    const page = this.page;
    const probe = async (selectors: string[]): Promise<string[]> => {
      const out: string[] = [];
      for (const sel of selectors) {
        try {
          const nodes = await page.locator(sel).all();
          for (const node of nodes) {
            const visible = await node.isVisible().catch(() => false);
            if (!visible) continue;
            const text = (await node.innerText().catch(() => "")).trim().replace(/\s+/g, " ");
            if (text) out.push(text);
          }
        } catch {
          /* ignore */
        }
      }
      return Array.from(new Set(out)).slice(0, 15);
    };
    return {
      toasts: await probe(TOAST_SELECTORS),
      alerts: await probe(ALERT_SELECTORS),
      errors: await probe(ERROR_SELECTORS)
    };
  }

  private async waitForEvidence(
    pick: (ev: VisionEvidence) => string[],
    expected: string | undefined,
    exact: boolean | undefined,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ev = await this.collectEvidence();
      const pool = pick(ev);
      let match = false;
      if (!expected) {
        match = pool.length > 0;
      } else {
        const needle = expected.toLowerCase();
        match = pool.some((entry) =>
          exact ? entry === expected : entry.toLowerCase().includes(needle)
        );
      }
      if (match) return;
      await this.page!.waitForTimeout(200);
    }
    throw new Error("Evidence not found in time");
  }
}

let activeSession: VisionSession | undefined;

export function getActiveSession(emit?: EventEmitter): VisionSession {
  if (!activeSession) {
    activeSession = new VisionSession(emit);
  } else if (emit) {
    activeSession.setEmitter(emit);
  }
  return activeSession;
}

export async function disposeActiveSession(): Promise<void> {
  if (activeSession) {
    await activeSession.close();
    activeSession = undefined;
  }
}
